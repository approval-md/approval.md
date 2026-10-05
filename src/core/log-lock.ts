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
 * a missed one (a wedge a human clears with one command). So a holder is LIVE
 * unless this process can prove it gone, and a lock is taken back only by a
 * writer that has already waited out its whole lock timeout.
 *
 * ## What this module does
 *
 * 1. **The lockfile names its holder.** {@link createLockFile} writes one JSON
 *    line into the file it creates: pid, host, boot, on Linux the pid and time
 *    namespaces and the process start time, when the lock was taken, which kind
 *    of holder (`append` | `hold`), and a nonce. An older writer's lockfile is
 *    empty.
 * 2. **Only a regular file that parses strictly is judged.** Every read opens
 *    without blocking and without following links, and reads only a regular
 *    file of at most 4 KiB. Anything else at the lock's path (a FIFO, a link, a
 *    directory, an oversized or malformed file, a record of another version) is
 *    not this writer's to judge: it is LIVE.
 * 3. **The judgement ({@link judgeHolder}).** Gone only when the holder is in
 *    this process's own pid namespace and boot, and provably not running:
 *    - Linux: `/proc` is this namespace's (`/proc/self` names this pid), the
 *      record's boot id and pid-namespace inode equal this process's, and then
 *      `kill(pid, 0)` answers ESRCH with `/proc/<pid>` absent or a zombie, or
 *      `/proc/<pid>/stat` names a process whose start time (read in the same
 *      time namespace) is not the holder's;
 *    - elsewhere (macOS): the same hostname, boot readings within
 *      {@link BOOT_SLACK_S} seconds, and `kill(pid, 0)` answering ESRCH.
 *
 *    Everything else is LIVE: EPERM, another namespace or boot or host, a
 *    `/proc` entry that cannot be read.
 * 4. **A lockfile with no holder record** (empty: an older version's, or a
 *    writer killed between the create and the write) is gone only once its
 *    mtime is {@link LEGACY_LOCK_RECLAIM_AGE_MS} old AND this writer watched
 *    that very file (inode, mtime, size) unchanged through its own wait.
 * 5. **The reclaim ({@link reclaimStaleLock}) is two atomic steps, and nothing
 *    else is written.** The taker's own complete lockfile is written first,
 *    under `<lock>.take.<pid>.<nonce>`, so whoever finds a claim beside the
 *    lock also finds its taker and can judge it (`approval log unlock` refuses
 *    while one is seen running). Then the claim: `link(2)` of the lock's path to a name
 *    derived from the judged record, `<lock>.stale.<pid>.<created ms>`, which
 *    fails EEXIST for every other reclaimer of the same lockfile, and which is
 *    then read back to prove it names the very file that was judged (inode,
 *    mtime, bytes). Then the take: this writer's own lockfile is `rename(2)`d
 *    over the lock's path, once the claim and the lock's path are read again
 *    and are still the judged file. The lock's
 *    path is never empty, so no ordinary `wx` create slips in, and between the
 *    claim and the take nothing in the protocol can change it: the holder is
 *    dead, every other writer's create fails EEXIST, and every other
 *    reclaimer's claim fails EEXIST. (A bare `rename` of the lockfile aside
 *    cannot be made safe: a reclaimer that judged the dead lock and stalled
 *    would later move whatever live lock had replaced it.)
 * 6. **The reclaim is in the log first.** The reclaimer appends
 *    `audit.lock_reclaimed` as the first record under the lock it took
 *    (`core/log.ts`), carrying the strictly parsed pid, op and `created` and
 *    nothing else from the file, and only then unlinks the stale name.
 * 7. **A termination signal does not leave a lock behind.**
 *    {@link guardTerminationWhileLocked} is installed before a lockfile is
 *    created, and before a reclaim's claim, and held until the lock is removed: for SIGTERM, SIGINT and SIGHUP with
 *    no listener, a listener that re-raises the signal with its default
 *    disposition once the lock is released, so the process still dies of it.
 *    SIGKILL cannot be caught, which is what 1 to 6 are for.
 *
 * Never reclaimed automatically, whatever the holder: a lock beside a
 * `log sync` snapshot (a sync killed part way may have left the working log at
 * its committed bytes), and a lock beside a log that does not exist. A lock from
 * another container or boot is never reclaimed automatically either; the
 * refusal names the pid and the human verb, `approval log unlock --pid <n>`
 * ({@link takeLockForUnlock}).
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
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

/** The holder record's format version. A reader treats any other as not its to judge. */
export const LOCK_HOLDER_VERSION = 1;

/**
 * How old an empty lockfile (no holder record) must be before it is reclaimed.
 * An append holds the lock for milliseconds, and the longest holder in this
 * runtime (`approval log sync`) for seconds.
 */
export const LEGACY_LOCK_RECLAIM_AGE_MS = 10 * 60_000;

/**
 * How long a writer must have watched an empty lockfile unchanged (the same
 * inode, mtime and size since the first refusal of its wait) before it may take
 * it as `legacy-aged`. A writer of this version fills its record within
 * microseconds of its create, so an empty file that stays empty across a retry
 * interval is not one; an mtime alone can read old through a stepped clock or
 * a file server's lagging one (APRV-479 R3-8).
 */
export const LEGACY_LOCK_WATCH_MS = 20;

/**
 * Off Linux, how far apart two boot readings (`now - uptime`, in seconds) may
 * be and still count as one boot. A wall-clock step moves the reading, so a
 * larger gap is "another boot, or a stepped clock": live, never gone.
 */
export const BOOT_SLACK_S = 60;

/** The largest pid a record may name: anything past a signed 32-bit pid is no process at all. */
const MAX_PID = 2 ** 31 - 1;

/** The most bytes a lockfile may hold: a record is one short line. */
const MAX_LOCK_FILE_BYTES = 4096;

/** The one shape `created` may take: what `Date#toISOString` writes. */
const CREATED_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/**
 * `created` exactly as `Date#toISOString` writes it AND a real instant: the
 * string must survive a round trip, which `2026-02-30T00:00:00.000Z` (a shape
 * match that V8 rolls over to March 2nd) does not.
 */
export function isCanonicalTimestamp(value: string): boolean {
  if (!CREATED_SHAPE.test(value)) return false;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === value;
}

/**
 * A holder's hostname as a message may show it: the hostname charset, at most
 * 64 characters. It comes from a file another process wrote and never reaches
 * the log.
 */
