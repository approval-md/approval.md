/**
 * The holder of `<log>.lock`, and the one way a lock left by a writer that died
 * holding it is taken back (APRV-479).
 *
 * ## The defect this exists for
 *
 * `core/log.ts` serializes every append with a lockfile created `wx` and never
 * stolen, because silently breaking somebody else's lock is how two writers
 * come to share a `seq`. A writer that dies while it holds the lock never
 * removes it: a harness hook killed by SIGTERM with no listener registered (the
 * default disposition), any verb killed by SIGKILL, a Hermes gateway restart in
 * the middle of an append. Every later writer, the daemon included, then waits
 * its two seconds and refuses `lock-timeout`, and the tenant's gate stays
 * wedged until a human removes the file.
 *
 * ## What this module does about it
 *
 * 1. **The lockfile names its holder.** {@link createLockFile} writes one JSON
 *    line into the file it creates: the pid, the host, the boot, on Linux the
 *    pid namespace and the process start time, when the lock was taken, which
 *    kind of holder it is, and a nonce. An older writer's empty lockfile has no
 *    such record.
 * 2. **A lock is reclaimed only from a holder that is provably gone.**
 *    {@link judgeHolder} decides from the record and the platform. On Linux the
 *    proof is exact: the same boot and the same pid namespace as the reader,
 *    and `/proc/<pid>/stat` either absent, a zombie, or naming a process whose
 *    start time is not the holder's. Elsewhere (macOS, the BSDs, Windows) there
 *    is no ps-free way to read another process's start time, so the proof is
 *    weaker and the answer leans the safe way: the same host, and `kill(pid, 0)`
 *    reporting no such process, or the host's boot time having moved. A pid
 *    that exists there is treated as the holder, however old the lock. Anything
 *    that cannot be verified (another host, another container's pid namespace,
 *    a record from a newer format) is LIVE. A live holder is never reclaimed.
 * 3. **An unattributed lockfile ages out.** A lockfile with no holder record
 *    (written by an older version, or by a writer killed between the create and
 *    the write) is reclaimed only once it is {@link LEGACY_LOCK_RECLAIM_AGE_MS}
 *    old. An append holds the lock for milliseconds and the longest holder in
 *    this runtime (`approval log sync`) for seconds.
 * 4. **Reclaim is atomic.** {@link tryReclaimLock}: link the lockfile to a name
 *    keyed by its inode with `link(2)`, which fails if that name exists, so of
 *    any number of writers that judged the same stale lock exactly one goes on;
 *    check that the linked file is still the one judged (inode, bytes, mtime);
 *    rename the lockfile aside, check again, and only then remove it. The
 *    winner then takes the lock with the same `wx` create every writer uses, so
 *    a writer that wins that create first is ordinary contention.
 * 5. **The reclaim is in the log.** `core/log.ts` appends an
 *    `audit.lock_reclaimed` record as the first write under the lock it took
 *    after a reclaim, from a fresh read of the tail: the reclaimer's own
 *    compare-and-append (SPEC.md §11.1 invariant 5) then sees a moved head and
 *    re-reads, as it would after any other writer's record.
 * 6. **SIGTERM does not leave a lock behind.** {@link guardTerminationWhileLocked}
 *    registers a listener for SIGTERM, SIGINT and SIGHUP while this process
 *    holds a lock, for each signal nobody else listens for. A lock is only ever
 *    held inside synchronous code, so a signal that arrives then waits for the
 *    event loop, by which time the lock is released; the listener then puts the
 *    default disposition back and raises the signal again, and the process dies
 *    of it as it would have, without the lockfile. SIGKILL cannot be caught,
 *    which is what 1 to 5 are for.
 *
 * ## What it refuses to reclaim
 *
 * - A lock beside a `log sync` snapshot (`<log>.sync-snapshot`). A sync killed
 *   part way can leave the working log set to its committed bytes, and an
 *   append onto that is a fork. A human runs `approval log verify` and the sync
 *   again; the writer's refusal says so.
 * - A lock beside a log file that does not exist. Nothing has been written that
 *   the reclaim record could follow, and the state is not one this module can
 *   reason about.
 *
 * Nothing here reads the log, decides a verdict, or writes a record. Its
 * readers are `core/log.ts`'s writer (reclaim, release, the refusal message)
 * and anyone who wants to describe a lockfile (`describeLogLock`).
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname, uptime } from "node:os";
import { basename } from "node:path";

/** The holder record's format version. A reader treats any other as unverifiable. */
export const LOCK_HOLDER_VERSION = 1;

