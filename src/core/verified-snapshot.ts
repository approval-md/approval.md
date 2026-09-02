/**
 * The verified-head snapshot (APRV-188): what a process that already walked the
 * log publishes, so the next process does not have to walk it again.
 *
 * ## The cost this removes
 *
 * Every hook-gated tool call is a fresh process with an empty
 * {@link VerifiedReadCache}, so it verifies the log from genesis before it may
 * decide anything. APRV-186 and APRV-206 made that walk as cheap as a walk can
 * be; what they could not change is that it is O(records) per gated command.
 * Measured on this repository's shape at 10k records: 65 ms of the 371 ms a
 * gated invocation costs, growing at 6.5 ms per thousand records, which is the
 * term that turns into seconds as a log grows. The daemon, meanwhile, holds a
 * warm cache and re-verifies only the tail on every tick. This module is how
 * what it verified reaches the next hook process.
 *
 * ## Why a file and not a socket
 *
 * The hook's request path is synchronous end to end — `commandHook` returns an
 * exit code, and the wait loop sleeps synchronously — so a `node:net` client
 * could not be awaited from it, and a `spawnSync` helper to do the awaiting
 * would cost more node startup (20-40 ms) than the walk it saves. A published
 * file needs one `readFileSync`. It also spawns no child and opens no socket,
 * so there is no environment to scrub (APRV-205) and no fd to leak.
 *
 * ## What a snapshot is, and what it is emphatically not
 *
 * It is an **endorsement of bytes**. It says: *the first `byte_length` bytes of
 * this log, whose SHA-256 is this, verified clean, and they end at this head.*
 * It carries no records, and a reader never learns anything from it that it
 * cannot check against the log file in its own hands. A reader that cannot
 * re-prove every one of those claims ignores the file and walks the log, which
 * is the behaviour with no snapshot at all.
 *
 * ## Global invariant 1, "enforcement paths read only verified records"
 *
 * This is the invariant the module touches, so the argument is written out
 * rather than assumed. The structure is APRV-43's, with the verifier in another
 * process:
 *
 *  - {@link admitSnapshot} hashes the prefix bytes **it read itself** and
 *    requires the digest the snapshot names. That is what makes "the bytes the
 *    publisher verified" and "the bytes on disk now" the same bytes; it is the
 *    identical proof the in-process cache pays on every cached read, and no
 *    amount of `stat` substitutes for it.
 *  - The reader parses the prefix lines itself and re-derives the head and the
 *    line count from its own parse. A snapshot naming a different head, or a
 *    different number of lines, is rejected by the reader's own arithmetic.
 *  - The reader then re-checks the chain links (`alg`, `seq` succession, `prev`
 *    linkage, hash shape) over those parsed records. This is a deliberate
 *    SUBSET of `core/verify.ts`'s ladder and never a replacement for it: it can
 *    only reject. `core/verify.ts` remains the one implementation of the
 *    verdict, and the appended tail beyond the prefix is walked by it in full.
 *  - What is therefore taken on the publisher's word is exactly two checks over
 *    bytes already proved identical: the `event` schema validation and the
 *    per-record hash recompute.
 *
 * **Why that residue is not a new capability.** A snapshot can only endorse
 * bytes that are already in the log file. To exploit the residue an attacker
 * must write `verified-head.json`, which sits in the same directory as
 * `events.jsonl` under the same permissions — and the chain is unkeyed, so an
 * attacker who can write that directory can simply recompute a self-consistent
 * forged log, which passes a *cold* walk too. The snapshot grants nothing that
 * write access to the log directory did not already grant. The ownership and
 * permission checks in {@link readSnapshot} are what keep that sentence true
 * under a loose umask: a snapshot any other user could have written is refused
 * before it is read.
 *
 * Fail closed throughout. Every check here can only reject, every rejection
 * falls back to the cold walk, and nothing in this module can turn a log that
 * does not verify into a verdict — the reader either proves the prefix or walks
 * it.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  fstatSync,
  closeSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { EventRecord, LogHead } from "./log.js";
import type { VerifiedPrefix } from "./verify.js";

/** The snapshot format version. A reader admits exactly this one. */
export const SNAPSHOT_VERSION = 1;

/** The hash scheme every record declares; a link check rejects anything else. */
const ALG = "sha256/jcs";

const NEWLINE = 0x0a;

const HEX64 = /^[0-9a-f]{64}$/u;

