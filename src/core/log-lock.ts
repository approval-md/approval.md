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
 *    bytes) and the claim, twice, and rename the lockfile to a pending name
 *    beside it: that rename is the commit point. The winner then takes the lock with the same `wx` create
 *    every writer uses, so a writer that wins that create first is ordinary
 *    contention.
 * 5. **The reclaim is in the log, always first, and cannot be lost.** The
 *    commit point renames the judged lockfile into `<lock>.d/pending/`, and
 *    `core/log.ts` records every pending file as `audit.lock_reclaimed` as the
 *    first write under whichever lock comes next, the reclaimer's or another
 *    writer's, from a fresh read of the tail. A pending file that re-judges
 *    cleanly yields a record built from that judgement; one that cannot be
 *    judged (another namespace, unreadable, malformed, not a regular file) is
 *    still recorded, as `unverified`, with nothing taken from it, and moved to
 *    `quarantine/`. A writer that cannot list `pending/` appends nothing. The
 *    caller's own compare-and-append (SPEC.md §11.1 invariant 5) then sees a
 *    moved head and re-reads, as it would after any other writer's record.
 * 5a. **Everything under the log directory is hostile input.** Every file this
 *    module reads is opened without blocking and without following links, and
 *    read only when the opened descriptor is a regular file of at most 4 KiB; a
 *    scan reads at most 64 names from `pending/` and records at most 16.
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
  constants as fsConstants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Dir } from "node:fs";
import { hostname, uptime } from "node:os";
import { basename, join } from "node:path";

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

/**
 * The largest pid a record may name (Linux's PID_MAX_LIMIT is 2^22; anything
 * past a signed 32-bit pid is no process at all).
 */
const MAX_PID = 2 ** 31 - 1;

/**
 * The one shape a holder record's `created` may take: what `Date#toISOString`
 * writes. Lockfiles sit in a directory other processes can write, and
 * `created` is the one free-text field of a record that reaches the log
 * (`audit.lock_reclaimed`'s `holder.created`) and a refusal message, so
 * anything else makes the record unreadable, and an unreadable record is never
 * reclaimed (security review of fix round 1).
 */
const CREATED_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/**
 * `created` exactly as `Date#toISOString` writes it AND a real instant: the
 * string must survive a round trip, which `2026-02-30T00:00:00.000Z` (a shape
 * match that V8 rolls over to March 2nd) does not (APRV-479 round 2, RB2).
 */
export function isCanonicalTimestamp(value: string): boolean {
  if (!CREATED_SHAPE.test(value)) return false;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === value;
}

/**
 * A holder's hostname as a message may show it: the hostname charset, at most
 * 64 characters. It comes from a file another process wrote, never reaches the
 * log, and must not carry control characters or escapes into a terminal.
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
 * Why a lock was reclaimed, as this writer judged it. With `unverified` (a
 * pending reclaim this writer could not judge, recorded with nothing taken from
 * it) these are the `audit.lock_reclaimed` payload's closed `reason` set.
 */
export type LockReclaimReason = "holder-dead" | "holder-replaced" | "legacy-aged";

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
    pid > MAX_PID ||
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
    !isCanonicalTimestamp(created) ||
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
  const who = `pid ${String(holder.pid)} on ${displayHost(holder.host)}`;
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

/** The most bytes any file this module reads may hold: a record is one short line. */
const MAX_LOCK_FILE_BYTES = 4096;

/**
 * `O_RDONLY | O_NONBLOCK | O_NOFOLLOW`: every file under the log directory is
 * written by whoever can write that directory, so an open must never block (a
 * FIFO with no writer would hang the opener forever) and never follow a link
 * (APRV-479 round 2, RB1). Platforms without a flag get 0 for it.
 */
const SAFE_OPEN_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);

/** What a read of one name under the log directory found. */
type EntryRead =
  | { kind: "absent" }
  /** Something is there that this module will not read: a FIFO, socket, device, directory, link, an oversized or unreadable file. */
  | { kind: "unreadable"; why: string }
  | { kind: "file"; seen: SeenLock };