function displayHost(host: string): string {
  if (host === "") return "an unnamed host";
  const shown = host.replace(/[^A-Za-z0-9._-]/gu, "?");
  return shown.length > 64 ? `${shown.slice(0, 64)}...` : shown;
}

/** `append`: one record. `hold`: a whole operation under `withAppendLock`. */
export type LockOp = "append" | "hold";

/** Who a process is, as far as a liveness judgement can use it. */
export interface HolderIdentity {
  pid: number;
  host: string;
  /** Linux: `/proc/sys/kernel/random/boot_id`. Elsewhere: `~<boot epoch seconds>`. */
  boot: string;
  /** Linux only: `/proc/self/ns/pid`. */
  pidns?: string;
  /** Linux only: field 22 of `/proc/self/stat` (clock ticks after boot, in this time namespace). */
  start?: string;
  /** Linux only, where the kernel has time namespaces: `/proc/self/ns/time`. */
  timens?: string;
}

/** What a lockfile written by this version holds, one JSON line. */
export interface LockHolder extends HolderIdentity {
  v: typeof LOCK_HOLDER_VERSION;
  /** When the lock was taken, as `Date#toISOString` writes it. */
  created: string;
  op: LockOp;
  /** Random, so two lockfiles are never byte-identical. */
  nonce: string;
}

/**
 * Why a lock was taken over: the `audit.lock_reclaimed` payload's closed
 * `reason` set. `holder-dead` and `legacy-aged` are a writer's proof;
 * `operator-cleared` is a person's assertion (`approval log unlock`), never a
 * proof, and only a `human:` actor carries it.
 */
export type LockReclaimReason = "holder-dead" | "legacy-aged" | "operator-cleared";

/**
 * The judgement on one holder record. `running` (on a live verdict): this
 * process saw the holder itself running (Linux: its start time; elsewhere: its
 * pid, on this host, in this boot). A live verdict without it is a holder this
 * process cannot check, which a human may clear with `approval log unlock`.
 */
export type HolderVerdict = { state: "gone"; why: string } | { state: "live"; why: string; running: boolean };

/** This process, as a holder record describes it. */
export interface SelfIdentity {
  pid: number;
  host: string;
  boot: string | undefined;
  pidns: string | undefined;
  start: string | undefined;
  timens?: string | undefined;
  linux: boolean;
  /**
   * Linux: whether `/proc` is this process's own pid namespace's procfs
   * (`/proc/self` names `process.pid`). `false` means no pid read from it can be
   * trusted, and every holder is live. Absent is taken as `true` (tests).
   */
  procIsOwn?: boolean;
}

/** What `/proc/<pid>/stat` said. */
export type ProcStatRead =
  | { kind: "stat"; state: string; start: string }
  /** ENOENT or ESRCH: no entry this process can see. */
  | { kind: "absent" }
  /** Anything else (EACCES, EPERM, an unparseable line): nothing can be concluded. */
  | { kind: "unreadable"; why: string };

/** `kill(pid, 0)`: `ok` (exists), `ESRCH` (no such process), `EPERM` (exists, another user's), `other`. */
export type SignalZero = "ok" | "ESRCH" | "EPERM" | "other";

/** What a liveness judgement may ask of the operating system. Injected by tests. */
export interface LivenessProbe {
  /** Linux: `/proc/<pid>/stat`, as read by this process. */
  linuxStat(pid: number): ProcStatRead;
  signalZero(pid: number): SignalZero;
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
    if (code === "ENOENT" || code === "ESRCH") return { kind: "absent" };
    return { kind: "unreadable", why: code ?? "error" };
  }
  const parsed = parseProcStat(text);
  return parsed === null ? { kind: "unreadable", why: "an unparseable stat line" } : { kind: "stat", ...parsed };
}

/** The real probe: `/proc` and `kill(pid, 0)`. */
export const NODE_LIVENESS_PROBE: LivenessProbe = {
  linuxStat: (pid) => readProcStat(`/proc/${String(pid)}/stat`),
  signalZero(pid) {
    try {
      process.kill(pid, 0);
      return "ok";
    } catch (cause) {
      const code = errnoOf(cause);
      return code === "ESRCH" ? "ESRCH" : code === "EPERM" ? "EPERM" : "other";
    }
  },
};

/**
 * Is `/proc` this process's own pid namespace's procfs? `/proc/self` resolves
 * to the reader's pid as THAT procfs numbers it, so it names `process.pid` only
 * when the procfs belongs to the namespace `process.pid` was issued in, or when
 * the pid happens to be the same number in both (APRV-479 R3-9). So the
 * `NSpid:` line of `/proc/self/status` must also hold exactly one field, this
 * pid: it lists the pid in every namespace from the procfs's own down to the
 * reader's, and one field means they are the same namespace. A kernel without
 * the line (before 4.1) proves nothing, and every holder is then live.
 */