/**
 * The published snapshot, as it sits on disk.
 *
 * Field names are snake_case to match every other file this project writes.
 * There is no JSON Schema for it, deliberately: schemas in `schema/` describe
 * the log's records, which are evidence, and this file is not evidence. It is
 * validated field by field by {@link parseSnapshot}, strictly, in one place.
 */
export interface VerifiedSnapshot {
  v: number;
  /** Resolved path of the log these bytes belong to. */
  log: string;
  /** Resolved schema directory the publisher verified against ("" = default). */
  schema_dir: string;
  /** Length of the endorsed prefix in bytes. Always ends just after a newline. */
  byte_length: number;
  /** SHA-256 (hex) over exactly those bytes. The proof a reader re-computes. */
  sha256: string;
  /** Complete lines in the prefix, so a resumed walk numbers lines absolutely. */
  lines: number;
  /** The prefix's chain head. A reader re-derives it and must agree. */
  head: LogHead;
  /** When it was published. Diagnostics only; no check depends on it. */
  verified_at: string;
  /** Publisher pid. Diagnostics only; no check depends on it. */
  pid: number;
}

/**
 * Where the snapshot for `logPath` lives: beside the log, named for what it is.
 *
 * Derived, never configured. One log has one snapshot, and a reader that had to
 * be *told* where to look could be pointed at a snapshot for another log — a
 * mistake the `log` field would catch and that this removes entirely.
 */
