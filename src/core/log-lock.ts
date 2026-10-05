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
 * ## The rule every decision here follows
 *
 * A wrong reclaim (two writers under one lock, a forked chain) is far worse than
 * a missed one (a wedge a human can clear). So a holder is LIVE unless this
 * process can prove it gone, and every step that could take a live writer's lock
 * re-proves, immediately before it acts, that it is acting on the file it judged.
 *
 * ## What this module does about it
 *
 * 1. **The lockfile names its holder.** {@link createLockFile} writes one JSON
 *    line into the file it creates: the pid, the host, the boot, on Linux the
 *    pid and time namespaces and the process start time, when the lock was
 *    taken, which kind of holder it is, and a nonce. An older writer's empty
 *    lockfile has no such record.
 * 2. **A lock is reclaimed only from a holder that is provably gone.**
 *    {@link judgeHolder} decides from the record and the platform. On Linux,
 *    with `/proc` mounted for this process's own pid namespace, in the same boot
 *    and pid namespace as the holder: `/proc/<pid>` absent AND `kill(pid, 0)`
 *    answering ESRCH, or `/proc/<pid>/stat` naming a zombie, or naming a process
 *    whose start time (read in the same time namespace) is not the holder's. A
 *    `/proc` entry that cannot be read (hidepid, another uid, an LSM) is LIVE,
 *    and so is an absent entry that `kill(pid, 0)` still finds. Elsewhere (macOS,
 *    the BSDs, Windows) there is no ps-free way to read another process's start
 *    time, so the only proof is the same host and `kill(pid, 0)` answering ESRCH;
 *    a pid that exists there is the holder, however old the lock, and a boot
 *    reading that moved (a wall-clock step moves it) proves nothing. A holder
 *    under another kernel (a different boot id: an earlier boot, or a microVM or
 *    another machine sharing the filesystem, which cannot be told apart), in
 *    another pid namespace, on another host, or with a record of a newer format
 *    is LIVE.
 * 3. **An unattributed lockfile ages out.** A lockfile with no holder record
 *    (written by an older version, or by a writer killed between the create and
 *    the write) is reclaimed only once it is {@link LEGACY_LOCK_RECLAIM_AGE_MS}
 *    old. An append holds the lock for milliseconds and the longest holder in
 *    this runtime (`approval log sync`) for seconds.
 * 4. **Exactly one reclaimer, and it acts only on the file it judged.**
 *    {@link tryReclaimLock}: claim the judged lockfile with an exclusive
 *    `link(2)` of a file carrying the claimant's own holder record; a claim is
 *    passed over only when its claimant is provably gone (by the same
 *    judgement), never because of its age. Re-check the lockfile (inode, mtime,
 *    bytes) and the claim, write the record of the reclaim beside the lock,
 *    re-check both again, and rename the lockfile aside: that rename is the
 *    commit point. The winner then takes the lock with the same `wx` create
 *    every writer uses, so a writer that wins that create first is ordinary
 *    contention.
 * 5. **The reclaim is in the log, and cannot be lost.** The record of the reclaim
 *    is written to `<lock>.reclaim-<key>.pending.lock` BEFORE the commit point,
 *    and `core/log.ts` appends every such pending record as `audit.lock_reclaimed`
 *    as the first write under whichever lock comes next, the reclaimer's or
 *    another writer's, from a fresh read of the tail: the caller's own
 *    compare-and-append (SPEC.md §11.1 invariant 5) then sees a moved head and
 *    re-reads, as it would after any other writer's record.
 * 6. **A termination signal does not leave a lock behind.**
 *    {@link guardTerminationWhileLocked} registers a listener for SIGTERM, SIGINT
 *    and SIGHUP while this process holds a lock, for each signal nobody else
 *    listens for, and the listener re-raises the signal with its default
 *    disposition once the lock is released, so the process still dies of it.
 *    SIGKILL cannot be caught, which is what 1 to 5 are for.
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
 * readers are `core/log.ts`'s writer (reclaim, pending records, release, the
 * refusal message) and anyone who wants to describe a lockfile
 * (`describeLogLock`).
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname, uptime } from "node:os";
import { basename, dirname, join } from "node:path";

/** The holder record's format version. A reader treats any other as unverifiable. */
export const LOCK_HOLDER_VERSION = 1;