/**
 * How old a lockfile with no holder record must be before it is reclaimed.
 * Generous on purpose: an older writer still running cannot be told from a dead
 * one, and the longest holder in this runtime holds for seconds.
 */
export const LEGACY_LOCK_RECLAIM_AGE_MS = 10 * 60_000;

/**
 * How long a reclaim's link may sit before another writer treats the reclaim as
 * abandoned (its reclaimer killed between the link and the rename). A reclaim
 * takes microseconds.
 */
const ABANDONED_RECLAIM_AGE_MS = 10_000;

/**
 * Off Linux the boot is the host's boot time to the second, read as now minus
 * uptime. A clock step moves both readings of it, so two holders' boots are the
 * same boot unless they differ by more than this.
 */
const BOOT_TOLERANCE_S = 600;

/** `append`: one record. `hold`: a whole operation under `withAppendLock`. */
export type LockOp = "append" | "hold";

/** What a lockfile written by this version holds, one JSON line. */
export interface LockHolder {
  v: typeof LOCK_HOLDER_VERSION;
  pid: number;
  host: string;
  /** Linux: `/proc/sys/kernel/random/boot_id`. Elsewhere: `~<boot epoch seconds>`. */
  boot: string;
  /** Linux only: `/proc/self/ns/pid`, so a holder in another container is never judged by pid. */
  pidns?: string;
  /** Linux only: field 22 of `/proc/<pid>/stat`, clock ticks after boot. */
  start?: string;
  /** When the lock was taken, RFC 3339. */
  created: string;
  op: LockOp;
  /** Random, so two lockfiles are never byte-identical. */
  nonce: string;
}

/** Why a lock was reclaimed. The `audit.lock_reclaimed` payload's `reason`. */
export type LockReclaimReason = "holder-dead" | "holder-replaced" | "holder-boot-ended" | "legacy-aged";

/** The judgement on one holder record. */
export type HolderVerdict =
  | { state: "live"; why: string }
  | { state: "gone"; reason: Exclude<LockReclaimReason, "legacy-aged">; why: string };

/** This process, as a holder record describes it. */
export interface SelfIdentity {
  pid: number;
  host: string;
  boot: string | undefined;
  pidns: string | undefined;
  start: string | undefined;
  linux: boolean;
}

/** What a liveness judgement may ask of the operating system. Injected by tests. */
export interface LivenessProbe {
  /** Linux: the pid's `/proc` state letter and start time, or `null` when there is no such process. */
  linuxStat(pid: number): { state: string; start: string } | null;
  /** `kill(pid, 0)`: does any process have this pid (EPERM counts as yes)? */
  pidExists(pid: number): boolean;
}

// ---------------------------------------------------------------------------
// This process
// ---------------------------------------------------------------------------

function readTrimmed(path: string): string | undefined {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * Parse `/proc/<pid>/stat`: the command name is parenthesized and may contain
 * spaces and parentheses, so the fields are counted from the LAST `)`. After it,
 * index 0 is field 3 (state) and index 19 is field 22 (starttime).
 */
export function parseProcStat(text: string): { state: string; start: string } | null {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/u);
  const state = fields[0];
  const start = fields[19];
  if (state === undefined || start === undefined || !/^\d+$/u.test(start)) return null;
  return { state, start };
}

function linuxStatOf(pid: number): { state: string; start: string } | null {
  let text: string;
  try {
    text = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
  } catch {
    return null;
  }
  return parseProcStat(text);
}