/**
 * Read one file under the log directory as hostile input: opened without
 * blocking or following links, accepted only when the opened descriptor is a
 * regular file of at most {@link MAX_LOCK_FILE_BYTES}, read through that one
 * descriptor. Anything else is `unreadable`, never an error and never a hang.
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
      let read: number;
      try {
        read = readSync(fd, buffer, length, buffer.length - length, null);
      } catch (cause) {
        // EAGAIN on a regular file cannot happen; any read error is unreadable.
        return { kind: "unreadable", why: errnoOf(cause) ?? "a read error" };
      }
      if (read <= 0) break;
      length += read;
      if (length >= buffer.length) break;
    }
    return {
      kind: "file",
      seen: { ino: stat.ino, mtimeNs: stat.mtimeNs, mtimeMs: Number(stat.mtimeMs), bytes: buffer.subarray(0, length) },
    };
  } catch (cause) {
    return { kind: "unreadable", why: errnoOf(cause) ?? "a stat error" };
  } finally {
    closeSync(fd);
  }
}

/** A regular file's identity and bytes, or `null` for anything else. */
function readLock(path: string): SeenLock | null {
  const entry = readEntry(path);
  return entry.kind === "file" ? entry.seen : null;
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
 * The reclaim's own directory beside the lock (`<log>.lock.d`) and its three
 * parts (APRV-479 round 2, RB3 and RS3):
 *
 * - `claims/`: one name per claim and its temporary; never scanned, read only
 *   by a reclaimer looking up the one name it is about to take;
 * - `pending/`: reclaimed lockfiles whose record is not yet in the log; the
 *   ONLY directory any writer lists, and every name in it leaves it once its
 *   record is appended;
 * - `quarantine/`: what a writer recorded as unverified, and what a reclaim
 *   moved that was not the lockfile it judged; never scanned, kept for a human.
 *
 * So the cost of a scan never depends on how many claims or quarantined files
 * have accumulated. Every path here starts with `<lockfile>.` (the export
 * excludes that prefix) and every file name ends in `.lock`.
 */
export interface ReclaimDirs {
  root: string;
  claims: string;
  pending: string;
  quarantine: string;
}

export function reclaimDirs(logPath: string): ReclaimDirs {
  const root = `${logPath}.lock.d`;
  return { root, claims: join(root, "claims"), pending: join(root, "pending"), quarantine: join(root, "quarantine") };
}

/** Make `path` a real directory (never a link to one), or say why it is not. */
function ensureRealDirectory(path: string): string | null {
  try {
    mkdirSync(path);
  } catch (cause) {
    if (errnoOf(cause) !== "EEXIST") return errnoOf(cause) ?? "an error";
  }
  try {
    return lstatSync(path).isDirectory() ? null : "not a directory";
  } catch (cause) {
    return errnoOf(cause) ?? "an error";
  }
}

/**
 * The key of one judged lockfile: its inode AND a digest of its mtime and
 * bytes, so a later lockfile that happens to reuse the inode is a different
 * reclaim with its own claims.
 */
function lockKey(seen: SeenLock): string {
  const digest = createHash("sha256")
    .update(seen.mtimeNs.toString())
    .update("\0")
    .update(seen.bytes)
    .digest("hex")
    .slice(0, 12);
  return `${seen.ino.toString()}-${digest}`;
}

function claimPath(claims: string, key: string, generation: number): string {
  return join(claims, `${key}.claim-${String(generation)}.lock`);
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
  claims: string,
  key: string,
  nonce: string,
): { kind: "held"; claim: HeldClaim } | { kind: "busy"; why: string } | { kind: "vanished" } {
  const record = { v: LOCK_HOLDER_VERSION, kind: "reclaim-claim", ...identityFields(), created: new Date().toISOString(), nonce };
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  for (let generation = 0; generation < MAX_CLAIM_GENERATIONS; generation += 1) {
    const path = claimPath(claims, key, generation);
    const linked = linkExclusive(path, join(claims, `${key}.${nonce}.tmp.lock`), bytes);
    if (linked.kind === "written") {
      return { kind: "held", claim: { path, next: claimPath(claims, key, generation + 1), bytes } };
    }
    if (linked.kind === "error") {
      return { kind: "busy", why: `it cannot be reclaimed here: the claim the reclaim needs could not be made (${linked.code})` };
    }
    const other = readEntry(path);
    // The claimant finished between the link and this read.
    if (other.kind === "absent") return { kind: "vanished" };
    if (other.kind === "unreadable") {
      return { kind: "busy", why: `a claim on it cannot be read (${other.why}), so it is left to that claimant` };
    }
    const claimant = parseClaim(other.seen.bytes);
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

/** What a lockfile's bytes and mtime say about taking it now. */
type LockJudgement = { kind: "gone"; note: ReclaimNote } | { kind: "kept"; why: string };

/**
 * Is `note` a record the schema accepts, by construction? Every field is
 * checked against the payload's own constraints, so a reclaim whose record
 * could not be appended is never committed (APRV-479 round 2, RB2).
 */
export function reclaimNoteIsValid(note: ReclaimNote): boolean {
  if (note.lockfile === "" || /[/\\]/u.test(note.lockfile)) return false;
  if (note.reason !== "holder-dead" && note.reason !== "holder-replaced" && note.reason !== "legacy-aged") return false;
  if (!Number.isSafeInteger(note.age_ms) || note.age_ms < 0) return false;
  if (note.holder !== undefined) {
    const { pid, op, created } = note.holder;
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > MAX_PID) return false;
    if (op !== "append" && op !== "hold") return false;
    if (!isCanonicalTimestamp(created)) return false;
  }
  return true;
}

/**
 * Judge one lockfile's bytes and mtime, as {@link tryReclaimLock} judges the
 * lock in place and {@link pendingReclaims} judges a reclaimed lockfile again
 * before its record is appended. Every field of the note is this process's own
 * conclusion: the reason from its own judgement, the age from its own clock,
 * the lockfile name from its own path; from the file it takes only a holder
 * record that parsed to the strict v1 shape (pid, op, `created`).
 */
function judgeLockBytes(lockfile: string, seen: SeenLock, now: number): LockJudgement {
  const parsed = parseHolder(seen.bytes);
  if (parsed.kind === "legacy") {
    const ageMs = Math.max(0, Math.round(now - seen.mtimeMs));
    if (ageMs < LEGACY_LOCK_RECLAIM_AGE_MS) {
      return {
        kind: "kept",
        why: `the lockfile names no holder (an older writer, or one killed between creating it and writing its record) and is ${String(Math.round(ageMs / 1000))} s old; such a lock is reclaimed only once it is ${String(LEGACY_LOCK_RECLAIM_AGE_MS / 60_000)} minutes old`,
      };
    }
    return {
      kind: "gone",
      note: { lockfile, reason: "legacy-aged", age_ms: ageMs, why: `the lockfile names no holder and is ${String(Math.round(ageMs / 1000))} s old` },
    };
  }
  if (parsed.kind === "unknown") {
    const version = typeof parsed.version === "number" && Number.isSafeInteger(parsed.version) ? `v ${String(parsed.version)}` : "an unrecognised version";
    return {
      kind: "kept",
      why: `the lockfile's holder record is in a format this version does not read (${version}), so its holder cannot be checked`,
    };
  }
  const verdict = judge(parsed.holder);
  if (verdict.state === "live") {
    return { kind: "kept", why: `held by ${verdict.why} (${parsed.holder.op}, since ${parsed.holder.created})` };
  }
  const created = Date.parse(parsed.holder.created);
  const ageMs = Math.max(0, Math.round(now - (Number.isFinite(created) ? created : seen.mtimeMs)));
  return {
    kind: "gone",
    note: {
      lockfile,
      reason: verdict.reason,
      age_ms: Number.isSafeInteger(ageMs) ? ageMs : 0,
      why: verdict.why,
      holder: { pid: parsed.holder.pid, op: parsed.holder.op, created: parsed.holder.created },
    },
  };
}

/** Options a writer passes to {@link tryReclaimLock} and {@link pendingReclaims}. */
export interface ReclaimOptions {
  /**
   * The writer's own write-boundary check of the record a reclaim would
   * append: a reclaim whose record it would refuse is not made, and a pending
   * record it would refuse is recorded as unverified instead (RB2).
   */
  recordValid?: (note: ReclaimNote) => boolean;
}

function recordable(note: ReclaimNote, options: ReclaimOptions): boolean {
  return reclaimNoteIsValid(note) && (options.recordValid === undefined || options.recordValid(note));
}

/**
 * Judge `<logPath>.lock` and, if its holder is provably gone, move it out of
 * the lock's path into `pending/` in one atomic rename, so the caller's next
 * `wx` create can take the lock and the reclaimed lockfile itself is the
 * record of the reclaim until whichever writer holds the lock next appends it
 * ({@link pendingReclaims}).
 *
 * The steps, and why a stall anywhere is harmless:
 *
 * 1. Read and judge the lockfile (a non-regular file is kept: it cannot be
 *    judged), and check that the record the reclaim would append is valid
 *    (if it is not, the lock is kept as if its holder were live). Touches
 *    nothing.
 * 2. Claim it ({@link takeClaim}). Only claims are written, and only reclaimers
 *    read them; a live claimant's claim is never passed over, so of any number
 *    of writers that judged this lockfile exactly one goes on.
 * 3. Re-check the lockfile, then (after the `before-commit` seam) re-check the
 *    lockfile AND the claim, and rename the lockfile to
 *    `pending/<time>-<key>-<nonce>.lock`. THIS RENAME IS THE COMMIT POINT:
 *    before it, every name anybody but a reclaimer reads is untouched, so a
 *    reclaimer stalled or killed anywhere before it leaves the lock exactly as
 *    it was (a wedge, never a fork); the rename frees the lock and makes the
 *    record of the reclaim durable in one atomic step, because the record IS
 *    the judged lockfile at its pending name. Inside the claim the judged
 *    lockfile can leave the path only through this rename, so the re-check
 *    immediately before it can be wrong only if something outside the protocol
 *    (a human `rm`, an older version's unconditional release) replaced the file
 *    in the instant between.
 * 4. Check that what was moved is the judged file. If it is not (that same
 *    out-of-protocol instant), put it back with `link(2)`, which never
 *    overwrites a lock somebody took meanwhile, and move the pending name out of
 *    `pending/` either way, so nothing records it.
 * 5. Remove the claim, a name only this reclaim writes.
 */
export function tryReclaimLock(logPath: string, now: number = Date.now(), options: ReclaimOptions = {}): ReclaimOutcome {
  const lockPath = `${logPath}.lock`;
  const entry = readEntry(lockPath);
  if (entry.kind === "absent") return { kind: "vanished" };
  if (entry.kind === "unreadable") {
    return {
      kind: "kept",
      why: `the lock's path holds something this process does not read (${entry.why}), so its holder cannot be judged; a human removes ${basename(lockPath)}`,
    };
  }
  const seen = entry.seen;

  const judged = judgeLockBytes(basename(lockPath), seen, now);
  if (judged.kind === "kept") return { kind: "kept", why: judged.why };
  const { note } = judged;
  const why = note.why;
  if (!recordable(note, options)) {
    return {
      kind: "kept",
      why: `${why}, but the record of its reclaim would not be valid, so the lock is treated as live; a human removes ${basename(lockPath)}`,
    };
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

  const dirs = reclaimDirs(logPath);
  for (const dir of [dirs.root, dirs.claims, dirs.pending]) {
    const bad = ensureRealDirectory(dir);
    if (bad !== null) {
      return { kind: "kept", why: `${why}, but it cannot be reclaimed here: ${basename(dirs.root)}/${basename(dir)} is unusable (${bad})` };
    }
  }

  const key = lockKey(seen);
  const nonce = randomBytes(8).toString("hex");

  // Step 2: the claim.
  const taken = takeClaim(dirs.claims, key, nonce);
  if (taken.kind === "vanished") return { kind: "vanished" };
  if (taken.kind === "busy") return { kind: "kept", why: `${why}; ${taken.why}` };
  const claim = taken.claim;

  try {
    step("claimed");
    // Step 3: still the judged lockfile?
    if (!stillJudged(lockPath, seen)) {
      return { kind: "kept", why: `the lock changed hands while it was being judged; nothing was touched` };
    }
    step("before-commit");
    // Re-check both, immediately before the one step that frees the lock.
    if (!stillJudged(lockPath, seen) || !claimStillHeld(claim)) {
      return { kind: "kept", why: `the lock or the claim on it changed during the reclaim; nothing was touched` };
    }
    const pending = join(dirs.pending, `${String(now).padStart(15, "0")}-${key}-${nonce}.lock`);
    step("at-commit");
    try {
      renameSync(lockPath, pending); // THE COMMIT POINT.
    } catch (cause) {
      if (errnoOf(cause) === "ENOENT") return { kind: "vanished" };
      return { kind: "kept", why: `${why}, but it could not be moved aside: ${(cause as Error).message}` };
    }
    step("after-commit");

    // Step 4: was it the judged file?
    const moved = readLock(pending);
    if (moved === null || !sameLock(moved, seen)) {
      // Reachable only from outside the protocol (see step 3). Put the file
      // back if it is still exactly what was moved and this process still
      // holds the claim; link(2) never replaces a lock somebody took meanwhile.
      step("before-put-back");
      let restored = false;
      const still = moved === null ? null : readLock(pending);
      if (moved !== null && still !== null && sameLock(still, moved) && claimStillHeld(claim)) {
        try {
          linkSync(pending, lockPath);
          restored = true;
        } catch {
          restored = false;
        }
      }
      // Never leave somebody else's lockfile under a pending name: it is not a
      // reclaim this process judged, so nothing may record it.
      if (restored && moved !== null) unlinkIfBytes(pending, moved.bytes);
      else quarantine(dirs, pending, `moved-${nonce}`);
      return {
        kind: "kept",
        why: restored
          ? `the lock changed hands during the reclaim and was put back`
          : `the lock changed hands during the reclaim and could not be put back; it is in ${basename(dirs.root)}/quarantine`,
      };
    }
    return { kind: "reclaimed", note };
  } finally {
    unlinkIfBytes(claim.path, claim.bytes);
  }
}

/** Move `path` (any kind of entry) into `quarantine/` under a name this process chose. */
function quarantine(dirs: ReclaimDirs, path: string, name: string): boolean {
  if (ensureRealDirectory(dirs.root) !== null || ensureRealDirectory(dirs.quarantine) !== null) return false;
  try {
    renameSync(path, join(dirs.quarantine, `${name}-${randomBytes(4).toString("hex")}.lock`));
    return true;
  } catch (cause) {
    return errnoOf(cause) === "ENOENT";
  }
}

/**
 * How many names one scan reads from `pending/`, and how many it records. The
 * scan reads at most {@link PENDING_SCAN_LIMIT} entries with `opendir` (never
 * the whole directory) and records at most {@link MAX_PENDING_PER_HOLD} of them,
 * oldest first among those read: one hold's cost is bounded by these two
 * numbers, whatever else the reclaim directory holds (RS3).
 */
const PENDING_SCAN_LIMIT = 64;
const MAX_PENDING_PER_HOLD = 16;

/** A reclaim whose record is waiting to be appended. */
export interface PendingReclaim {
  /** Its name in `pending/`. */
  name: string;
  path: string;
  /** The record's `reclaim_id`: a digest of the pending name, computed here. */
  id: string;
  /** The lockfile name this writer derives from its own log path. */
  lockfile: string;
  /**
   * The verified record, when the pending file re-judges cleanly; `null` when
   * it cannot be judged, in which case it is recorded as `unverified`, with
   * nothing taken from it.
   */
  note: ReclaimNote | null;
  /** Why it is unverified (for a person; never recorded). */
  why?: string;
}

/** The outcome of one scan of `pending/`. */
export type PendingScan =
  | { ok: true; items: PendingReclaim[] }
  /** `pending/` exists and cannot be listed: the writer must not append (RB3). */
  | { ok: false; why: string };

/**
 * The reclaims of `<logPath>.lock` whose records are not yet in the log, oldest
 * first. Called by the writer that holds the lock, which records each (and
 * {@link settlePendingReclaim}s it) before anything else.
 *
 * A pending file is evidence that a reclaim happened, whatever its content: a
 * reclaimer's commit put it there, or someone who can write this directory
 * did. So every one is recorded. When it re-judges cleanly ({@link
 * judgeLockBytes}, the same judgement a lockfile in place gets) the record
 * carries the strictly parsed holder; when it cannot be judged (another pid
 * namespace or boot, a holder now live, not a regular file, unreadable,
 * malformed, a record that would not validate) the record is `unverified` and
 * takes nothing from the file. A planted file therefore costs one truthful
 * record and can neither silence a real reclaim nor block appends.
 *
 * A `pending/` that does not exist (or is not a directory, so no reclaim could
 * have been committed into it) holds nothing. One that exists and cannot be
 * listed is a failure: the caller must not append (fail closed).
 */
export function pendingReclaims(logPath: string, now: number = Date.now(), options: ReclaimOptions = {}): PendingScan {
  const dirs = reclaimDirs(logPath);
  const lockfile = `${basename(logPath)}.lock`;
  try {
    if (!lstatSync(dirs.pending).isDirectory()) return { ok: true, items: [] };
  } catch (cause) {
    const code = errnoOf(cause);
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: true, items: [] };
    return { ok: false, why: `${basename(dirs.root)}/pending cannot be examined (${code ?? "an error"})` };
  }
  const names: string[] = [];
  let dir: Dir;
  try {
    dir = opendirSync(dirs.pending);
  } catch (cause) {
    return { ok: false, why: `${basename(dirs.root)}/pending cannot be listed (${errnoOf(cause) ?? "an error"})` };
  }
  try {
    for (let read = 0; read < PENDING_SCAN_LIMIT; read += 1) {
      const entry = dir.readSync();
      if (entry === null) break;
      names.push(entry.name);
    }
  } catch (cause) {
    return { ok: false, why: `${basename(dirs.root)}/pending cannot be listed (${errnoOf(cause) ?? "an error"})` };
  } finally {
    try {
      dir.closeSync();
    } catch {
      // Closed either way.
    }
  }
  names.sort();
  const items: PendingReclaim[] = [];
  for (const name of names.slice(0, MAX_PENDING_PER_HOLD)) {
    const path = join(dirs.pending, name);
    const id = createHash("sha256").update("reclaim\0").update(name).digest("hex").slice(0, 16);
    const entry = readEntry(path);
    if (entry.kind === "absent") continue;
    if (entry.kind === "unreadable") {
      items.push({ name, path, id, lockfile, note: null, why: `it is ${entry.why}` });
      continue;
    }
    const judged = judgeLockBytes(lockfile, entry.seen, now);
    if (judged.kind === "kept") {
      items.push({ name, path, id, lockfile, note: null, why: judged.why });
      continue;
    }
    if (!recordable(judged.note, options)) {
      items.push({ name, path, id, lockfile, note: null, why: `its record would not be valid` });
      continue;
    }
    items.push({ name, path, id, lockfile, note: judged.note });
  }
  return { ok: true, items };
}

/**
 * Take a recorded pending reclaim out of `pending/`: a verified one is
 * removed, an unverified one is moved into `quarantine/` (named by its
 * `reclaim_id`, so the record names the file a human can look at). `false` when
 * it could be neither: the caller must not append past it, or every later hold
 * would record it again.
 */
export function settlePendingReclaim(logPath: string, pending: PendingReclaim): boolean {
  if (pending.note !== null) {
    try {
      unlinkSync(pending.path);
      return true;
    } catch (cause) {
      if (errnoOf(cause) === "ENOENT") return true;
    }
  }
  return quarantine(reclaimDirs(logPath), pending.path, pending.id);
}

/**
 * Describe `<logPath>.lock` for a person, without touching it: `null` when
 * there is none, else whose it is and whether a writer would reclaim it.
 */
export function describeLogLock(logPath: string, now: number = Date.now()): string | null {
  const entry = readEntry(`${logPath}.lock`);
  if (entry.kind === "absent") return null;
  if (entry.kind === "unreadable") return `something this process does not read (${entry.why}); a human removes it`;
  const seen = entry.seen;
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
 * Node 26; there is no synchronous way to learn that a signal is pending, so a
 * listener cannot even set a flag for synchronous code to read: it runs only on
 * that turn). So what follows the release decides:
 *
 * - work that must not start after a stop request (`approval run`'s child)
 *   first awaits {@link yieldToTerminationSignals}: the loop turns, a signal that
 *   arrived while the lock was held reaches the guard, which re-raises it with
 *   the default disposition, and the process dies of it, with the signal's own
 *   status, before the work starts;
 * - a verb that returns or awaits gets the same at its next turn;
 * - a synchronous wait (a poll loop that cannot yield) calls
 *   {@link settleTerminationGuards} first, which removes the guard at once, so
 *   the wait runs under the default disposition and a signal during it kills
 *   the process immediately. The price is the one thing Node cannot do: a
 *   signal that landed in the append's own milliseconds and was not yet
 *   dispatched is lost, rather than held for the length of the wait (APRV-479,
 *   S2; the hazard in `cli/hook.ts`'s driver notes is a signal held through a
 *   synchronous wait).
 *
 * The guard is taken only after the lockfile is created (so the lock wait and
 * any reclaim run with no guard of this lock's: a signal there kills at once,
 * and the reclaim is built to survive that) and released right after the
 * lockfile is removed.
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

/**
 * Turn the event loop past a poll phase (two `setImmediate` hops from any
 * phase), so that a termination signal a released lock's guard caught is
 * dispatched now: the guard re-raises it and the process dies of it here,
 * before the caller starts whatever it was about to start. Resolves at once
 * when no guard is installed. A caller that must not act after a stop request
 * awaits this between its append and the act (APRV-479 round 2, RS1).
 */
export async function yieldToTerminationSignals(): Promise<void> {
  if (guards.size === 0) return;
  await new Promise<void>((resolve) => {
    setImmediate(() => {
      setImmediate(resolve);
    });
  });
}