/**
 * How old a lockfile with no holder record must be before it is reclaimed.
 * Generous on purpose: an older writer still running cannot be told from a dead
 * one, and the longest holder in this runtime holds for seconds.
 */
export const LEGACY_LOCK_RECLAIM_AGE_MS = 10 * 60_000;

/**
 * How many claimants of one stale lock may have died mid-reclaim before a writer
 * stops trying further claims and leaves the lock to a human. Each step past the
 * first needs a reclaimer to have died between its claim and its release.
 */
const MAX_CLAIM_GENERATIONS = 16;

/** `append`: one record. `hold`: a whole operation under `withAppendLock`. */
export type LockOp = "append" | "hold";

/** Who a process is, as far as a liveness judgement can use it. */
export interface HolderIdentity {
  pid: number;
  host: string;
  /** Linux: `/proc/sys/kernel/random/boot_id`. Elsewhere: `~<boot epoch seconds>` (recorded, never judged). */
  boot: string;
  /** Linux only: `/proc/self/ns/pid`, so a holder in another container is never judged by pid. */
  pidns?: string;
  /** Linux only: field 22 of `/proc/self/stat`, clock ticks after boot as this process's time namespace reads it. */
  start?: string;
  /** Linux only, where the kernel has time namespaces: `/proc/self/ns/time`, so start times are compared only within one. */
  timens?: string;
}

/** What a lockfile written by this version holds, one JSON line. */
export interface LockHolder extends HolderIdentity {
  v: typeof LOCK_HOLDER_VERSION;
  /** When the lock was taken, RFC 3339. */
  created: string;
  op: LockOp;
  /** Random, so two lockfiles are never byte-identical. */
  nonce: string;
}

/**
 * Why a lock was reclaimed. The `audit.lock_reclaimed` payload's `reason`.
 * `holder-boot-ended` stays in the closed set for the schema's sake; since fix
 * round 1 of APRV-479 no judgement produces it (a different boot proves nothing).
 */
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
  /** Linux: `/proc/self/ns/time`, or undefined where the kernel has no time namespaces. */
  timens?: string | undefined;
  linux: boolean;
  /**
   * Linux: whether `/proc` is this process's own pid namespace's procfs
   * (`/proc/self` names `process.pid`). `false` means no pid read from it can be
   * trusted, and every holder is LIVE. Absent is taken as `true` (tests).
   */
  procIsOwn?: boolean;
}

/** What `/proc/<pid>/stat` said. */
export type ProcStatRead =
  | { kind: "stat"; state: string; start: string }
  /** ENOENT (or ESRCH while reading): no entry this process can see. Not proof of death on its own. */
  | { kind: "absent" }
  /** Any other outcome (EACCES, EPERM, an unparseable line): nothing can be concluded. */
  | { kind: "unreadable"; why: string };

/** What a liveness judgement may ask of the operating system. Injected by tests. */
export interface LivenessProbe {
  /** Linux: `/proc/<pid>/stat`, as read by this process. */
  linuxStat(pid: number): ProcStatRead;
  /** `kill(pid, 0)`: `false` only when it answers ESRCH; success, EPERM and every other error are `true`. */
  pidExists(pid: number): boolean;
}

// ---------------------------------------------------------------------------
// This process
// ---------------------------------------------------------------------------

function errnoOf(cause: unknown): string | undefined {
  return (cause as NodeJS.ErrnoException | undefined)?.code;
}

function readTrimmed(path: string): string | undefined {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

function readLinkOrUndefined(path: string): string | undefined {
  try {
    return readlinkSync(path, "utf8");
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

function readProcStat(path: string): ProcStatRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    const code = errnoOf(cause);
    // ENOENT: no entry this process can see (exited, or hidden by hidepid).
    // ESRCH: the task went away between the open and the read. Either way the
    // caller must still ask kill(pid, 0) before calling the holder gone.
    if (code === "ENOENT" || code === "ESRCH") return { kind: "absent" };
    return { kind: "unreadable", why: code ?? "error" };
  }
  const parsed = parseProcStat(text);
  return parsed === null ? { kind: "unreadable", why: "an unparseable stat line" } : { kind: "stat", ...parsed };
}

/** The real probe: `/proc` and `kill(pid, 0)`. Exported for tests of its two error rules. */
export const NODE_LIVENESS_PROBE: LivenessProbe = {
  linuxStat: (pid) => readProcStat(`/proc/${String(pid)}/stat`),
  pidExists(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      // EPERM: the pid exists and belongs to somebody else (and is how another
      // uid's process looks under hidepid). Only ESRCH is "none".
      return errnoOf(cause) !== "ESRCH";
    }
  },
};