const NODE_PROBE: LivenessProbe = {
  linuxStat: linuxStatOf,
  pidExists(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      // EPERM: the pid exists and belongs to somebody else. Only ESRCH is "none".
      return (cause as NodeJS.ErrnoException).code !== "ESRCH";
    }
  },
};

let cachedSelf: SelfIdentity | undefined;

/** This process's identity, read once: none of it changes while the process lives. */
export function selfIdentity(): SelfIdentity {
  if (cachedSelf !== undefined && cachedSelf.pid === process.pid) return cachedSelf;
  const linux = process.platform === "linux";
  let pidns: string | undefined;
  let start: string | undefined;
  let boot: string | undefined;
  if (linux) {
    boot = readTrimmed("/proc/sys/kernel/random/boot_id");
    try {
      pidns = readlinkSync("/proc/self/ns/pid");
    } catch {
      pidns = undefined;
    }
    start = linuxStatOf(process.pid)?.start;
  } else {
    boot = approximateBoot();
  }
  cachedSelf = { pid: process.pid, host: safeHostname(), boot, pidns, start, linux };
  return cachedSelf;
}

function approximateBoot(): string | undefined {
  try {
    const seconds = Math.round(Date.now() / 1000 - uptime());
    return Number.isFinite(seconds) ? `~${String(seconds)}` : undefined;
  } catch {
    return undefined;
  }
}