export function snapshotPathFor(logPath: string): string {
  return join(dirname(resolve(logPath)), "verified-head.json");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The identity of a path, for the "is this the same log" comparison.
 *
 * `realpath`, because the publisher and the reader routinely reach one log by
 * two spellings: a daemon started in `/var/folders/...` and a hook whose `cwd`
 * Node has already resolved to `/private/var/folders/...` are the same file, and
 * comparing the spellings would refuse every snapshot on macOS's aliased temp
 * directories, and anywhere a checkout sits behind a symlink. Both sides call
 * this, so the aliases collapse together or not at all.
 *
 * A path that cannot be resolved (the file is gone) falls back to `resolve`,
 * which can only make the comparison stricter.
 */
function pathIdentity(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/**
 * What this process last published for a log: the endorsement, not the file.
 *
 * A clean read of an unchanged log endorses the same bytes it endorsed last
 * time, and writing that fact again is a rename into a directory the daemon
 * itself watches — which schedules a tick, which reads, which publishes
 * (APRV-211: measured at 18 ticks in 45 seconds with a ten-minute interval and
 * no external writer). The memo is a **write suppressor and never an admission
 * rule**: nothing is read from it, no reader is affected by it, and the worst a
 * stale entry can do is leave a correct snapshot on disk unrewritten.
 */
const published = new Map<string, { byteLength: number; sha256: string }>();

/** Forget what this process published. For tests, and for {@link clearSnapshot}. */
export function forgetPublishedSnapshots(logPath?: string): void {
  if (logPath === undefined) published.clear();
  else published.delete(pathIdentity(logPath));
}

/**
 * Publish a snapshot for a log the caller has just verified clean.
 *
 * `raw` must be the exact bytes the caller verified, `sha256` their digest,
 * `head` the head that walk produced and `lines` its record count: this function
 * checks none of that and cannot — it is the caller's own verification being
 * published. Every caller is therefore immediately after a `clean` verdict over
 * these bytes. The digest is a parameter rather than a recomputation because the
 * caller has just proved it (APRV-206's argument, and APRV-211's measurement:
 * hashing megabytes twice per read was 45% of a tick).
 *
 * The write is atomic (a temp file in the same directory, then `rename`) so a
 * reader never sees half a snapshot, and mode 0600 so the ownership argument in
 * the module header holds. Any failure is swallowed: a snapshot is an
 * optimization, and a daemon must not die because a cache file could not be
 * written. The return value says whether it landed, for the tests and the
 * doctor row; `false` also covers "these exact bytes are already published",
 * which is a write skipped rather than a write that failed.
 */
export function publishSnapshot(
  logPath: string,
  raw: Uint8Array,
  digest: string,
  lines: number,
  head: LogHead,
  schemaDir: string | undefined,
  now: () => string = () => new Date().toISOString(),
): boolean {
  // A prefix that does not end at a line boundary cannot be resumed from, so it
  // is never published. In practice a clean log always ends with a newline.
  if (raw.length === 0 || raw[raw.length - 1] !== NEWLINE) return false;

  const identity = pathIdentity(logPath);
  const last = published.get(identity);
  if (last !== undefined && last.byteLength === raw.length && last.sha256 === digest) return false;

  const snapshot: VerifiedSnapshot = {
    v: SNAPSHOT_VERSION,
    log: identity,
    schema_dir: schemaDir === undefined ? "" : pathIdentity(schemaDir),
    byte_length: raw.length,
    sha256: digest,
    lines,
    head,
    verified_at: now(),
    pid: process.pid,
  };

  const target = snapshotPathFor(logPath);
  const temp = `${target}.${String(process.pid)}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    // Explicit, because `mode` on writeFileSync is masked by the umask and only
    // applies when the file is created: a temp file left by a previous crash
    // would otherwise keep whatever mode it had.
    chmodSync(temp, 0o600);
    renameSync(temp, target);
    published.set(identity, { byteLength: raw.length, sha256: digest });
    return true;
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // Nothing to clean up, or nothing we may clean up. Either way the
      // snapshot simply does not exist, which every reader handles.
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Why a snapshot was not used. Every value means the same thing operationally —
 * walk the log — and exists so the doctor row and the tests can say which check
 * rejected it.
 */
export type SnapshotRefusal =
  | "absent"
  | "unreadable"
  | "not-a-file"
  | "foreign-owner"
  | "loose-permissions"
  | "malformed"
  | "version"
  | "other-log"
  | "other-schema-dir"
  | "shorter-file"
  | "not-line-aligned"
  | "digest-mismatch"
  | "line-count-mismatch"
  | "head-mismatch"
  | "chain-broken";

export interface SnapshotRejected {
  ok: false;
  reason: SnapshotRefusal;
  detail: string;
}

export type SnapshotRead = { ok: true; snapshot: VerifiedSnapshot } | SnapshotRejected;

function reject(reason: SnapshotRefusal, detail: string): SnapshotRejected {
  return { ok: false, reason, detail };
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Strict field-by-field validation. Anything unexpected is a rejection. */
function parseSnapshot(text: string): SnapshotRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return reject("malformed", cause instanceof Error ? cause.message : String(cause));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return reject("malformed", "the snapshot is not a JSON object");
  }
  const raw = parsed as Record<string, unknown>;

  if (raw["v"] !== SNAPSHOT_VERSION) {
    return reject("version", `snapshot version ${JSON.stringify(raw["v"])} is not ${String(SNAPSHOT_VERSION)}`);
  }
  if (typeof raw["log"] !== "string" || raw["log"].length === 0) {
    return reject("malformed", "log is missing or not a string");
  }
  if (typeof raw["schema_dir"] !== "string") {
    return reject("malformed", "schema_dir is missing or not a string");
  }
  if (!isPositiveInt(raw["byte_length"])) {
    return reject("malformed", "byte_length is missing or not a positive integer");
  }
  if (typeof raw["sha256"] !== "string" || !HEX64.test(raw["sha256"])) {
    return reject("malformed", "sha256 is missing or not a 64-character hex digest");
  }
  if (!isPositiveInt(raw["lines"])) {
    return reject("malformed", "lines is missing or not a positive integer");
  }
  const head = raw["head"];
  if (typeof head !== "object" || head === null || Array.isArray(head)) {
    return reject("malformed", "head is missing or not an object");
  }
  const headRecord = head as Record<string, unknown>;
  if (!isPositiveInt(headRecord["seq"])) {
    return reject("malformed", "head.seq is missing or not a positive integer");
  }
  if (typeof headRecord["hash"] !== "string" || !HEX64.test(headRecord["hash"])) {
    return reject("malformed", "head.hash is missing or not a 64-character hex digest");
  }

  return {
    ok: true,
    snapshot: {
      v: SNAPSHOT_VERSION,
      log: raw["log"],
      schema_dir: raw["schema_dir"],
      byte_length: raw["byte_length"],
      sha256: raw["sha256"],
      lines: raw["lines"],
      head: { seq: headRecord["seq"], hash: headRecord["hash"] },
      verified_at: typeof raw["verified_at"] === "string" ? raw["verified_at"] : "",
      pid: typeof raw["pid"] === "number" ? raw["pid"] : 0,
    },
  };
}

/**
 * Read the snapshot for `logPath`, refusing one this user did not write.
 *
 * The ownership and permission checks are taken from the open file descriptor
 * rather than from the path, so what is checked and what is read are the same
 * inode: a snapshot swapped between the `stat` and the read cannot be admitted
 * on the strength of the file that used to be there.
 */
export function readSnapshot(logPath: string): SnapshotRead {
  const path = snapshotPathFor(logPath);
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return reject("absent", `no snapshot at ${path}`);
    return reject("unreadable", `snapshot ${path} could not be opened: ${String(code)}`);
  }

  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return reject("not-a-file", `${path} is not a regular file`);

    // Who wrote it. `process.geteuid` is absent on Windows, where the check
    // cannot be made and the file is refused rather than trusted.
    const euid = typeof process.geteuid === "function" ? process.geteuid() : null;
    if (euid === null) {
      return reject("foreign-owner", "file ownership cannot be established on this platform");
    }
    if (stats.uid !== euid) {
      return reject(
        "foreign-owner",
        `${path} is owned by uid ${String(stats.uid)}, not by this user (${String(euid)})`,
      );
    }
    if ((stats.mode & 0o022) !== 0) {
      return reject(
        "loose-permissions",
        `${path} is writable by group or other (mode ${(stats.mode & 0o777).toString(8)})`,
      );
    }
    // A snapshot is a few hundred bytes; a huge file here is not one.
    if (stats.size > 64 * 1024) {
      return reject("malformed", `${path} is ${String(stats.size)} bytes, far larger than a snapshot`);
    }

    const buffer = Buffer.allocUnsafe(stats.size);
    let read = 0;
    while (read < stats.size) {
      const got = readSync(fd, buffer, read, stats.size - read, read);
      if (got === 0) break;
      read += got;
    }
    if (read !== stats.size) return reject("unreadable", `${path} ended early`);
    return parseSnapshot(buffer.toString("utf8"));
  } catch (cause) {
    return reject("unreadable", cause instanceof Error ? cause.message : String(cause));
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Already closed; nothing to release.
    }
  }
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

/**
 * The chain links, re-checked over records the reader parsed itself.
 *
 * A SUBSET of `core/verify.ts`'s ladder — `alg`, the shape of `hash`, `seq`
 * succession from 1, and `prev` linkage — and never a substitute for it. It can
 * only reject, it is not consulted for any verdict, and everything it does not
 * check (the `event` schema, the per-record hash recompute) is the residue the
 * module header accounts for. It costs about a millisecond at ten thousand
 * records and turns a buggy or stale publisher into a fallback rather than into
 * a bad read.
 */
function linksHold(records: readonly EventRecord[], expected: LogHead): string | null {
  let previousHash: string | null = null;
  for (const [index, record] of records.entries()) {
    const seq = index + 1;
    const raw = record as unknown as Record<string, unknown>;
    if (raw["alg"] !== ALG) {
      return `record ${String(seq)} declares alg ${JSON.stringify(raw["alg"])}, not ${ALG}`;
    }
    if (typeof raw["hash"] !== "string" || !HEX64.test(raw["hash"])) {
      return `record ${String(seq)} has no 64-character hex hash`;
    }
    if (raw["seq"] !== seq) {
      return `record at position ${String(seq)} declares seq ${JSON.stringify(raw["seq"])}`;
    }
    const prev = raw["prev"];
    if (previousHash === null) {
      if (prev !== null) return "the first record does not have a null prev";
    } else if (prev !== previousHash) {
      return `record ${String(seq)} prev does not link to record ${String(seq - 1)}`;
    }
    previousHash = raw["hash"];
  }

  const last = records[records.length - 1];
  if (last === undefined) return "the prefix holds no records";
  if (last.seq !== expected.seq || last.hash !== expected.hash) {
    return `the prefix ends at seq ${String(last.seq)}, not at the claimed head seq ${String(expected.seq)}`;
  }
  return null;
}

export type SnapshotAdmission =
  | {
      ok: true;
      prefix: VerifiedPrefix;
      /**
       * SHA-256 of the endorsed prefix, as this call re-proved it. Handed back
       * so a caller that caches the prefix does not hash the same bytes twice.
       */
      digest: string;
    }
  | SnapshotRejected;

/**
 * Decide whether `snapshot` may stand for the first bytes of `raw`, and return
 * the {@link VerifiedPrefix} a resumed walk chains onto when it may.
 *
 * `raw` is the caller's own read of the whole log. Every check below is made
 * against those bytes; nothing is re-`stat`ed, re-read, or taken from the
 * snapshot without being re-derived. The order is cheapest-first, but only the
 * digest is load-bearing — everything before it rejects an obviously
 * inapplicable snapshot without hashing megabytes, and everything after it
 * re-derives from the reader's own parse what the snapshot merely claimed.
 */
export function admitSnapshot(
  logPath: string,
  raw: Uint8Array,
  snapshot: VerifiedSnapshot,
  schemaDir: string | undefined,
): SnapshotAdmission {
  const identity = pathIdentity(logPath);
  if (snapshot.log !== identity) {
    return reject("other-log", `the snapshot describes ${snapshot.log}, not ${identity}`);
  }
  const schemaKey = schemaDir === undefined ? "" : pathIdentity(schemaDir);
  if (snapshot.schema_dir !== schemaKey) {
    return reject(
      "other-schema-dir",
      `the snapshot was verified against schemas in ${JSON.stringify(snapshot.schema_dir)}, this read uses ${JSON.stringify(schemaKey)}`,
    );
  }
  // The log is append-only: a file shorter than the endorsed prefix cannot
  // contain it, and must be walked cold so the head reported is the file's own.
  if (raw.length < snapshot.byte_length) {
    return reject(
      "shorter-file",
      `the log is ${String(raw.length)} bytes, shorter than the endorsed prefix of ${String(snapshot.byte_length)}`,
    );
  }
  if (raw[snapshot.byte_length - 1] !== NEWLINE) {
    return reject("not-line-aligned", "the endorsed prefix does not end at a line boundary");
  }

  // The proof.
  const digest = sha256(raw.subarray(0, snapshot.byte_length));
  if (digest !== snapshot.sha256) {
    return reject("digest-mismatch", "the log's first bytes are not the bytes the snapshot endorses");
  }

  // Everything from here is re-derived from the reader's own parse of those
  // bytes. A snapshot that lied about the head or the record count is caught
  // here, by arithmetic, not by trust.
  const text = Buffer.from(raw.buffer, raw.byteOffset, snapshot.byte_length).toString("utf8");
  const records: EventRecord[] = [];
  let start = 0;
  for (;;) {
    const newline = text.indexOf("\n", start);
    if (newline < 0) break;
    const line = text.slice(start, newline);
    start = newline + 1;
    if (line.trim().length === 0) return reject("malformed", "the endorsed prefix holds a blank line");
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (cause) {
      return reject(
        "malformed",
        `line ${String(records.length + 1)} of the endorsed prefix is not valid JSON: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return reject("malformed", `line ${String(records.length + 1)} of the endorsed prefix is not a JSON object`);
    }
    records.push(value as EventRecord);
  }

  if (records.length !== snapshot.lines) {
    return reject(
      "line-count-mismatch",
      `the endorsed prefix holds ${String(records.length)} lines, not the ${String(snapshot.lines)} claimed`,
    );
  }

  const broken = linksHold(records, snapshot.head);
  if (broken !== null) {
    // A head that does not match what the bytes say is the signature of a
    // publisher serving something other than what it verified.
    const reason: SnapshotRefusal = broken.includes("claimed head") ? "head-mismatch" : "chain-broken";
    return reject(reason, broken);
  }

  return {
    ok: true,
    digest,
    prefix: {
      byteLength: snapshot.byte_length,
      lines: snapshot.lines,
      head: snapshot.head,
      records,
    },
  };
}