export function procIsOwnNamespace(
  read: (path: string) => string = (path) => readlinkSync(path, "utf8"),
  pid: number = process.pid,
  status: (path: string) => string = (path) => readFileSync(path, "utf8"),
): boolean {
  try {
    if (read("/proc/self") !== String(pid)) return false;
    const line = status("/proc/self/status").split("\n").find((text) => text.startsWith("NSpid:"));
    if (line === undefined) return false;
    const fields = line.slice("NSpid:".length).trim().split(/\s+/u);
    return fields.length === 1 && fields[0] === String(pid);
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
  if (self.timens !== undefined) record.timens = self.timens;
  return record;
}

/**
 * What a lockfile's bytes say: a strictly parsed v1 record, `legacy` (empty or
 * whitespace only: no holder record at all), or `unknown` (anything else: a
 * malformed record, another version, text that is not JSON), which is never
 * judged.
 */
export function parseHolder(bytes: Buffer | string): { kind: "v1"; holder: LockHolder } | { kind: "legacy" } | { kind: "unknown" } {
  const text = (typeof bytes === "string" ? bytes : bytes.toString("utf8")).trim();
  if (text === "") return { kind: "legacy" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "unknown" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "unknown" };
  const { v, pid, host, boot, pidns, start, timens, created, op, nonce } = value as Record<string, unknown>;
  if (
    v !== LOCK_HOLDER_VERSION ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    pid > MAX_PID ||
    typeof host !== "string" ||
    typeof boot !== "string" ||
    (pidns !== undefined && typeof pidns !== "string") ||
    (start !== undefined && typeof start !== "string") ||
    (timens !== undefined && typeof timens !== "string") ||
    typeof created !== "string" ||
    !isCanonicalTimestamp(created) ||
    (op !== "append" && op !== "hold") ||
    typeof nonce !== "string"
  ) {
    return { kind: "unknown" };
  }
  const holder: LockHolder = { v: LOCK_HOLDER_VERSION, pid, host, boot, created, op, nonce };
  if (pidns !== undefined) holder.pidns = pidns;
  if (start !== undefined) holder.start = start;
  if (timens !== undefined) holder.timens = timens;
  return { kind: "v1", holder };
}

// ---------------------------------------------------------------------------
// The judgement
// ---------------------------------------------------------------------------

function bootSeconds(boot: string | undefined): number | null {
  if (boot === undefined || !/^~-?\d+$/u.test(boot)) return null;
  const seconds = Number(boot.slice(1));
  return Number.isSafeInteger(seconds) ? seconds : null;
}

/**
 * Is the process that wrote `holder` provably gone? Pure: the identity of the
 * reader and the operating system's answers are parameters. "Live" means "not
 * provably gone". The holder's boot and pid namespace are established before
 * any pid is looked up, because a pid means nothing outside the namespace it
 * was issued in.
 */
export function judgeHolder(holder: HolderIdentity, self: SelfIdentity, probe: LivenessProbe): HolderVerdict {
  const who = `pid ${String(holder.pid)} on ${displayHost(holder.host)}`;
  const live = (why: string, running = false): HolderVerdict => ({ state: "live", why: `${who} ${why}`, running });
  const gone = (why: string): HolderVerdict => ({ state: "gone", why: `${who} ${why}` });
  if (self.linux) {
    if (self.procIsOwn === false) {
      return live("cannot be checked: this process's /proc belongs to another pid namespace (/proc/self does not name it)");
    }
    if (self.boot === undefined || self.pidns === undefined) {
      return live("cannot be checked: this process cannot read its own boot id or pid namespace");
    }
    if (holder.boot === "" || holder.pidns === undefined) {
      return live("cannot be checked: its record names no Linux boot id or pid namespace");
    }
    if (holder.boot !== self.boot) {
      return live("took the lock under another boot id (an earlier boot of this host, or another host or sandbox kernel sharing this filesystem), whose processes this process cannot see");
    }
    if (holder.pidns !== self.pidns) {
      return live("is in another pid namespace (another container), whose processes this process cannot see");
    }
    const signal = probe.signalZero(holder.pid);
    const stat = probe.linuxStat(holder.pid);
    const comparable = holder.start !== undefined && holder.timens === self.timens;
    if (stat.kind === "stat" && comparable && stat.start !== holder.start) {
      return gone("has exited: the pid now names a process that started later");
    }
    const zombie = stat.kind === "stat" && (stat.state === "Z" || stat.state === "X");
    if (signal === "ESRCH" && (stat.kind === "absent" || zombie)) return gone("has exited");
    if (stat.kind === "stat" && !zombie && comparable) return live("is running", true);
    if (signal === "EPERM") return live("is running as another user, or cannot be checked (kill(pid, 0) answers EPERM)");
    if (stat.kind === "unreadable") return live(`cannot be checked: its /proc entry could not be read (${stat.why})`);
    return live("cannot be proved gone (kill(pid, 0) does not answer ESRCH, and no start time can be compared)");
  }
  if (holder.pidns !== undefined) return live("wrote its record under Linux, whose processes this process cannot see");
  if (holder.host === "" || holder.host !== self.host) {
    return live("is on another host, whose processes this process cannot see");
  }
  const theirs = bootSeconds(holder.boot);
  const ours = bootSeconds(self.boot);
  if (theirs === null || ours === null || Math.abs(theirs - ours) > BOOT_SLACK_S) {
    return live(`took the lock under another boot, or before a clock step (boot readings more than ${String(BOOT_SLACK_S)} s apart), so its pid proves nothing here`);
  }
  const signal = probe.signalZero(holder.pid);
  if (signal === "ESRCH") return gone("has exited");
  if (signal === "EPERM") return live("is running as another user (kill(pid, 0) answers EPERM)", true);
  if (signal === "ok") return live("is running (this platform cannot read its start time, so the pid is taken to be the holder)", true);
  return live("cannot be checked (kill(pid, 0) failed)");
}

let judgeForTests: ((holder: HolderIdentity) => HolderVerdict) | null = null;

/**
 * Replace the liveness judgement (tests only: the pin that a live holder's
 * lock survives only because of the check). `null` restores the real one.
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
  /** The owner's uid: what a refusal names when the claim is refused EPERM. */
  uid: number;
  bytes: Buffer;
}

/** `O_RDONLY | O_NONBLOCK | O_NOFOLLOW`: an open must never block (a FIFO) and never follow a link. */
const SAFE_OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);

type EntryRead = { kind: "absent" } | { kind: "unreadable"; why: string } | { kind: "file"; seen: SeenLock };

/**
 * Read one name beside the log as hostile input: opened without blocking or
 * following links, accepted only when the opened descriptor is a regular file
 * of at most {@link MAX_LOCK_FILE_BYTES}, read through that one descriptor.
 */
function readEntry(path: string): EntryRead {
  let fd: number;
  try {
    fd = openSync(path, SAFE_OPEN_FLAGS);
  } catch (cause) {
    const code = errnoOf(cause);
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "unreadable", why: code === "ELOOP" || code === "EMLINK" ? "a symbolic link" : (code ?? "an open error") };
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) return { kind: "unreadable", why: "not a regular file" };
    if (stat.size > BigInt(MAX_LOCK_FILE_BYTES)) return { kind: "unreadable", why: "larger than any record" };
    const buffer = Buffer.alloc(MAX_LOCK_FILE_BYTES);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read <= 0) break;
      length += read;
      if (length >= buffer.length) break;
    }
    return {
      kind: "file",
      seen: { ino: stat.ino, mtimeNs: stat.mtimeNs, mtimeMs: Number(stat.mtimeMs), uid: Number(stat.uid), bytes: buffer.subarray(0, length) },
    };
  } catch (cause) {
    return { kind: "unreadable", why: errnoOf(cause) ?? "a read error" };
  } finally {
    closeSync(fd);
  }
}