function safeHostname(): string {
  try {
    return hostname();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** The record this process writes into a lockfile it creates now. */
export function holderRecord(op: LockOp, now: Date = new Date()): LockHolder {
  const self = selfIdentity();
  const record: LockHolder = {
    v: LOCK_HOLDER_VERSION,
    pid: self.pid,
    host: self.host,
    boot: self.boot ?? "",
    created: now.toISOString(),
    op,
    nonce: randomBytes(8).toString("hex"),
  };
  if (self.pidns !== undefined) record.pidns = self.pidns;
  if (self.start !== undefined) record.start = self.start;
  return record;
}

/**
 * What a lockfile's bytes say about its holder: a v1 record, a record of a
 * format this version does not know (`unknown`, never reclaimed), or nothing
 * (`legacy`: empty, unparseable, or not a record at all).
 */
export function parseHolder(
  bytes: Buffer | string,
): { kind: "v1"; holder: LockHolder } | { kind: "unknown"; version: unknown } | { kind: "legacy" } {
  const text = (typeof bytes === "string" ? bytes : bytes.toString("utf8")).trim();
  if (text === "") return { kind: "legacy" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "legacy" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "legacy" };
  const record = value as Record<string, unknown>;
  if (!("v" in record)) return { kind: "legacy" };
  if (record["v"] !== LOCK_HOLDER_VERSION) return { kind: "unknown", version: record["v"] };
  const { pid, host, boot, created, op, nonce, pidns, start } = record;
  if (
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof host !== "string" ||
    typeof boot !== "string" ||
    typeof created !== "string" ||
    (op !== "append" && op !== "hold") ||
    typeof nonce !== "string" ||
    (pidns !== undefined && typeof pidns !== "string") ||
    (start !== undefined && typeof start !== "string")
  ) {
    return { kind: "unknown", version: LOCK_HOLDER_VERSION };
  }
  const holder: LockHolder = { v: LOCK_HOLDER_VERSION, pid, host, boot, created, op, nonce };
  if (pidns !== undefined) holder.pidns = pidns;
  if (start !== undefined) holder.start = start;
  return { kind: "v1", holder };
}

// ---------------------------------------------------------------------------
// The judgement
// ---------------------------------------------------------------------------

function sameBootOffLinux(a: string, b: string): boolean | undefined {
  const parse = (value: string): number | undefined =>
    /^~\d+$/u.test(value) ? Number(value.slice(1)) : undefined;
  const left = parse(a);
  const right = parse(b);
  if (left === undefined || right === undefined) return undefined;
  return Math.abs(left - right) <= BOOT_TOLERANCE_S;
}

/**
 * Is the process that wrote `holder` provably gone? Pure: the identity of the
 * reader and the operating system's answers are parameters.
 *
 * "Live" means "not provably gone", and covers every case this reader cannot
 * see into. The order matters: the holder's own machine and pid space are
 * established before any pid is looked up, because a pid means nothing outside
 * the namespace it was issued in.
 */
export function judgeHolder(
  holder: LockHolder,
  self: SelfIdentity,
  probe: LivenessProbe,
): HolderVerdict {
  const who = `pid ${String(holder.pid)} on ${holder.host === "" ? "an unnamed host" : holder.host}`;
  if (self.linux) {
    if (self.boot === undefined || self.pidns === undefined) {
      return { state: "live", why: `${who} cannot be checked: this process cannot read its own boot id or pid namespace` };
    }
    if (holder.boot === "" || holder.pidns === undefined) {
      return { state: "live", why: `${who} cannot be checked: its record names no boot id or pid namespace` };
    }
    if (holder.boot !== self.boot) {
      if (holder.host !== "" && holder.host === self.host) {
        return { state: "gone", reason: "holder-boot-ended", why: `${who} took the lock during an earlier boot of this host` };
      }
      return { state: "live", why: `${who} is on another machine (a different boot id), where this process cannot see its processes` };
    }
    if (holder.pidns !== self.pidns) {
      return { state: "live", why: `${who} is in another pid namespace (another container), where this process cannot see its processes` };
    }
    const stat = probe.linuxStat(holder.pid);
    if (stat === null) return { state: "gone", reason: "holder-dead", why: `${who} has exited` };
    if (stat.state === "Z" || stat.state === "X") {
      return { state: "gone", reason: "holder-dead", why: `${who} has exited (a zombie holds nothing)` };
    }
    if (holder.start === undefined) {
      return { state: "live", why: `${who} is running and its record has no start time to compare` };
    }
    if (stat.start !== holder.start) {
      return { state: "gone", reason: "holder-replaced", why: `${who} exited; the pid now names a process that started later` };
    }
    return { state: "live", why: `${who} is running` };
  }
  if (holder.host === "" || holder.host !== self.host) {
    return { state: "live", why: `${who} is on another host, where this process cannot see its processes` };
  }
  if (holder.pidns !== undefined) {
    return { state: "live", why: `${who} wrote its record under Linux, whose pids this process cannot see` };
  }
  if (self.boot !== undefined) {
    const same = sameBootOffLinux(holder.boot, self.boot);
    if (same === false) {
      return { state: "gone", reason: "holder-boot-ended", why: `${who} took the lock before this host last booted` };
    }
  }
  if (!probe.pidExists(holder.pid)) return { state: "gone", reason: "holder-dead", why: `${who} has exited` };
  return {
    state: "live",
    why: `${who} is running; this platform has no way to read its start time without ps, so it is taken to be the holder`,
  };
}

let judgeForTests: ((holder: LockHolder) => HolderVerdict) | null = null;

/**
 * Replace the liveness judgement (tests only: the mutation check that a live
 * holder's lock survives only because of the check). `null` restores the real
 * one. Nothing in `src/` calls this.
 */
export function setLockLivenessForTests(judge: ((holder: LockHolder) => HolderVerdict) | null): void {
  judgeForTests = judge;
}

function judge(holder: LockHolder): HolderVerdict {
  return judgeForTests === null ? judgeHolder(holder, selfIdentity(), NODE_PROBE) : judgeForTests(holder);
}

// ---------------------------------------------------------------------------
// The lockfile
// ---------------------------------------------------------------------------

/** A lockfile as read: its identity and its bytes. */
interface SeenLock {
  ino: bigint;
  mtimeNs: bigint;
  mtimeMs: number;
  ctimeMs: number;
  bytes: Buffer;
}

/** Read a lockfile through one descriptor, or `null` when there is none. */
function readLock(path: string): SeenLock | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    const buffer = Buffer.alloc(4096);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read <= 0) break;
      length += read;
      if (length >= buffer.length) break;
    }
    return {
      ino: stat.ino,
      mtimeNs: stat.mtimeNs,
      mtimeMs: Number(stat.mtimeMs),
      ctimeMs: Number(stat.ctimeMs),
      bytes: buffer.subarray(0, length),
    };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function sameLock(a: SeenLock, b: SeenLock): boolean {
  return a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.bytes.equals(b.bytes);
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // A name that is already gone is the outcome wanted.
  }
}