/**
 * {@link readSnapshot} then {@link admitSnapshot}: the whole path a reader takes.
 *
 * Returns the prefix to resume behind, or the reason there is none. Every reason
 * means "walk the log", which is what the caller does with no snapshot at all.
 */
export function snapshotPrefix(
  logPath: string,
  raw: Uint8Array,
  schemaDir: string | undefined,
): SnapshotAdmission {
  const read = readSnapshot(logPath);
  if (!read.ok) return read;
  return admitSnapshot(logPath, raw, read.snapshot, schemaDir);
}

/** Read the snapshot's own text, for the doctor row. Never throws. */
export function snapshotSummary(logPath: string): SnapshotRead {
  return readSnapshot(logPath);
}

/** Remove a snapshot. Used by tests and by anything that invalidates one. */
export function clearSnapshot(logPath: string): void {
  // The memo describes a file; removing the file removes what it described, and
  // the next clean read must publish again rather than believe this process's
  // own bookkeeping.
  forgetPublishedSnapshots(logPath);
  try {
    unlinkSync(snapshotPathFor(logPath));
  } catch {
    // Absent is the desired state.
  }
}

/** Read the log's bytes, for callers that want the same view a reader admits. */
export function logBytes(logPath: string): Uint8Array | null {
  try {
    return readFileSync(logPath);
  } catch {
    return null;
  }
}