/**
 * The same file with the same contents: inode, mtime to the nanosecond, and
 * bytes. A v1 record carries a random nonce, and an empty lockfile is judged
 * only once its mtime is ten minutes old, so a later file never matches.
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

/** Where a test may act inside the lock's protocol. Nothing in `src/` sets one. */
export type LockStep = "after-open" | "judged" | "claimed" | "before-take";

let seamForTests: ((step: LockStep) => void) | null = null;

/** Run `seam` at each named step (tests only: a stall, a signal, a planted file). `null` removes it. */
export function setLockSeamForTests(seam: ((step: LockStep) => void) | null): void {
  seamForTests = seam;
}

function step(name: LockStep): void {
  if (seamForTests !== null) seamForTests(name);
}

/** The lock this process created or took: enough to release only that one. */
export interface OwnLock {
  path: string;
  ino: bigint;
  bytes: Buffer;
}

/**
 * Create `path` with `wx` and write this process's holder record into it.
 * Throws what `openSync` throws, so `EEXIST` means another writer holds it. A
 * record that cannot be written leaves an empty lockfile, which is still a lock.
 * The caller installs the signal guard BEFORE calling this.
 */
export function createLockFile(path: string, op: LockOp): OwnLock {
  const fd = openSync(path, "wx");
  let bytes = Buffer.alloc(0);
  let ino = 0n;
  try {
    step("after-open");
    try {
      ino = fstatSync(fd, { bigint: true }).ino;
    } catch {
      ino = 0n;
    }
    const line = Buffer.from(`${JSON.stringify(holderRecord(op))}\n`, "utf8");
    try {
      if (writeSync(fd, line, 0, line.length) === line.length) bytes = line;
    } catch {
      // The lock is held either way; an empty file reads as unattributed.
    }
  } finally {
    closeSync(fd);
  }
  return { path, ino, bytes };
}

/**
 * Remove the lock this process holds, and only it: anything else at the path
 * (another inode, other bytes) is left where it is.
 */
export function releaseLockFile(own: OwnLock): void {
  const entry = readEntry(own.path);
  if (entry.kind !== "file") return;
  if (own.ino !== 0n && entry.seen.ino !== own.ino) return;
  if (own.bytes.length > 0 && !entry.seen.bytes.equals(own.bytes)) return;
  unlinkQuietly(own.path);
}

// ---------------------------------------------------------------------------
// The reclaim
// ---------------------------------------------------------------------------

/** What an `audit.lock_reclaimed` record says, and the stale name to unlink once it is in the log. */
export interface ReclaimNote {
  /** The lockfile's base name. */
  lockfile: string;
  reason: LockReclaimReason;
  /**
   * From a v1 record only: the strictly parsed pid, op and `created`. `created`
   * is `null` when it is not plausible ({@link plausibleCreated}).
   */
  holder?: { pid: number; op: LockOp; created: string | null };
  /**
   * How long the lock had been held, from `created` (or an empty lockfile's
   * mtime), by this process's clock. Absent exactly when `created` is `null`.
   */
  age_ms?: number;
  /** The claim name, removed after the record lands. Never recorded. */
  stale: string;
  /** One line for a person. Never recorded. */
  why: string;
}

/** How far before the log's last record a holder's `created` may lie and still be recorded. */
export const CREATED_BEFORE_LAST_RECORD_MS = 24 * 60 * 60_000;

/** How far past this process's clock a holder's `created` may lie and still be recorded. */
export const CREATED_AFTER_NOW_MS = 5 * 60_000;

/**
 * The record of a reclaim carries a holder's `created` (and the age derived
 * from it) only when it is plausible: no earlier than the log's last record's
 * `ts` minus {@link CREATED_BEFORE_LAST_RECORD_MS}, and no later than now plus
 * {@link CREATED_AFTER_NOW_MS}. Anything else is a value the file chose (any
 * canonical instant parses, year 0000 and 9999 included), so the record says
 * `created: null` and carries no age. With no last record to measure from, no
 * `created` is plausible. (APRV-479 R3-7, the stricter rule.)
 */
export function plausibleCreated(note: ReclaimNote, lastTs: number | null, now: number): ReclaimNote {
  if (note.holder === undefined || note.holder.created === null) return note;
  const at = Date.parse(note.holder.created);
  if (lastTs !== null && at >= lastTs - CREATED_BEFORE_LAST_RECORD_MS && at <= now + CREATED_AFTER_NOW_MS) return note;
  const bounded: ReclaimNote = { lockfile: note.lockfile, reason: note.reason, holder: { ...note.holder, created: null }, stale: note.stale, why: note.why };
  return bounded;
}

/** What the writer knows about the log before it claims: whether it could record a reclaim at all, and its last record's time. */
export type RecordContext = { ok: true; lastTs: number | null } | { ok: false; why: string };

/** What {@link reclaimStaleLock} found and did. */
export type ReclaimOutcome =
  /** This process now holds the lock and must record `note` first. */
  | { kind: "taken"; own: OwnLock; releaseGuard: () => void; note: ReclaimNote }
  /** The lock moved, or another writer is reclaiming it: wait again. */
  | { kind: "retry"; why: string }
  /** The lock stays where it is; `why` names its holder and the human command. */
  | { kind: "kept"; why: string };

/** The human verb, as a refusal names it. */
export function unlockCommand(pid: number | null): string {
  return `approval log unlock --pid ${pid === null ? "none" : String(pid)}`;
}

/** A lockfile as a writer saw it at the first refusal of its wait (R3-8). */
export interface LockObservation {
  ino: bigint;
  mtimeNs: bigint;
  size: bigint;
  /** When it was seen, by this process's clock. */
  at: number;
}

/** What is at `<logPath>.lock` now, without opening it: a regular file's identity, or `null`. */
export function observeLock(logPath: string, now: number = Date.now()): LockObservation | null {
  try {
    const stat = lstatSync(`${logPath}.lock`, { bigint: true });
    return stat.isFile() ? { ino: stat.ino, mtimeNs: stat.mtimeNs, size: stat.size, at: now } : null;
  } catch {
    return null;
  }
}