/** The lock this process created: enough to release only that one. */
export interface OwnLock {
  path: string;
  ino: bigint;
  bytes: Buffer;
}

/**
 * Create `lockPath` with `wx` (atomic create-or-fail, exactly as before) and
 * write this process's holder record into it. Throws what `openSync` throws, so
 * `EEXIST` still means another writer holds it. A record that cannot be written
 * leaves an empty lockfile, which is still a lock and reads as unattributed.
 */
export function createLockFile(lockPath: string, op: LockOp): OwnLock {
  const fd = openSync(lockPath, "wx");
  let bytes = Buffer.alloc(0);
  let ino = 0n;
  try {
    try {
      ino = fstatSync(fd, { bigint: true }).ino;
    } catch {
      ino = 0n;
    }
    const line = Buffer.from(`${JSON.stringify(holderRecord(op))}\n`, "utf8");
    try {
      if (writeSync(fd, line, 0, line.length) === line.length) bytes = line;
    } catch {
      // The lock is held either way; an empty file is an unattributed lock.
    }
  } finally {
    closeSync(fd);
  }
  return { path: lockPath, ino, bytes };
}

/**
 * Remove the lock this process created, and only it. The file is read back and
 * compared with what was written; anything else at that path (which would mean
 * somebody reclaimed this lock from a process that is plainly alive) is left
 * where it is rather than released on that somebody's behalf.
 */
export function releaseLockFile(own: OwnLock): void {
  const seen = readLock(own.path);
  if (seen === null) return;
  if (own.ino !== 0n && seen.ino !== own.ino) return;
  if (own.bytes.length > 0 && !seen.bytes.equals(own.bytes)) return;
  unlinkQuietly(own.path);
}

/** What `tryReclaimLock` found and did. */
export type ReclaimOutcome =
  | { kind: "reclaimed"; note: ReclaimNote }
  /** The lockfile was gone by the time it was read or linked: try the create again. */
  | { kind: "vanished" }
  /** The lock stays where it is; `why` says whose it is and why it was kept. */
  | { kind: "kept"; why: string };

/** What an `audit.lock_reclaimed` record says. */
export interface ReclaimNote {
  /** The lockfile's own name, without its directory. */
  lockfile: string;
  reason: LockReclaimReason;
  /** The holder record, when the lockfile had one (never its host or nonce). */
  holder?: { pid: number; op: LockOp; created: string };
  /** How long the lock had been held when it was reclaimed, from its record or its mtime. */
  age_ms: number;
  /** One line for a person. Not part of the record. */
  why: string;
}

function snapshotPathFor(logPath: string): string {
  // `cli/log-sync.ts`'s `snapshotPathFor`, by its documented name.
  return `${logPath}.sync-snapshot`;
}

/**
 * Judge `<logPath>.lock` and, if its holder is provably gone, remove it
 * atomically so the caller's next `wx` create can take the lock.
 *
 * Exactly one of any number of concurrent callers that judged the same stale
 * lock removes it: the first step is `link(2)` to a name derived from the
 * lockfile's inode, which fails for everyone after the first. That one then
 * checks the linked file is still the one it judged, renames the lockfile aside
 * and checks again, so a lockfile that changed hands in between (a fresh lock
 * on a reused inode, an older writer releasing and another creating) is put
 * back rather than removed. Every name this creates ends in `.lock`, which the
 * daemon's watcher already ignores.
 */