/**
 * Is `/proc` this process's own pid namespace's procfs? `/proc/self` resolves
 * to the reader's pid AS THAT PROCFS NUMBERS IT, so it names `process.pid` only
 * when the procfs belongs to the namespace `process.pid` was issued in. A
 * container that unshared its pid namespace without remounting `/proc` fails
 * this, and every `/proc/<pid>` it reads is some other process (APRV-479, S3).
 */
export function procIsOwnNamespace(
  read: (path: string) => string = (path) => readlinkSync(path, "utf8"),
  pid: number = process.pid,
): boolean {
  try {
    return read("/proc/self") === String(pid);
  } catch {
    return false;
  }
}

let cachedSelf: SelfIdentity | undefined;

/** This process's identity, read once: none of it changes while the process lives. */
export function selfIdentity(): SelfIdentity {
  if (cachedSelf !== undefined && cachedSelf.pid === process.pid) return cachedSelf;
  const linux = process.platform === "linux";
  let pidns: string | undefined;
  let start: string | undefined;
  let timens: string | undefined;
  let boot: string | undefined;
  let procIsOwn: boolean | undefined;
  if (linux) {
    boot = readTrimmed("/proc/sys/kernel/random/boot_id");
    procIsOwn = procIsOwnNamespace();
    if (procIsOwn) {
      pidns = readLinkOrUndefined("/proc/self/ns/pid");
      timens = readLinkOrUndefined("/proc/self/ns/time");
      const own = readProcStat("/proc/self/stat");
      start = own.kind === "stat" ? own.start : undefined;
    }
  } else {
    boot = approximateBoot();
  }
  cachedSelf = { pid: process.pid, host: safeHostname(), boot, pidns, start, timens, linux };
  if (procIsOwn !== undefined) cachedSelf.procIsOwn = procIsOwn;
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

function identityFields(): HolderIdentity {
  const self = selfIdentity();
  const identity: HolderIdentity = { pid: self.pid, host: self.host, boot: self.boot ?? "" };
  if (self.pidns !== undefined) identity.pidns = self.pidns;
  if (self.start !== undefined) identity.start = self.start;
  if (self.timens !== undefined) identity.timens = self.timens;
  return identity;
}

/** The record this process writes into a lockfile it creates now. */
export function holderRecord(op: LockOp, now: Date = new Date()): LockHolder {
  const identity = identityFields();
  const record: LockHolder = {
    v: LOCK_HOLDER_VERSION,
    pid: identity.pid,
    host: identity.host,
    boot: identity.boot,
    created: now.toISOString(),
    op,
    nonce: randomBytes(8).toString("hex"),
  };
  if (identity.pidns !== undefined) record.pidns = identity.pidns;
  if (identity.start !== undefined) record.start = identity.start;
  if (identity.timens !== undefined) record.timens = identity.timens;
  return record;
}

/** The identity fields of a parsed record, or `null` when any is malformed. */
function parseIdentity(record: Record<string, unknown>): HolderIdentity | null {
  const { pid, host, boot, pidns, start, timens } = record;
  if (
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof host !== "string" ||
    typeof boot !== "string" ||
    (pidns !== undefined && typeof pidns !== "string") ||
    (start !== undefined && typeof start !== "string") ||
    (timens !== undefined && typeof timens !== "string")
  ) {
    return null;
  }
  const identity: HolderIdentity = { pid, host, boot };
  if (pidns !== undefined) identity.pidns = pidns;
  if (start !== undefined) identity.start = start;
  if (timens !== undefined) identity.timens = timens;
  return identity;
}

function parseJsonObject(bytes: Buffer | string): Record<string, unknown> | null | "empty" {
  const text = (typeof bytes === "string" ? bytes : bytes.toString("utf8")).trim();
  if (text === "") return "empty";
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * What a lockfile's bytes say about its holder: a v1 record, a record of a
 * format this version does not know (`unknown`, never reclaimed), or nothing
 * (`legacy`: empty, unparseable, or not a record at all).
 */
export function parseHolder(
  bytes: Buffer | string,
): { kind: "v1"; holder: LockHolder } | { kind: "unknown"; version: unknown } | { kind: "legacy" } {
  const record = parseJsonObject(bytes);
  if (record === "empty" || record === null) return { kind: "legacy" };
  if (!("v" in record)) return { kind: "legacy" };
  if (record["v"] !== LOCK_HOLDER_VERSION) return { kind: "unknown", version: record["v"] };
  const identity = parseIdentity(record);
  const { created, op, nonce } = record;
  if (
    identity === null ||
    typeof created !== "string" ||
    (op !== "append" && op !== "hold") ||
    typeof nonce !== "string"
  ) {
    return { kind: "unknown", version: LOCK_HOLDER_VERSION };
  }
  return { kind: "v1", holder: { v: LOCK_HOLDER_VERSION, ...identity, created, op, nonce } };
}

// ---------------------------------------------------------------------------
// The judgement
// ---------------------------------------------------------------------------

/**
 * Is the process that wrote `holder` provably gone? Pure: the identity of the
 * reader and the operating system's answers are parameters.
 *
 * "Live" means "not provably gone", and covers every case this reader cannot
 * see into. The order matters: the holder's own kernel and pid space are
 * established before any pid is looked up, because a pid means nothing outside
 * the namespace it was issued in.
 */
export function judgeHolder(
  holder: HolderIdentity,
  self: SelfIdentity,
  probe: LivenessProbe,
): HolderVerdict {
  const who = `pid ${String(holder.pid)} on ${holder.host === "" ? "an unnamed host" : holder.host}`;
  if (self.linux) {
    if (self.procIsOwn === false) {
      return {
        state: "live",
        why: `${who} cannot be checked: this process's /proc belongs to another pid namespace (/proc/self does not name this process), so no pid read from it can be trusted`,
      };
    }
    if (self.boot === undefined || self.pidns === undefined) {
      return { state: "live", why: `${who} cannot be checked: this process cannot read its own boot id or pid namespace` };
    }
    if (holder.boot === "" || holder.pidns === undefined) {
      return { state: "live", why: `${who} cannot be checked: its record names no boot id or pid namespace` };
    }
    if (holder.boot !== self.boot) {
      // An earlier boot of this machine and another kernel sharing this
      // filesystem (a microVM sandbox, another machine with this hostname) look
      // the same from here, and the second is alive (APRV-479, S4).
      return {
        state: "live",
        why: `${who} took the lock under another kernel (a different boot id: an earlier boot of this machine, or another machine or sandbox kernel sharing this filesystem, which cannot be told apart), where this process cannot see its processes`,
      };
    }
    if (holder.pidns !== self.pidns) {
      return { state: "live", why: `${who} is in another pid namespace (another container), where this process cannot see its processes` };
    }
    const stat = probe.linuxStat(holder.pid);
    if (stat.kind === "unreadable") {
      return { state: "live", why: `${who} cannot be checked: its /proc entry could not be read (${stat.why})` };
    }
    if (stat.kind === "absent") {
      // hidepid hides another uid's processes as ENOENT, so absence alone is
      // not death: kill(pid, 0) must also find no such process.
      if (probe.pidExists(holder.pid)) {
        return { state: "live", why: `${who} is running: /proc hides it from this process, but kill(pid, 0) finds it` };
      }
      return { state: "gone", reason: "holder-dead", why: `${who} has exited` };
    }
    if (stat.state === "Z" || stat.state === "X") {
      return { state: "gone", reason: "holder-dead", why: `${who} has exited (a zombie holds nothing)` };
    }
    if (holder.start === undefined) {
      return { state: "live", why: `${who} is running and its record has no start time to compare` };
    }
    if (holder.timens !== self.timens) {
      return { state: "live", why: `${who} is running under another time namespace, whose start times this process cannot compare` };
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
  // No boot comparison here: off Linux the boot reading is now minus uptime, and
  // a wall-clock step moves it (XNU adjusts kern.boottime on every clock set),
  // so a boot that differs proves nothing about a pid (APRV-479, B2).
  if (!probe.pidExists(holder.pid)) return { state: "gone", reason: "holder-dead", why: `${who} has exited` };
  return {
    state: "live",
    why: `${who} is running; this platform has no way to read its start time without ps, so it is taken to be the holder`,
  };
}

let judgeForTests: ((holder: HolderIdentity) => HolderVerdict) | null = null;

/**
 * Replace the liveness judgement (tests only: the mutation check that a live
 * holder's lock survives only because of the check). `null` restores the real
 * one. It judges reclaim claimants too. Nothing in `src/` calls this.
 */
export function setLockLivenessForTests(judge: ((holder: HolderIdentity) => HolderVerdict) | null): void {
  judgeForTests = judge;
}

function judge(holder: HolderIdentity): HolderVerdict {
  return judgeForTests === null ? judgeHolder(holder, selfIdentity(), NODE_LIVENESS_PROBE) : judgeForTests(holder);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** A lockfile as read: its identity and its bytes. */
interface SeenLock {
  ino: bigint;
  mtimeNs: bigint;
  mtimeMs: number;
  bytes: Buffer;
}

/** Read a file through one descriptor, or `null` when there is none. */
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
      bytes: buffer.subarray(0, length),
    };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * The same file with the same contents: inode, mtime to the nanosecond, and
 * bytes. Inode alone is not enough (ext4 hands a freed inode to the next file at
 * once, and a file rewritten in place keeps its inode); the bytes carry a v1
 * record's random nonce, and a legacy file's mtime is at least ten minutes old.
 */
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

/** Remove `path` only if it still holds exactly `bytes` (a name only this process writes). */
function unlinkIfBytes(path: string, bytes: Buffer): void {
  const seen = readLock(path);
  if (seen !== null && seen.bytes.equals(bytes)) unlinkQuietly(path);
}

/**
 * Write `bytes` to `tmp` (created `wx`), then `link(2)` it to `path`, which
 * fails if `path` exists: the content is complete before the name appears, so a
 * reader never sees a half-written claim or note, and of two writers exactly one
 * gets the name.
 */
function linkExclusive(
  path: string,
  tmp: string,
  bytes: Buffer,
): { kind: "written" } | { kind: "exists" } | { kind: "error"; code: string } {
  let complete = false;
  try {
    const fd = openSync(tmp, "wx");
    try {
      complete = writeSync(fd, bytes, 0, bytes.length) === bytes.length;
    } finally {
      closeSync(fd);
    }
  } catch (cause) {
    unlinkQuietly(tmp);
    return { kind: "error", code: errnoOf(cause) ?? "error" };
  }
  if (!complete) {
    unlinkQuietly(tmp);
    return { kind: "error", code: "short write" };
  }
  try {
    linkSync(tmp, path);
    return { kind: "written" };
  } catch (cause) {
    const code = errnoOf(cause);
    return code === "EEXIST" ? { kind: "exists" } : { kind: "error", code: code ?? "error" };
  } finally {
    unlinkQuietly(tmp);
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

// ---------------------------------------------------------------------------
// The reclaim
// ---------------------------------------------------------------------------

/** What `tryReclaimLock` found and did. */
export type ReclaimOutcome =
  | { kind: "reclaimed"; note: ReclaimNote }
  /** The lockfile was gone by the time it was read or claimed: try the create again. */
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

/** A named step inside {@link tryReclaimLock}, where a test may act (a stall, a swap). */
export type ReclaimStep =
  | "claimed"
  | "before-commit"
  /** After the last re-check, immediately before the rename: only something outside the protocol can act here. */
  | "at-commit"
  | "after-commit"
  | "before-put-back";

let seamForTests: ((step: ReclaimStep) => void) | null = null;

/**
 * Run `seam` at each named step of every reclaim (tests only: the stalled
 * reclaimer, the lockfile that changes hands at the worst moment). `null`
 * removes it. Nothing in `src/` calls this.
 */
export function setReclaimSeamForTests(seam: ((step: ReclaimStep) => void) | null): void {
  seamForTests = seam;
}

function step(name: ReclaimStep): void {
  if (seamForTests !== null) seamForTests(name);
}

function snapshotPathFor(logPath: string): string {
  // `cli/log-sync.ts`'s `snapshotPathFor`, by its documented name.
  return `${logPath}.sync-snapshot`;
}

/**
 * The name every file of one reclaim of one judged lockfile starts with. Keyed
 * by the lockfile's inode AND a digest of its mtime and bytes, so a later
 * lockfile that happens to reuse the inode is a different reclaim with its own
 * claims. Every name derived from it starts with `<lockfile>.` (the export
 * excludes that prefix) and ends in `.lock` (the daemon's watcher ignores it).
 */
function reclaimBase(lockPath: string, seen: SeenLock): string {
  const digest = createHash("sha256")
    .update(seen.mtimeNs.toString())
    .update("\0")
    .update(seen.bytes)
    .digest("hex")
    .slice(0, 12);
  return `${lockPath}.reclaim-${seen.ino.toString()}-${digest}`;
}

function claimPath(base: string, generation: number): string {
  return `${base}.claim-${String(generation)}.lock`;
}

/** A claim this process holds. */
interface HeldClaim {
  path: string;
  /** The next generation's name: it exists only if somebody judged this process gone. */
  next: string;
  bytes: Buffer;
}

function parseClaim(bytes: Buffer): HolderIdentity | null {
  const record = parseJsonObject(bytes);
  if (record === "empty" || record === null) return null;
  if (record["v"] !== LOCK_HOLDER_VERSION || record["kind"] !== "reclaim-claim") return null;
  return parseIdentity(record);
}

/**
 * Take the claim on one judged lockfile. Generation 0 first; a generation whose
 * claimant is provably gone (killed mid-reclaim) is passed over to the next,
 * and its file stays where it is (it is never removed, so no two writers can
 * ever both decide to replace it). A claimant that is live, or that cannot be
 * judged, holds its claim for as long as it takes: a reclaimer stalled for an
 * hour is a wedge for an hour, never a second reclaimer (APRV-479, B3).
 */
function takeClaim(
  base: string,
  nonce: string,
): { kind: "held"; claim: HeldClaim } | { kind: "busy"; why: string } | { kind: "vanished" } {
  const record = { v: LOCK_HOLDER_VERSION, kind: "reclaim-claim", ...identityFields(), created: new Date().toISOString(), nonce };
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  for (let generation = 0; generation < MAX_CLAIM_GENERATIONS; generation += 1) {
    const path = claimPath(base, generation);
    const linked = linkExclusive(path, `${base}.${nonce}.claim.tmp.lock`, bytes);
    if (linked.kind === "written") {
      return { kind: "held", claim: { path, next: claimPath(base, generation + 1), bytes } };
    }
    if (linked.kind === "error") {
      return { kind: "busy", why: `it cannot be reclaimed here: the claim the reclaim needs could not be made (${linked.code})` };
    }
    const other = readLock(path);
    // The claimant finished between the link and this read.
    if (other === null) return { kind: "vanished" };
    const claimant = parseClaim(other.bytes);
    if (claimant === null) {
      return { kind: "busy", why: `a reclaim of it is claimed in a form this version does not read, so it is left to that claimant` };
    }
    const verdict = judge(claimant);
    if (verdict.state === "live") return { kind: "busy", why: `another writer is reclaiming it now (${verdict.why})` };
    // That claimant is provably gone: its claim stands, the next one is tried.
  }
  return {
    kind: "busy",
    why: `${String(MAX_CLAIM_GENERATIONS)} reclaims of it were abandoned by writers that died mid-reclaim, so it is left for a human`,
  };
}

/** This process still holds `claim`: its bytes are there, and nobody judged it gone. */
function claimStillHeld(claim: HeldClaim): boolean {
  const seen = readLock(claim.path);
  return seen !== null && seen.bytes.equals(claim.bytes) && !existsSync(claim.next);
}

/** The judged lockfile is still the one at `lockPath`. */
function stillJudged(lockPath: string, seen: SeenLock): boolean {
  const now = readLock(lockPath);
  return now !== null && sameLock(now, seen);
}

/**
 * Judge `<logPath>.lock` and, if its holder is provably gone, remove it
 * atomically so the caller's next `wx` create can take the lock, leaving the
 * record of the reclaim pending beside it for whichever writer holds the lock
 * next ({@link pendingReclaims}).
 *
 * The steps, and why a stall anywhere is harmless:
 *
 * 1. Read and judge the lockfile. Touches nothing.
 * 2. Claim it ({@link takeClaim}). Only claims are written, and only reclaimers
 *    read them; a live claimant's claim is never passed over, so of any number
 *    of writers that judged this lockfile exactly one goes on.
 * 3. Re-check that the lockfile is still the one judged, then write the pending
 *    record of the reclaim (`<base>.pending.lock`). Nobody can hold the lock
 *    while the judged lockfile is in place, so nobody reads the record yet.
 * 4. Re-check the lockfile AND the claim, then rename the lockfile aside. THIS
 *    RENAME IS THE COMMIT POINT: before it, every name anybody but a reclaimer
 *    reads is untouched, so a reclaimer stalled or killed anywhere before it
 *    leaves the lock exactly as it was (a wedge, never a fork); after it, the
 *    lock is free for the ordinary `wx` create and the record of the reclaim is
 *    already durable. Inside the claim the judged lockfile can leave the path
 *    only through this rename, so the re-check immediately before it can be
 *    wrong only if something outside the protocol (a human `rm`, an older
 *    version's unconditional release) replaced the file in the instant between.
 * 5. Check that what was moved is the judged file. If it is not (that same
 *    out-of-protocol instant), put it back with `link(2)`, which never
 *    overwrites a lock somebody took meanwhile, and withdraw the record.
 * 6. Remove the moved file, then the claim. Both names are this reclaim's own.
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

  const base = reclaimBase(lockPath, seen);
  const nonce = randomBytes(8).toString("hex");

  // Step 2: the claim.
  const taken = takeClaim(base, nonce);
  if (taken.kind === "vanished") return { kind: "vanished" };
  if (taken.kind === "busy") return { kind: "kept", why: `${why}; ${taken.why}` };
  const claim = taken.claim;

  const note: ReclaimNote = { lockfile: basename(lockPath), reason, age_ms: ageMs, why };
  if (holder !== undefined) note.holder = holder;
  // The pending record this reclaim wrote, while it is still this reclaim's to
  // withdraw (until the commit point).
  let pendingOwn: { path: string; bytes: Buffer } | null = null;
  try {
    step("claimed");
    // Step 3: still the judged lockfile? Then the record goes down first (S1).
    if (!stillJudged(lockPath, seen)) {
      return { kind: "kept", why: `the lock changed hands while it was being judged; nothing was touched` };
    }
    const pendingPath = `${base}.pending.lock`;
    const pendingBytes = Buffer.from(`${JSON.stringify({ v: LOCK_HOLDER_VERSION, kind: "reclaim-pending", note })}\n`, "utf8");
    const pending = linkExclusive(pendingPath, `${base}.${nonce}.pending.tmp.lock`, pendingBytes);
    if (pending.kind === "error") {
      return {
        kind: "kept",
        why: `${why}, but the record of the reclaim could not be written beside the lock (${pending.code}), so the lock stays`,
      };
    }
    // "exists": a claimant before this one, provably gone, wrote the record for
    // this same lockfile; it stands for this reclaim.
    if (pending.kind === "written") pendingOwn = { path: pendingPath, bytes: pendingBytes };

    step("before-commit");
    // Step 4: re-check both, immediately before the one step that frees the lock.
    if (!stillJudged(lockPath, seen) || !claimStillHeld(claim)) {
      return { kind: "kept", why: `the lock or the claim on it changed during the reclaim; nothing was touched` };
    }
    const aside = `${base}.${nonce}.gone.lock`;
    step("at-commit");
    try {
      renameSync(lockPath, aside); // THE COMMIT POINT.
    } catch (cause) {
      if (errnoOf(cause) === "ENOENT") return { kind: "vanished" };
      return { kind: "kept", why: `${why}, but it could not be moved aside: ${(cause as Error).message}` };
    }
    step("after-commit");

    // Step 5: was it the judged file?
    const moved = readLock(aside);
    if (moved === null || !sameLock(moved, seen)) {
      // Reachable only from outside the protocol (see step 4). Put the file
      // back if it is still exactly what was moved and this process still
      // holds the claim; link(2) never replaces a lock somebody took meanwhile.
      step("before-put-back");
      let restored = false;
      const still = moved === null ? null : readLock(aside);
      if (moved !== null && still !== null && sameLock(still, moved) && claimStillHeld(claim)) {
        try {
          linkSync(aside, lockPath);
          restored = true;
        } catch {
          restored = false;
        }
      }
      if (restored && moved !== null) unlinkIfBytes(aside, moved.bytes);
      return {
        kind: "kept",
        why: restored
          ? `the lock changed hands during the reclaim and was put back`
          : `the lock changed hands during the reclaim and could not be put back; it is at ${basename(aside)}`,
      };
    }

    // Committed: the pending record now belongs to whichever writer holds the
    // lock next, this one or another.
    pendingOwn = null;
    // Step 6.
    unlinkIfBytes(aside, seen.bytes);
    return { kind: "reclaimed", note };
  } finally {
    if (pendingOwn !== null) unlinkIfBytes(pendingOwn.path, pendingOwn.bytes);
    unlinkIfBytes(claim.path, claim.bytes);
  }
}

/** A reclaim whose record is waiting to be appended. */
export interface PendingReclaim {
  path: string;
  bytes: Buffer;
  note: Omit<ReclaimNote, "why"> & { why?: string };
}

/**
 * The reclaims of `<logPath>.lock` whose records are not yet in the log, in name
 * order. Called by the writer that holds the lock, which appends each and then
 * {@link clearPendingReclaim}s it. A pending file this version cannot read is
 * left where it is and skipped.
 */
export function pendingReclaims(logPath: string): PendingReclaim[] {
  const directory = dirname(logPath);
  const prefix = `${basename(logPath)}.lock.reclaim-`;
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.startsWith(prefix) && name.endsWith(".pending.lock"));
  } catch {
    return [];
  }
  names.sort();
  const found: PendingReclaim[] = [];
  for (const name of names) {
    const path = join(directory, name);
    const seen = readLock(path);
    if (seen === null) continue;
    const record = parseJsonObject(seen.bytes);
    if (record === "empty" || record === null || record["v"] !== LOCK_HOLDER_VERSION || record["kind"] !== "reclaim-pending") continue;
    const note = record["note"] as Record<string, unknown> | undefined;
    if (note === undefined || typeof note !== "object" || note === null) continue;
    const { lockfile, reason, age_ms: ageMs, holder, why } = note;
    if (
      typeof lockfile !== "string" ||
      (reason !== "holder-dead" && reason !== "holder-replaced" && reason !== "holder-boot-ended" && reason !== "legacy-aged") ||
      typeof ageMs !== "number"
    ) {
      continue;
    }
    const parsedNote: PendingReclaim["note"] = { lockfile, reason, age_ms: ageMs };
    if (typeof why === "string") parsedNote.why = why;
    if (holder !== undefined) {
      if (typeof holder !== "object" || holder === null) continue;
      const { pid, op, created } = holder as Record<string, unknown>;
      if (typeof pid !== "number" || (op !== "append" && op !== "hold") || typeof created !== "string") continue;
      parsedNote.holder = { pid, op, created };
    }
    found.push({ path, bytes: Buffer.from(seen.bytes), note: parsedNote });
  }
  return found;
}

/**
 * Remove a pending reclaim once its record is in the log. Only the writer that
 * holds the lock calls this, so nobody else is removing or replacing it.
 */
export function clearPendingReclaim(pending: PendingReclaim): void {
  unlinkIfBytes(pending.path, pending.bytes);
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
 * with the lockfile in place). Returns the release, which the caller runs right
 * after the lockfile is removed.
 *
 * Node shows a caught signal to JavaScript only when the event loop turns, and
 * removing the last listener before that turn drops the signal (both measured on
 * Node 26). So the guard ends in one of two ways after the release:
 *
 * - the event loop turns (the verb returned, or it awaits): a signal that arrived
 *   while the lock was held is dispatched to the guard, which re-raises it with
 *   the default disposition, and the process dies of it with the signal's own
 *   status; or
 * - synchronous code is about to block first (a poll loop, a child process):
 *   it calls {@link settleTerminationGuards}, which removes the guard at once,
 *   so the block runs under the default disposition and a signal during it kills
 *   the process immediately, as it did before this guard existed.
 *
 * The price of the second way is the one thing Node cannot do: a signal that
 * landed while the lock was being taken or held (milliseconds: the create, a
 * reclaim, the append) and was not yet dispatched is lost, rather than held for
 * the length of the block (APRV-479, S2; the hazard in `cli/hook.ts`'s driver
 * notes is a signal held through a synchronous wait). Node exposes no
 * synchronous way to learn that a signal is pending, so the guard cannot both
 * end with the lock and deliver what it caught; it delivers whenever the event
 * loop turns first, which is every verb that returns or awaits.
 * Windows has no such signals to hold; there this is a no-op.
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

/**
 * Synchronous code about to block (an `Atomics.wait` poll, a `spawnSync`) calls
 * this first: when no lock is held and a released lock's guard is still waiting
 * for the event loop, the guard is removed now, so the block is not run with
 * termination signals held. No-op while a lock is held, and when there is no
 * guard. See {@link guardTerminationWhileLocked} for what this trades.
 */
export function settleTerminationGuards(): void {
  if (locksHeld > 0 || guards.size === 0) return;
  removeGuards();
}