/** The judgement of a lockfile's bytes. */
type LockJudgement =
  | { kind: "gone"; note: ReclaimNote }
  /** An empty lockfile that is not the one this writer watched: wait again. */
  | { kind: "changed"; why: string }
  | { kind: "kept"; why: string; pid: number | null; running: boolean }
  | { kind: "unjudgeable"; why: string };

function staleName(lockPath: string, holder: LockHolder | null, seen: SeenLock): string {
  return holder === null
    ? `${lockPath}.stale.legacy.${seen.mtimeNs.toString()}`
    : `${lockPath}.stale.${String(holder.pid)}.${String(Date.parse(holder.created))}`;
}

function noteFor(lockPath: string, holder: LockHolder | null, seen: SeenLock, now: number, reason: LockReclaimReason, why: string): ReclaimNote {
  const from = holder === null ? seen.mtimeMs : Date.parse(holder.created);
  const ageMs = Math.max(0, Math.round(now - from));
  const note: ReclaimNote = {
    lockfile: basename(lockPath),
    reason,
    age_ms: Number.isSafeInteger(ageMs) ? ageMs : 0,
    stale: staleName(lockPath, holder, seen),
    why,
  };
  if (holder !== null) note.holder = { pid: holder.pid, op: holder.op, created: holder.created };
  return note;
}

function judgeLock(lockPath: string, seen: SeenLock, now: number, watched: LockObservation | null): LockJudgement {
  const lockfile = basename(lockPath);
  const parsed = parseHolder(seen.bytes);
  if (parsed.kind === "unknown") {
    return { kind: "unjudgeable", why: `${lockfile} does not hold a holder record this version reads` };
  }
  if (parsed.kind === "legacy") {
    const ageS = Math.round(Math.max(0, now - seen.mtimeMs) / 1000);
    if (now - seen.mtimeMs < LEGACY_LOCK_RECLAIM_AGE_MS) {
      return {
        kind: "kept",
        why: `${lockfile} names no holder (an older version's, or a writer killed between creating it and writing its record) and is ${String(ageS)} s old; it is reclaimed at ${String(LEGACY_LOCK_RECLAIM_AGE_MS / 60_000)} minutes`,
        pid: null,
        running: false,
      };
    }
    // R3-8: an old mtime is not enough. The very file (inode, mtime, size)
    // must have sat unchanged across this writer's own wait.
    if (watched === null || watched.ino !== seen.ino || watched.mtimeNs !== seen.mtimeNs || watched.size !== BigInt(seen.bytes.length)) {
      return { kind: "changed", why: `${lockfile} names no holder, and is not the file this writer saw when its wait began` };
    }
    if (now - watched.at < LEGACY_LOCK_WATCH_MS) {
      return {
        kind: "kept",
        why: `${lockfile} names no holder and is ${String(ageS)} s old by its mtime, but this writer did not wait to see it stay unchanged (a try-once caller never takes an empty lockfile; a writer that waits does)`,
        pid: null,
        running: false,
      };
    }
    return { kind: "gone", note: noteFor(lockPath, null, seen, now, "legacy-aged", `${lockfile} names no holder and is ${String(ageS)} s old`) };
  }
  const verdict = judge(parsed.holder);
  if (verdict.state === "live") {
    return { kind: "kept", why: `held by ${verdict.why} (${parsed.holder.op}, since ${parsed.holder.created})`, pid: parsed.holder.pid, running: verdict.running };
  }
  return { kind: "gone", note: noteFor(lockPath, parsed.holder, seen, now, "holder-dead", verdict.why) };
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Why a claim failed, for a person: a link refused EPERM or EACCES (Linux
 * `fs.protected_hardlinks`: a file the claimant neither owns nor can read and
 * write) can be made only by the lockfile's owner or root.
 */
function claimFailure(lockPath: string, seen: SeenLock, code: string, unlock: string): string {
  if (code !== "EPERM" && code !== "EACCES") return `the claim on ${basename(lockPath)} failed (link: ${code}); a human runs \`${unlock}\``;
  return `the claim on ${basename(lockPath)} failed (link: ${code}): it is owned by uid ${String(seen.uid)}, and only that user or root may link it; run \`${unlock}\` as that user or root, or \`rm -v ${lockPath}\` once no writer runs`;
}

/** A directory at the stale name, which neither a writer nor `approval log unlock` removes. */
function staleDirectory(stale: string): string {
  return `${basename(stale)} is a directory, so no claim can be made there; once no writer is running, a human removes it (\`rm -r ${stale}\`) and runs \`approval log unlock\` again`;
}

/** What a claim found. */
type Claim =
  | { kind: "claimed" }
  /** The lock's path no longer holds the judged file. */
  | { kind: "moved" }
  /**
   * The stale name is taken while the lock's path still holds the judged file.
   * `judged`: by that same file (another reclaimer's claim). `directory`: by a
   * directory, which no unlink removes.
   */
  | { kind: "occupied"; judged: boolean; directory: boolean }
  | { kind: "failed"; code: string };

/**
 * The claim: `link(2)` the lock's path to `stale`, which exactly one reclaimer
 * of a given lockfile can do, then read the new name back and prove it is the
 * judged file.
 */
function claim(lockPath: string, seen: SeenLock, stale: string): Claim {
  try {
    linkSync(lockPath, stale);
  } catch (cause) {
    const code = errnoOf(cause);
    if (code === "ENOENT") return { kind: "moved" };
    if (code !== "EEXIST") return { kind: "failed", code: code ?? "an error" };
    const now = readEntry(lockPath);
    if (now.kind !== "file" || !sameLock(now.seen, seen)) return { kind: "moved" };
    const there = readEntry(stale);
    return { kind: "occupied", judged: there.kind === "file" && sameLock(there.seen, seen), directory: isDirectory(stale) };
  }
  const there = readEntry(stale);
  if (there.kind !== "file" || !sameLock(there.seen, seen)) {
    // The lock's path held another file by the time of the link: this name is
    // this process's own second name for it, and removing it touches nothing.
    unlinkQuietly(stale);
    return { kind: "moved" };
  }
  return { kind: "claimed" };
}

/** This process's own complete lockfile, written under a name only it uses, before its claim. */
interface PreparedTake {
  temporary: string;
  own: OwnLock;
}

/**
 * Write this process's complete lockfile to `<lock>.take.<pid>.<nonce>`. It is
 * written BEFORE the claim, so anyone who finds a claim beside the lock also
 * finds the taker that made it, and can judge whether that taker is running
 * ({@link scanTakers}). The caller has installed the signal guard.
 */
function prepareTake(lockPath: string, op: LockOp): { ok: true; prepared: PreparedTake } | { ok: false; why: string } {
  const temporary = `${lockPath}.take.${String(process.pid)}.${randomBytes(8).toString("hex")}`;
  try {
    const own = createLockFile(temporary, op);
    if (own.bytes.length === 0) throw new Error("its holder record could not be written");
    return { ok: true, prepared: { temporary, own } };
  } catch (cause) {
    unlinkQuietly(temporary);
    return { ok: false, why: (cause as Error).message };
  }
}

/**
 * The take: `rename(2)` this process's prepared lockfile over the lock's path,
 * which holds the claimed file. Right before the rename, the claim and the
 * lock's path are read again and must both still be the judged file: a claim
 * a person's unlock removed, or a lock that changed hands, is seen here and
 * nothing is moved. (Not atomic with the rename; it narrows the window, and
 * {@link scanTakers} is what keeps a person from making it.) The signal guard
 * was installed by the caller before its claim (the claim is the reclaim's
 * first durable state) and is handed back with the lock. On failure the guard
 * is released, and the claim with it when it is still this process's.
 */
function take(
  lockPath: string,
  prepared: PreparedTake,
  stale: string,
  seen: SeenLock,
  releaseGuard: () => void,
): { ok: true; own: OwnLock; releaseGuard: () => void } | { ok: false; moved: boolean; why: string } {
  const fail = (moved: boolean, why: string): { ok: false; moved: boolean; why: string } => {
    unlinkQuietly(prepared.temporary);
    releaseGuard();
    settleTerminationGuards();
    return { ok: false, moved, why };
  };
  try {
    step("before-take");
    const claimed = readEntry(stale);
    const current = readEntry(lockPath);
    if (claimed.kind !== "file" || !sameLock(claimed.seen, seen) || current.kind !== "file" || !sameLock(current.seen, seen)) {
      // Not this process's claim any more (or not the judged lock): leave both names as they are.
      return fail(true, "its claim, or the lock it claimed, is no longer the file it judged");
    }
    renameSync(prepared.temporary, lockPath);
    return { ok: true, own: { path: lockPath, ino: prepared.own.ino, bytes: prepared.own.bytes }, releaseGuard };
  } catch (cause) {
    unlinkQuietly(stale);
    return fail(false, (cause as Error).message);
  }
}

/** The most `<lock>.take.*` names judged in one look; more is "cannot rule out a reclaim in flight". */
const MAX_TAKERS_JUDGED = 16;

/** A reclaim's own lockfile beside the lock, and the judgement of the process that wrote it. */
interface Taker {
  name: string;
  /** `running`: seen running (never unlocked around). `gone`: provably exited. `unchecked`: anything else. */
  verdict: "running" | "gone" | "unchecked";
  why: string;
}

/**
 * Every `<lock>.take.<pid>.*` beside the lock except `except`, each judged by
 * the same liveness rule as a lock's holder. A reclaimer writes it before its
 * claim, so a claim found at a stale name has its taker here.
 */
function scanTakers(lockPath: string, except: string | null): { ok: true; takers: Taker[] } | { ok: false; why: string } {
  const dir = dirname(lockPath);
  const prefix = `${basename(lockPath)}.take.`;
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.startsWith(prefix) && join(dir, name) !== except);
  } catch (cause) {
    return { ok: false, why: `the log directory could not be listed (${errnoOf(cause) ?? "an error"})` };
  }
  if (names.length > MAX_TAKERS_JUDGED) {
    return { ok: false, why: `more than ${String(MAX_TAKERS_JUDGED)} \`${prefix}*\` files are beside the lock` };
  }
  const takers: Taker[] = [];
  for (const name of names.sort()) {
    const entry = readEntry(join(dir, name));
    if (entry.kind === "absent") continue;
    if (entry.kind === "unreadable") {
      takers.push({ name, verdict: "unchecked", why: `${name} is ${entry.why}` });
      continue;
    }
    const parsed = parseHolder(entry.seen.bytes);
    if (parsed.kind !== "v1") {
      takers.push({ name, verdict: "unchecked", why: `${name} holds no holder record this version reads` });
      continue;
    }
    const verdict = judge(parsed.holder);
    takers.push({ name, verdict: verdict.state === "gone" ? "gone" : verdict.running ? "running" : "unchecked", why: verdict.why });
  }
  return { ok: true, takers };
}