export function tryReclaimLock(logPath: string, now: number = Date.now()): ReclaimOutcome {
  const lockPath = `${logPath}.lock`;
  const seen = readLock(lockPath);
  if (seen === null) return { kind: "vanished" };

  const parsed = parseHolder(seen.bytes);
  let reason: LockReclaimReason;
  let why: string;
  let holder: ReclaimNote["holder"];
  let ageMs: number;
  if (parsed.kind === "legacy") {
    ageMs = Math.max(0, Math.round(now - seen.mtimeMs));
    if (ageMs < LEGACY_LOCK_RECLAIM_AGE_MS) {
      return {
        kind: "kept",
        why: `the lockfile names no holder (an older writer, or one killed between creating it and writing its record) and is ${String(Math.round(ageMs / 1000))} s old; such a lock is reclaimed only once it is ${String(LEGACY_LOCK_RECLAIM_AGE_MS / 60_000)} minutes old`,
      };
    }
    reason = "legacy-aged";
    why = `the lockfile names no holder and is ${String(Math.round(ageMs / 1000))} s old`;
  } else if (parsed.kind === "unknown") {
    return {
      kind: "kept",
      why: `the lockfile's holder record is in a format this version does not read (v ${JSON.stringify(parsed.version)}), so its holder cannot be checked`,
    };
  } else {
    const verdict = judge(parsed.holder);
    const created = Date.parse(parsed.holder.created);
    ageMs = Number.isFinite(created) ? Math.max(0, Math.round(now - created)) : Math.max(0, Math.round(now - seen.mtimeMs));
    if (verdict.state === "live") {
      return { kind: "kept", why: `held by ${verdict.why} (${parsed.holder.op}, since ${parsed.holder.created})` };
    }
    reason = verdict.reason;
    why = verdict.why;
    holder = { pid: parsed.holder.pid, op: parsed.holder.op, created: parsed.holder.created };
  }

  if (existsSync(snapshotPathFor(logPath))) {
    return {
      kind: "kept",
      why: `${why}, but a log sync snapshot (${basename(snapshotPathFor(logPath))}) is beside the log, so a sync may have stopped part way with the working log set to its committed bytes; run \`approval log verify\` and \`approval log sync\` before removing ${basename(lockPath)} by hand`,
    };
  }
  if (!existsSync(logPath)) {
    return {
      kind: "kept",
      why: `${why}, but the log itself is absent, so there is nothing a reclaim could follow; remove ${basename(lockPath)} by hand once the log is accounted for`,
    };
  }

  // Step 1: the exclusive claim. One name per judged lockfile.
  const claim = `${lockPath}.reclaim-${seen.ino.toString()}.lock`;
  try {
    linkSync(lockPath, claim);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "vanished" };
    if (code === "EEXIST") {
      const other = readLock(claim);
      if (other !== null && other.ino === seen.ino && now - other.ctimeMs > ABANDONED_RECLAIM_AGE_MS) {
        // A reclaimer killed between its link and its rename. Its name goes;
        // the lock stays for the next wait, which claims it afresh.
        unlinkQuietly(claim);
        return { kind: "kept", why: `${why}; an abandoned reclaim of it was cleared and the next wait will reclaim it` };
      }
      return { kind: "kept", why: `${why}; another writer is reclaiming it now` };
    }
    return {
      kind: "kept",
      why: `${why}, but it cannot be reclaimed here: this filesystem refused the link the reclaim needs (${code ?? "error"})`,
    };
  }

  // Step 2: is the claimed file still the one judged?
  const claimed = readLock(claim);
  if (claimed === null || !sameLock(claimed, seen)) {
    unlinkQuietly(claim);
    return { kind: "kept", why: `the lock changed hands while it was being judged` };
  }

  // Step 3: move the lockfile aside, and check it is still that file.
  const aside = `${lockPath}.reclaim-${seen.ino.toString()}.gone.lock`;
  try {
    renameSync(lockPath, aside);
  } catch (cause) {
    unlinkQuietly(claim);
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { kind: "vanished" };
    return { kind: "kept", why: `${why}, but it could not be moved aside: ${(cause as Error).message}` };
  }
  const moved = readLock(aside);
  if (moved === null || !sameLock(moved, seen)) {
    // Something else was at the path by the time of the rename. Put it back if
    // the path is still free; a writer that took the path meanwhile keeps it.
    let restored = false;
    try {
      linkSync(aside, lockPath);
      restored = true;
    } catch {
      restored = false;
    }
    if (restored) unlinkQuietly(aside);
    unlinkQuietly(claim);
    return {
      kind: "kept",
      why: restored
        ? `the lock changed hands during the reclaim and was put back`
        : `the lock changed hands during the reclaim and could not be put back; it is at ${basename(aside)}`,
    };
  }

  unlinkQuietly(aside);
  unlinkQuietly(claim);
  const note: ReclaimNote = { lockfile: basename(lockPath), reason, age_ms: ageMs, why };
  if (holder !== undefined) note.holder = holder;
  return { kind: "reclaimed", note };
}