/** The refusal for a reclaim in flight whose taker is running. */
function inFlight(lockfile: string, taker: Taker): string {
  return `a reclaim of ${lockfile} is in flight (${taker.name}): ${taker.why}; let it finish, or stop that process, rather than unlock`;
}

/** Options for {@link reclaimStaleLock}. */
export interface ReclaimOptions {
  now?: number;
  /** The writer's own write-boundary check of the record it would append: a reclaim it would refuse is not made. */
  recordValid?: (note: ReclaimNote) => boolean;
  /**
   * The lockfile as this writer saw it at the first refusal of this wait
   * ({@link observeLock}). An empty lockfile is taken only when it is that
   * same file, watched for at least {@link LEGACY_LOCK_WATCH_MS}.
   */
  watched?: LockObservation | null;
  /**
   * Can this writer append at all right now (its daemon stamp, the log's
   * tail), and when was the log's last record? Asked before the claim, so a
   * reclaim whose record would be refused is never made; the last record's
   * time bounds the `created` the record may carry ({@link plausibleCreated}).
   * Absent: appendable, with no last record to measure from.
   */
  recordContext?: () => RecordContext;
}

/**
 * Judge `<logPath>.lock` once and, when its holder is provably gone, take it:
 * claim, prove the claim, take. Called by a writer only after its whole lock
 * timeout has passed. Nothing is written but the stale name (the claim) and
 * this writer's own lockfile.
 */
export function reclaimStaleLock(logPath: string, op: LockOp, options: ReclaimOptions = {}): ReclaimOutcome {
  const lockPath = `${logPath}.lock`;
  const lockfile = basename(lockPath);
  const entry = readEntry(lockPath);
  if (entry.kind === "absent") return { kind: "retry", why: `${lockfile} was released` };
  if (entry.kind === "unreadable") {
    return {
      kind: "kept",
      why: `${lockfile} is ${entry.why}, not a lockfile any writer made, so it is not this writer's to judge; once no writer is running, a human removes it (\`rm -v ${lockPath}\`)`,
    };
  }
  const now = options.now ?? Date.now();
  const judged = judgeLock(lockPath, entry.seen, now, options.watched ?? null);
  if (judged.kind === "changed") return { kind: "retry", why: judged.why };
  if (judged.kind === "unjudgeable") {
    return { kind: "kept", why: `${judged.why}, so it is not this writer's to judge; once no writer is running, a human removes it (\`rm -v ${lockPath}\`)` };
  }
  if (judged.kind === "kept") {
    const human = judged.running
      ? "a running holder's lock is never taken"
      : `a holder this process cannot check is never reclaimed automatically; once it is known to be gone, a human runs \`${unlockCommand(judged.pid)}\``;
    return { kind: "kept", why: `${judged.why}; ${human}` };
  }
  const unlock = unlockCommand(judged.note.holder?.pid ?? null);
  if (existsSync(`${logPath}.sync-snapshot`)) {
    return {
      kind: "kept",
      why: `${judged.note.why}, but a log sync snapshot is beside the log, so a sync may have stopped part way; run \`approval log verify\` and \`approval log sync\`, then \`${unlock}\``,
    };
  }
  if (!existsSync(logPath)) {
    return { kind: "kept", why: `${judged.note.why}, but the log itself is absent, so there is nothing a reclaim record could follow; a human runs \`${unlock}\`` };
  }
  const context = options.recordContext?.() ?? { ok: true, lastTs: null };
  if (!context.ok) {
    return { kind: "kept", why: `${judged.note.why}, but this writer could not record the reclaim (${context.why}), so the lock is kept for a writer that can` };
  }
  const note = plausibleCreated(judged.note, context.lastTs, now);
  if (options.recordValid !== undefined && !options.recordValid(note)) {
    return { kind: "kept", why: `${note.why}, but the record of its reclaim would not be valid, so it is kept; a human runs \`${unlock}\`` };
  }
  step("judged");
  // The claim is the reclaim's first durable state: a termination signal from
  // here on is held until the lock this reclaim takes is released, or settled
  // at once on every path that takes nothing.
  const releaseGuard = guardTerminationWhileLocked();
  const prepared = prepareTake(lockPath, op);
  if (!prepared.ok) {
    releaseGuard();
    settleTerminationGuards();
    return { kind: "kept", why: `${note.why}, but this writer could not write its own lockfile (${prepared.why})` };
  }
  const claimed = claim(lockPath, entry.seen, note.stale);
  if (claimed.kind !== "claimed") {
    unlinkQuietly(prepared.prepared.temporary);
    releaseGuard();
    settleTerminationGuards();
  }
  switch (claimed.kind) {
    case "moved":
      return { kind: "retry", why: `${lockfile} changed hands while it was being judged` };
    case "occupied": {
      if (claimed.directory) return { kind: "kept", why: `${note.why}, but ${staleDirectory(note.stale)}` };
      if (!claimed.judged) {
        return { kind: "kept", why: `${note.why}, but ${basename(note.stale)} already exists and is not that lockfile, so no writer can claim the reclaim; once no writer is running, \`${unlock}\` clears both` };
      }
      // The claimant wrote its own lockfile before its claim: a running one is
      // waited for, and the human verb is named only when none is seen running.
      const takers = scanTakers(lockPath, null);
      const running = takers.ok ? takers.takers.find((taker) => taker.verdict === "running") : undefined;
      return running !== undefined
        ? { kind: "retry", why: `${note.why}, and ${inFlight(lockfile, running)}` }
        : { kind: "retry", why: `${note.why}, and another writer has claimed its reclaim (${basename(note.stale)}); if no writer is running, \`${unlock}\` finishes it` };
    }
    case "failed":
      return { kind: "kept", why: `${note.why}, but ${claimFailure(lockPath, entry.seen, claimed.code, unlock)}` };
    case "claimed":
      break;
  }
  step("claimed");
  const taken = take(lockPath, prepared.prepared, note.stale, entry.seen, releaseGuard);
  if (!taken.ok) {
    return taken.moved
      ? { kind: "retry", why: `${lockfile} changed hands before this writer's take (${taken.why})` }
      : { kind: "kept", why: `${note.why}, but this writer could not take the lock (${taken.why})` };
  }
  return { kind: "taken", own: taken.own, releaseGuard: taken.releaseGuard, note };
}

/** The stale name of a reclaim whose record is now in the log. */
export function finishReclaim(note: ReclaimNote): void {
  unlinkQuietly(note.stale);
}

/** What {@link takeLockForUnlock} found and did. */
export type UnlockOutcome =
  | { kind: "taken"; own: OwnLock; releaseGuard: () => void; note: ReclaimNote }
  | { kind: "none" }
  | { kind: "refused"; why: string };

/**
 * `approval log unlock --pid <n|none>`: a human's take of a lock no writer
 * reclaims (another container, another boot, a pid that cannot be checked, a
 * claim whose reclaimer died, a planted stale name). The human asserts that no
 * writer is running; this refuses only what it can see is wrong: a `--pid`
 * that is not the record's, a holder it sees running, a lock beside a sync
 * snapshot, and anything at the lock's path that is not a lockfile (which `rm`
 * removes). It takes the lock with the same claim and take as a writer's
 * reclaim, so the record of it (reason `operator-cleared`) is the first under
 * the lock it takes.
 */