/**
 * Describe `<logPath>.lock` for a person, without touching it: `null` when
 * there is none, else whose it is and whether a writer would reclaim it.
 */
export function describeLogLock(logPath: string, now: number = Date.now()): string | null {
  const seen = readLock(`${logPath}.lock`);
  if (seen === null) return null;
  const parsed = parseHolder(seen.bytes);
  if (parsed.kind === "legacy") {
    const age = Math.round((now - seen.mtimeMs) / 1000);
    return `no holder record, ${String(age)} s old; reclaimable ${age * 1000 >= LEGACY_LOCK_RECLAIM_AGE_MS ? "now" : `at ${String(LEGACY_LOCK_RECLAIM_AGE_MS / 60_000)} minutes`}`;
  }
  if (parsed.kind === "unknown") return `a holder record in a format this version does not read`;
  const verdict = judge(parsed.holder);
  return verdict.state === "live"
    ? `held by ${verdict.why} (${parsed.holder.op}, since ${parsed.holder.created})`
    : `left by a holder that is gone: ${verdict.why}; the next writer reclaims it`;
}

// ---------------------------------------------------------------------------
// Termination signals while a lock is held
// ---------------------------------------------------------------------------

const GUARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
const guards = new Map<NodeJS.Signals, () => void>();
let locksHeld = 0;
let removalScheduled = false;

function removeGuards(): void {
  for (const [signal, listener] of guards) process.removeListener(signal, listener);
  guards.clear();
}

/**
 * The guard's listener. It can only run on the event loop, and this process
 * holds a lock only inside synchronous code, so no lock is held here. Put the
 * default disposition back and raise the signal again, unless somebody else
 * registered a listener meanwhile (a harness hook's wait), in which case that
 * listener was called for this same signal and owns the outcome.
 */
function reraise(signal: NodeJS.Signals): void {
  removeGuards();
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

function scheduleGuardRemoval(): void {
  if (removalScheduled) return;
  removalScheduled = true;
  // Two hops cross a poll phase from any phase, so a signal that arrived while
  // the lock was held is dispatched to the guard before the guard goes. Removing
  // it synchronously would discard such a signal: a held signal whose last
  // listener is removed is dropped (APRV-478's notes, Node 24 and 26).
  setImmediate(() => {
    setImmediate(() => {
      removalScheduled = false;
      if (locksHeld === 0) removeGuards();
    });
  });
}

/**
 * Hold SIGTERM, SIGINT and SIGHUP while this process holds a lock, for each one
 * nobody listens for (the default disposition, which would kill the process
 * with the lockfile in place). Returns the release, which the caller runs after
 * the lockfile is removed. A signal that nobody else listens for is then
 * re-raised with its default disposition at the next turn of the event loop, so
 * the process still dies of it, one lock release later. Windows has no such
 * signals to hold; there this is a no-op.
 */
export function guardTerminationWhileLocked(): () => void {
  if (process.platform === "win32") return () => undefined;
  locksHeld += 1;
  for (const signal of GUARDED_SIGNALS) {
    if (guards.has(signal) || process.listenerCount(signal) > 0) continue;
    const listener = (): void => {
      reraise(signal);
    };
    guards.set(signal, listener);
    process.on(signal, listener);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    locksHeld -= 1;
    if (locksHeld === 0 && guards.size > 0) scheduleGuardRemoval();
  };
}