export function takeLockForUnlock(logPath: string, expected: number | null, lastTs: number | null = null, now: number = Date.now()): UnlockOutcome {
  const lockPath = `${logPath}.lock`;
  const lockfile = basename(lockPath);
  const entry = readEntry(lockPath);
  if (entry.kind === "absent") return { kind: "none" };
  if (entry.kind === "unreadable") {
    return { kind: "refused", why: `${lockfile} is ${entry.why}, not a lockfile; remove it by hand (\`rm -v ${lockPath}\`)` };
  }
  const parsed = parseHolder(entry.seen.bytes);
  if (parsed.kind === "unknown") {
    return { kind: "refused", why: `${lockfile} does not hold a holder record this version reads; remove it by hand (\`rm -v ${lockPath}\`)` };
  }
  const holder = parsed.kind === "v1" ? parsed.holder : null;
  const pid = holder?.pid ?? null;
  if (pid !== expected) {
    return {
      kind: "refused",
      why: `${lockfile} ${pid === null ? "names no holder" : `names pid ${String(pid)}`}, not ${expected === null ? "none" : `pid ${String(expected)}`}; nothing was touched (\`${unlockCommand(pid)}\` names it)`,
    };
  }
  if (existsSync(`${logPath}.sync-snapshot`)) {
    return { kind: "refused", why: "a log sync snapshot is beside the log, so a sync may have stopped part way; run `approval log verify` and `approval log sync` first" };
  }
  let why = `${lockfile} names no holder`;
  if (holder !== null) {
    const verdict = judge(holder);
    if (verdict.state === "live" && verdict.running) {
      return { kind: "refused", why: `held by ${verdict.why}; stop that process, or let it finish, rather than unlock its lock` };
    }
    why = verdict.why;
  }
  // A reclaim in flight: its taker's own lockfile is beside the lock before its
  // claim is. The person cannot tell a stopped reclaimer from a dead one; this
  // can, so a running one is refused here rather than left to their word.
  const before = scanTakers(lockPath, null);
  if (!before.ok) return { kind: "refused", why: `${before.why}, so a reclaim in flight cannot be ruled out; nothing was touched` };
  const busy = before.takers.find((taker) => taker.verdict === "running");
  if (busy !== undefined) return { kind: "refused", why: inFlight(lockfile, busy) };
  const note = plausibleCreated(noteFor(lockPath, holder, entry.seen, now, "operator-cleared", why), lastTs, now);
  // As in a writer's reclaim: guarded from the take's own lockfile and the claim on.
  const releaseGuard = guardTerminationWhileLocked();
  const prepared = prepareTake(lockPath, "hold");
  if (!prepared.ok) {
    releaseGuard();
    settleTerminationGuards();
    return { kind: "refused", why: `the lock could not be taken (${prepared.why})` };
  }
  const refuse = (text: string): UnlockOutcome => {
    unlinkQuietly(prepared.prepared.temporary);
    releaseGuard();
    settleTerminationGuards();
    return { kind: "refused", why: text };
  };
  let claimed = claim(lockPath, entry.seen, note.stale);
  if (claimed.kind === "occupied") {
    // Judged again now that a claim is known to exist: its taker wrote its own
    // lockfile before claiming, so a running one is found here.
    const again = scanTakers(lockPath, prepared.prepared.temporary);
    if (!again.ok) return refuse(`${again.why}, so a reclaim in flight cannot be ruled out; nothing was touched`);
    const busyNow = again.takers.find((taker) => taker.verdict === "running");
    if (busyNow !== undefined) return refuse(inFlight(lockfile, busyNow));
    if (claimed.directory) return refuse(staleDirectory(note.stale));
    // A dead reclaimer's claim, or a planted file: the human says no writer is
    // running, so it goes, and the claim is made again, exclusively.
    unlinkQuietly(note.stale);
    claimed = claim(lockPath, entry.seen, note.stale);
  }
  if (claimed.kind === "moved") return refuse(`${lockfile} changed hands while it was being read: a writer is running; nothing was touched`);
  if (claimed.kind === "failed") return refuse(claimFailure(lockPath, entry.seen, claimed.code, unlockCommand(pid)));
  if (claimed.kind !== "claimed") return refuse(claimed.directory ? staleDirectory(note.stale) : `the claim on ${lockfile} failed (its stale name is taken again)`);
  const taken = take(lockPath, prepared.prepared, note.stale, entry.seen, releaseGuard);
  if (!taken.ok) return { kind: "refused", why: `the lock could not be taken (${taken.why})` };
  // Dead reclaimers' own lockfiles: their writers are provably gone, so
  // nothing would ever move them. Anything not provably gone stays.
  const after = scanTakers(lockPath, null);
  if (after.ok) for (const taker of after.takers) if (taker.verdict === "gone") unlinkQuietly(join(dirname(lockPath), taker.name));
  return { kind: "taken", own: taken.own, releaseGuard: taken.releaseGuard, note };
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
 * The guard's listener. It runs only on the event loop, and this process holds
 * a lock only inside synchronous code, so no lock is held here. Put the default
 * disposition back and raise the signal again, unless somebody else registered
 * a listener meanwhile, which then owns the outcome.
 */
function reraise(signal: NodeJS.Signals): void {
  removeGuards();
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

function scheduleGuardRemoval(): void {
  if (removalScheduled) return;
  removalScheduled = true;
  // Two hops cross a poll phase from any phase, so a signal that arrived while
  // the lock was held is dispatched to the guard before the guard goes:
  // removing the last listener first would drop it (APRV-478's notes).
  setImmediate(() => {
    setImmediate(() => {
      removalScheduled = false;
      if (locksHeld === 0) removeGuards();
    });
  });
}

/**
 * Hold SIGTERM, SIGINT and SIGHUP from just before a lockfile is created until
 * just after it is removed, for each signal nobody listens for (the default
 * disposition would kill the process with the lockfile in place). Returns the
 * release.
 *
 * Node shows a caught signal to JavaScript only when the event loop turns, and
 * removing the last listener before that turn drops it. So after the release:
 * a verb that returns or awaits dies of the signal at its next turn;
 * `approval run` awaits {@link yieldToTerminationSignals} before it spawns, so
 * a stop request during its append ends it first; and a synchronous wait calls
 * {@link settleTerminationGuards} before it blocks, so the wait runs under the
 * default disposition, at the price of losing a signal that landed in the
 * append's own milliseconds. A create that fails EEXIST releases and settles at
 * once, so a lock wait runs unguarded (a signal there kills at once, holding
 * nothing).
 *
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
 * this first: when no lock is held, the guard is removed now, so the block is
 * not run with termination signals held. No-op while a lock is held.
 */
export function settleTerminationGuards(): void {
  if (locksHeld > 0 || guards.size === 0) return;
  removeGuards();
}

/**
 * Turn the event loop past a poll phase, so a termination signal a released
 * lock's guard caught is dispatched now and the process dies of it here,
 * before the caller starts whatever it was about to start.
 */
export async function yieldToTerminationSignals(): Promise<void> {
  if (guards.size === 0) return;
  await new Promise<void>((resolve) => {
    setImmediate(() => {
      setImmediate(resolve);
    });
  });
}
