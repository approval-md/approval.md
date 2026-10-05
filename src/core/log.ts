/**
 * Append-only event log writer (SPEC.md §8, `.approval/log/events.jsonl`).
 *
 * The log is the truth. This module is the *only* sanctioned way to put a line
 * into it, and its public API deliberately exposes no mutation, reorder,
 * rewrite, or truncate operation — there is nothing here to call that could
 * disturb an existing byte. Reading, verifying, and projecting live elsewhere.
 *
 * Guarantees, in the order they are enforced by {@link appendEvent}:
 *
 * 1. **Exclusive access.** A dependency-free advisory lockfile (`<log>.lock`,
 *    created `wx`) serializes the read-tail → compute → write sequence, so two
 *    concurrent appenders cannot both read seq N and both write seq N+1.
 * 1b. **Compare-and-append (APRV-20 finding B1).** The lock serializes *writes*,
 *    but every caller that checks the log before appending — "no live request
 *    exists", "this token is unspent", "the budget has room" — made that check
 *    outside the lock, against a log that could have moved on before its own
 *    append took the lock. {@link AppendOptions.expectedHead} closes that
 *    window: the caller states the `(seq, hash)` it read, this module compares
 *    it against the actual tail **under the lock**, and refuses `head-moved`
 *    when they differ. Nothing is written. The refusal is deliberately *not*
 *    retried here: only the caller knows whether re-deriving its decision
 *    against the newer log is safe, so the core reports and stops.
 * 2. **Refuse to build on a corrupt tail.** If the file's last line is
 *    truncated (no terminating newline) or unparseable, the append is
 *    rejected. Chaining onto a half-written record would bake the corruption
 *    into every subsequent hash. Since APRV-206 that tail is read from the END
 *    of the file rather than by reading the whole log: an append needs the last
 *    line and nothing else, and paying one full read of an ever-growing file per
 *    append put log length into the latency of every grant. Every refusal above
 *    is unchanged, byte for byte.
 * 3. **The runtime stamps the chain fields.** Callers supply content only;
 *    `seq`, `prev`, `alg`, and `hash` are computed here. `alg` is always
 *    `sha256/jcs` (SPEC.md §8 defines exactly one value at v0.1).
 * 4. **Validate at the write boundary.** The complete record — chain fields
 *    included — must pass the `event` JSON Schema before any byte is written.
 *    On failure the file is left byte-identical and a structured error is
 *    returned. Fail closed: nothing here throws a validation problem past the
 *    caller as a partially-written line.
 * 5. **One line, one write.** The stored line is the JCS canonicalization of
 *    the complete record (`hash` included); the digest input is that same
 *    canonicalization minus the `hash` field. One scheme, two inputs — a
 *    verifier strips `hash` and re-derives. Appended with a single `write(2)`
 *    on a handle opened `O_APPEND`.
 * 5b. **Durable before ok (APRV-440).** The write is followed by `fsync(2)` on
 *    the same descriptor, and only then does the append report ok. When this
 *    append created the file, the log directory is fsynced too (and the parent
 *    of every directory this call created), so the new name survives along with
 *    its bytes. Without this, an acknowledged record lived in the page cache
 *    only: a platform kill before writeback left the file extended over blocks
 *    that were never written, which reads back as a NUL-filled unterminated tail
 *    (observed on a hosted tenant on 2026-09-25: an acknowledged attestation
 *    lost, 456 NUL bytes in its place). Atomicity against concurrent writers
 *    was guarantee 5 all along; durability against the machine dying is this one.
 *
 * 6. **The writing daemon names itself, or is refused (APRV-383).** A record
 *    appended by a declaring daemon process carries `daemon`, the id of the
 *    instance that wrote it, so a tenant reading a log hosted by somebody else can
 *    tell which daemon acted on their behalf. The id comes from this process's own
 *    state (`core/daemon-identity.ts`) and never from the caller, and where the
 *    attested policy lists the ids that may write, an unlisted one is refused here
 *    with nothing written. Every earlier record, carrying no such field, validates
 *    and verifies unchanged.
 *
 * 7. **A lock whose holder is provably gone is taken back, and the log says so
 *    (APRV-479).** The lockfile carries its holder's record, a writer that finds
 *    it held judges the holder once per wait, and a lock left by a dead holder
 *    is reclaimed atomically, with the record of the reclaim written beside the
 *    lock before the lock is freed; whichever writer takes the lock next appends
 *    it as `audit.lock_reclaimed` before anything else, from a fresh read of the
 *    tail. A live holder's lock, and any holder this process cannot check, is
 *    never taken. `core/log-lock.ts` holds the rules.
 *
 * Determinism: `ts` is supplied by the caller. This module never reads the
 * clock, because a hash-relevant field sourced from ambient state would make
 * the log irreproducible. The one exception is the record this module writes on
 * its own behalf, the `audit.lock_reclaimed` of guarantee 7: no caller authors
 * it, and its `ts` is assigned at the write boundary like any audit record's. `daemon` is ambient in the same sense and is not a
 * counter-example: a log is reproducible per WRITER, the field says which writer,
 * and a verifier re-derives the hash from the record's own bytes either way.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  DAEMON_APPEND_REFUSAL_CODES,
  daemonStampForAppend,
} from "./daemon-identity.js";
import { systemClock } from "./clock.js";
import { canonicalize, JcsError } from "./jcs.js";
import {
  clearPendingReclaim,
  createLockFile,
  guardTerminationWhileLocked,
  pendingReclaims,
  releaseLockFile,
  settleTerminationGuards,
  tryReclaimLock,
  type LockOp,
  type OwnLock,
  type PendingReclaim,
} from "./log-lock.js";
import { appendWriteLayer } from "./log-write-layer.js";
import { validate, type ValidateOptions, type ValidationError } from "./validate.js";

/** SPEC.md §8: the hash scheme identifier stamped on every v0.1 record. */
export const ALG = "sha256/jcs";

/**
 * SPEC.md §8: `prev` of the first record in a log. `null`, not a zero digest —
 * the schema and the `genesis-null-prev` fixture both encode this choice.
 */
export const GENESIS_PREV = null;

/**
 * The closed set of event types (SPEC.md §8, mirrored by the schema enum).
 *
 * `payload.pruned` (APRV-38) is the first addition after the v0.1 draft set of
 * sixteen: the daemon appends one per payload file it removes under
 * `payload_retention`, so a log states what its payload store no longer holds.
 * `approval.withdrawn` (APRV-106) is the second: the requester's retraction of
 * a request nobody has answered yet (amended SPEC.md §6.3).
 * `execution.indeterminate` and `execution.reconciled` (APRV-120) are the third
 * and fourth: a side effect that was attempted and whose outcome is unknown, and
 * the human resolution that later says which it was (amended SPEC.md §6.3,
 * §10.4).
 * `reconciliation.required` / `reconciliation.satisfied` (APRV-127) are the
 * fifth and sixth: the obligation a retrospective DENIAL creates, and the
 * human act that discharges it (amended SPEC.md §5.2).
 * `policy.proposed` / `policy.declined` (APRV-109) are the seventh and eighth:
 * an agent asking a human to attest prepared policy bytes, and the human's
 * refusal (amended SPEC.md §10.1, §10.3). The acceptance is `policy.updated`,
 * which already existed and is still the only event an attestation is.
 * `audit.dark_session` (APRV-192) is the ninth: the daemon recording git
 * activity it can see for which the log carries no corresponding record
 * (amended SPEC.md §10.2). It is an observation the RUNTIME makes about a
 * session, never a record written on a session's behalf, so it carries a
 * `system:` actor and the schema refuses any other.
 * `gate.opened`, `gate.closed` and `gate.bypassed` (APRV-214) are the tenth,
 * eleventh and twelfth: a human time-boxing a full harness bypass so the gate
 * itself can be debugged, that human closing it early, and one gated tool call
 * the hook allowed while it stood (amended SPEC.md §5.2). The window's whole
 * state is these records, deliberately: a file the runtime read on its own
 * would let anything able to write it act as the human. The first two carry a
 * `human:` actor and the schema refuses any other.
 * `log.checkpoint` (APRV-220) is the thirteenth: a human's signature over the
 * chain head at a moment, made with a key no agent process holds. The chain is
 * unkeyed, so a party with write access to this file can truncate it and
 * recompute a self-consistent forgery; a checkpoint is a witness that survives
 * them, because a rewritten chain cannot reproduce a signature over the hashes
 * it replaced. Human actor, for the reason `gate.opened` carries one.
 * `audit.decision_refused` (APRV-235) is the fourteenth: a human decided
 * through a channel or the CLI and the gate refused to record the decision, so
 * the log states that the answer was given and could not be taken (amended
 * SPEC.md §5.2). Audit tier — it grants nothing, and no verdict, budget, streak
 * or sampling path reads it. `system:` actor, like `audit.dark_session`: it is
 * the runtime's statement about its own refusal, and the human whose decision
 * it was is named in the payload. Refusals handed to AGENTS are not recorded;
 * the asymmetry is deliberate, and `core/decision-refusal.ts` states why.
 * `gate.organ.attested` (APRV-272) is the fifteenth: a human's sign-off on the
 * exact bytes of one of the gate's ORGANS, the harness files that install the
 * hook (amended SPEC.md §5.2, §8). Those files are `policy.core`, which is
 * human-only, so the gate mints no record of any kind for them and no
 * grant-shaped evidence for a hand edit to one can exist; content attestation
 * is the only evidence there is, and this is it. `human:` actor and the schema
 * refuses any other, for the reason `gate.opened` carries the same rule.
 *
 * It is a type of its own rather than a `policy.updated` variant, and that is
 * the load-bearing choice: every reader of the POLICY attestation selects on
 * `event === "policy.updated"` (`core/attest.ts`, `core/policy-proposal.ts`,
 * `cli/amend.ts`, `cli/channel-telegram.ts`, `core/protected-path-guard.ts`),
 * so a distinct type is ignored by all of them by construction rather than by a
 * filter each one would have to remember. `checkAttestationOfBytes` returns at
 * the FIRST record carrying a `sha256` as it scans backwards, so an organ
 * attestation written as a `policy.updated` would have reported a correctly
 * attested policy as `hash-mismatch` and refused every gate operation until
 * somebody re-attested it. The `gate.` prefix already carries the write-boundary
 * clock in `core/verify.ts`, which is what an attestation's `ts` has to be.
 *
 * `audit.gesture_refused` (APRV-355) is the seventeenth: a human made a gesture
 * on a decision surface that is NOT a decision — a checkpoint signature, a
 * review — and the surface refused it before any verb ran. `audit.decision_refused`
 * cannot carry one: it requires an `action_key` and a `decision` of grant,
 * reject or revoke, and a signature has neither, so recording a refused
 * signature there would mean manufacturing both. Audit tier on the same strict
 * terms, `system:` actor for the same reason, and `core/gesture-refusal.ts`
 * states the asymmetry it inherits.
 *
 * `audit.question_preempted` (APRV-378) is the eighteenth: something other than
 * this gate answered a question this gate exists to ask. The first instance is
 * Codex's server-side auto-reviewer, which can resolve an approval with a model
 * call before `approval codex bridge` is asked and discloses it afterwards
 * through an `item/autoApprovalReview` notification. None of the three audit
 * records above it fits: the sweep is about activity with no records beside it,
 * and both refusal records are about a human gesture. Here the question
 * existed, the gate would have asked it, and somebody else answered first, so
 * the log's silence about it would be indistinguishable from a turn that never
 * wanted to act. Audit tier on the same strict terms, `system:` actor for the
 * same reason, and a closed `source` enum so the next party to do this gains a
 * member rather than a type. `core/question-preempted.ts` states the rest.
 *
 * `audit.lock_reclaimed` (APRV-479) is the nineteenth: this writer took back
 * `<log>.lock` from a holder that is provably gone (a writer killed while it
 * held the lock, which nothing else would ever remove), and says so as the first
 * record under the lock it then took. None of the audit records above it fits:
 * no human gesture, no question, no sweep, only the log's own lock. Audit tier on
 * the same strict terms (nothing reads it to decide anything), `system:` actor,
 * and `core/log-lock.ts` states when a lock counts as gone.
 *
 * `gate.path.signed_off` (APRV-338) is the sixteenth: a human's sign-off on the
 * exact bytes of one PROTECTED PATH whose edits classify `policy.edit` or a
 * `policy.edit.*` sub-class (amended SPEC.md §5.2, §8, §10.1). `human:` actor,
 * and the schema refuses any other.
 *
 * It is a sibling of `gate.organ.attested` and not the same type, because the
 * surfaces differ in what evidence is available for them. An organ is
 * `policy.core`, the gate mints nothing for it, and content attestation is
 * therefore the ONLY evidence that can exist. A protected path has grants
 * available to it, and the after-the-fact checker of §10.1 prefers them: a
 * grant binds the exact hunk, this record stands for the whole file, and one
 * type carrying both claims would have let the weaker one be read as the
 * stronger. It is in the `gate.` namespace for the reason the organ record is:
 * §8 keys the write-boundary clock on that prefix, and a human who could
 * backdate a sign-off could place it before bytes they never saw.
 */
export type EventType =
  | "task.registered"
  | "route.proposed"
  | "route.accepted"
  | "approval.requested"
  | "approval.granted"
  | "approval.rejected"
  | "approval.expired"
  | "approval.revoked"
  | "approval.withdrawn"
  | "execution.started"
  | "execution.completed"
  | "execution.failed"
  | "execution.indeterminate"
  | "execution.reconciled"
  | "budget.exceeded"
  | "policy.updated"
  | "policy.proposed"
  | "policy.declined"
  | "envelope.drift"
  | "audit.sampled"
  | "audit.reviewed"
  | "audit.dark_session"
  | "audit.decision_refused"
  | "audit.gesture_refused"
  | "audit.question_preempted"
  | "audit.lock_reclaimed"
  | "reconciliation.required"
  | "reconciliation.satisfied"
  | "payload.pruned"
  | "gate.opened"
  | "gate.closed"
  | "gate.bypassed"
  | "gate.organ.attested"
  | "gate.path.signed_off"
  | "log.checkpoint";

/**
 * Caller-supplied content of an event. Chain fields are not accepted.
 *
 * Nor is `daemon` (APRV-383): which daemon wrote a record is a fact about the
 * writing PROCESS, and a member here would be a field any caller could set. It is
 * stamped by {@link buildRecord} from `core/daemon-identity.ts`'s process state,
 * and a caller that puts the property on its input object anyway is ignored,
 * because a record is composed field by field rather than spread.
 */
export interface EventInput {
  /** RFC 3339 timestamp. Supplied by the caller; never read from the clock. */
  ts: string;
  event: EventType;
  /** `human:`, `agent:`, or `system:` prefixed identity (SPEC.md §8). */
  actor: string;
  task?: string;
  action_key?: string;
  channel?: string;
  payload?: Record<string, unknown>;
}

/** A complete log record: caller content plus runtime-stamped chain fields. */
export interface EventRecord extends EventInput {
  seq: number;
  alg: typeof ALG;
  hash: string;
  prev: string | null;
  /**
   * WHICH daemon instance appended this record (APRV-383), present exactly on the
   * records a declaring daemon process wrote.
   *
   * OPTIONAL and additive: every record written before the field existed
   * validates and verifies unchanged, and its absence means what it has always
   * meant — nothing about this record says a daemon wrote it. It is a top-level
   * field, so the record's own chain hash covers it the way it covers `actor`; it
   * never reaches a payload hash or a token, and nothing in the runtime reads it
   * as an input to a verdict (SPEC.md §11.1 invariant 4, and
   * `core/daemon-identity.ts` for the whole of that argument).
   */
  daemon?: string;
}

/** The hash input: a record with every field except `hash`. */
export type UnhashedRecord = Omit<EventRecord, "hash">;

/**
 * Why an append was refused. Every failure is one of these, never a throw.
 *
 * Frozen public API in the same sense the gate's refusal codes are: callers
 * branch on these strings, so adding one is a spec change and renaming one is a
 * breaking change. `head-moved` is the APRV-20 addition (finding B1), sanctioned
 * by the human decision of 2026-08-07.
 */
export const APPEND_ERROR_CODES = [
  /** The lockfile was held by another writer for longer than the timeout. */
  "lock-timeout",
  /** The file's last line is truncated or unparseable; nothing may chain onto it. */
  "corrupt-tail",
  /** The complete record failed the `event` schema at the write boundary. */
  "validation",
  /** The record could not be canonicalized (RFC 8785). */
  "canonicalization",
  /** The log could not be created, opened, or written. */
  "io",
  /**
   * The caller supplied {@link AppendOptions.expectedHead} and the log's actual
   * tail, read under the lock, is a different `(seq, hash)`. Someone appended
   * between the caller's read and this append, so every read-dependent check the
   * caller made is stale. Nothing was written.
   */
  "head-moved",
  /**
   * The two identity refusals of APRV-383, spread in from
   * `core/daemon-identity.ts` where the logic that emits them lives: a daemon that
   * declared an unusable id, and a daemon whose id the attested policy's `daemons`
   * list does not admit. Both leave the file byte-identical, like every member
   * above them, and both are additions to the closed union rather than renames of
   * anything in it.
   */
  ...DAEMON_APPEND_REFUSAL_CODES,
] as const;

export type AppendErrorCode = (typeof APPEND_ERROR_CODES)[number];

export interface AppendError {
  code: AppendErrorCode;
  message: string;
  /** Schema errors, present when `code` is "validation". */
  errors?: ValidationError[];
}

export type AppendResult =
  | { ok: true; record: EventRecord; line: string }
  | { ok: false; error: AppendError };

/**
 * A chain head: the last record's position and digest.
 *
 * Defined here rather than in `core/verify.ts` because the writer needs it for
 * {@link AppendOptions.expectedHead} and the writer cannot import the verifier
 * (the verifier imports the writer). `core/verify.ts` re-exports this exact
 * type, so there is one definition and one meaning.
 */
export interface LogHead {
  seq: number;
  hash: string;
}

/** Options for {@link appendEvent}. */
export interface AppendOptions extends ValidateOptions {
  /** Milliseconds to keep retrying the lockfile before giving up. */
  lockTimeoutMs?: number;
  /** Milliseconds between lock acquisition attempts. */
  lockRetryMs?: number;
  /**
   * Compare-and-append precondition (guarantee 1b in the module header).
   *
   * - a `LogHead` — the append proceeds only if the log's tail is exactly that
   *   `(seq, hash)`;
   * - `null` — the append proceeds only if the log is empty or absent;
   * - absent/`undefined` — no precondition, the pre-APRV-20 behavior.
   *
   * Evaluated **under the lock**, after the tail is read and before anything is
   * computed or written. A mismatch is `head-moved` and writes nothing. Callers
   * that made a decision from the log MUST pass the head they read; callers with
   * no read-dependent decision (an unconditional append) legitimately omit it.
   */
  expectedHead?: LogHead | null;
}

/**
 * How long an append waits for `<log>.lock` before refusing `lock-timeout`, and
 * how often it tries. Exported (APRV-478) so a caller that waits for the lock
 * itself, on the event loop rather than in {@link acquireLock}'s synchronous
 * retry, keeps the same bound and cadence as every other writer.
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
export const DEFAULT_LOCK_RETRY_MS = 20;

/** How long a whole-operation lock holder waits before reporting `lock-timeout`. */
export interface LockOptions {
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}

/** The outcome of {@link withAppendLock}: the callback's value, or a refusal. */
export type LockedResult<T> = { ok: true; value: T } | { ok: false; error: AppendError };

/**
 * Strip `hash` and canonicalize. Exported shape is documented on
 * {@link computeRecordHash}; kept separate so hashing and verification cannot
 * drift apart.
 */
function hashInput(record: UnhashedRecord | EventRecord): UnhashedRecord {
  const clone: Record<string, unknown> = { ...(record as Record<string, unknown>) };
  delete clone["hash"];
  return clone as unknown as UnhashedRecord;
}

/**
 * The record's digest under `alg: "sha256/jcs"`.
 *
 * Hash input = **the full record minus its `hash` property**, with `prev`
 * included, serialized per RFC 8785 (JCS) and digested with SHA-256. Output is
 * lowercase hex. Passing an already-hashed record is fine: the `hash` field is
 * removed before canonicalization, so `computeRecordHash(r)` is stable whether
 * or not `r` carries a digest.
 */
export function computeRecordHash(record: UnhashedRecord | EventRecord): string {
  return createHash("sha256").update(canonicalize(hashInput(record)), "utf8").digest("hex");
}

/**
 * Inverse of {@link computeRecordHash}: recompute and compare. Lives beside
 * the writer so the two can never diverge; the M1 chain verifier consumes it.
 */
export function verifyRecordHash(record: EventRecord): boolean {
  try {
    return computeRecordHash(record) === record.hash;
  } catch {
    // A record that cannot be canonicalized cannot be authentic.
    return false;
  }
}

/** The stored line for a record: its canonical serialization (no newline). */
export function serializeRecord(record: EventRecord): string {
  return canonicalize(record);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function fail(code: AppendErrorCode, message: string, errors?: ValidationError[]): AppendResult {
  return { ok: false, error: errors === undefined ? { code, message } : { code, message, errors } };
}

/** Synchronous sleep with no dependency and no busy-spin. */
function sleepSync(ms: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

/** `O_APPEND` writer flags; `O_EXCL` added for the first try, so creation is known. */
const APPEND_FLAGS = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT;
/** The mode Node's `"a"` opens with; the umask applies as it always did. */
const APPEND_MODE = 0o666;

/**
 * Open `logPath` for append and say whether this call created it. `O_EXCL`
 * first: under the append lock no other sanctioned writer can race the create, so
 * `EEXIST` means the file was already there and a plain append open follows.
 */
function openForAppend(logPath: string): { fd: number; created: boolean } {
  const writeLayer = appendWriteLayer();
  try {
    return { fd: writeLayer.open(logPath, APPEND_FLAGS | fsConstants.O_EXCL, APPEND_MODE), created: true };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  }
  return { fd: writeLayer.open(logPath, APPEND_FLAGS, APPEND_MODE), created: false };
}

/**
 * The errors a directory fsync returns on a filesystem that cannot sync a
 * directory at all (some FUSE, SMB and drvfs mounts). PostgreSQL ignores the
 * same set for the same reason: there, every first append would otherwise
 * report io with record 1 already in the file, inviting a re-run and a
 * duplicate. EIO and everything else still fail the append.
 */
const DIRECTORY_FSYNC_UNSUPPORTED = new Set(["EINVAL", "EBADF", "ENOTSUP", "EOPNOTSUPP"]);

/**
 * fsync a directory, so a name created in it survives a crash. Windows cannot
 * open a directory for this and its filesystems journal names themselves, so it
 * is skipped there, as is a filesystem that reports directory fsync as
 * unsupported; everywhere else a failure is the caller's to report.
 */
function fsyncDirectory(dir: string): void {
  if (process.platform === "win32") return;
  const writeLayer = appendWriteLayer();
  const fd = writeLayer.open(dir, fsConstants.O_RDONLY, 0);
  try {
    writeLayer.fsync(fd);
  } catch (cause) {
    if (!DIRECTORY_FSYNC_UNSUPPORTED.has((cause as NodeJS.ErrnoException).code ?? "")) throw cause;
  } finally {
    try {
      writeLayer.close(fd);
    } catch {
      // The fsync above is what mattered; a failed close of a read-only
      // directory handle changes nothing on disk.
    }
  }
}

/**
 * The directories whose entries a first append made new: the log's own
 * directory (which gained the file), and, when `withAppendLock` had to create
 * directories, the parent of each one it created, up to and including the
 * parent of the topmost. Ordered innermost first.
 */
function directoriesToSync(logPath: string, firstCreatedDir: string | undefined): string[] {
  const dirs = [dirname(logPath)];
  if (firstCreatedDir === undefined) return dirs;
  const stop = dirname(firstCreatedDir);
  for (let dir = dirs[0] as string; dir !== stop; ) {
    const parent = dirname(dir);
    if (parent === dir) break; // the filesystem root: nothing above to sync
    dirs.push(parent);
    dir = parent;
  }
  return dirs;
}

type LockOutcome =
  | { ok: true; own: OwnLock; releaseGuard: () => void }
  | { ok: false; error: AppendError };

/**
 * Acquire `<logPath>.lock` by `open(…, "wx")` — atomic create-or-fail, which
 * needs no dependency and works on every platform Node supports — and write
 * this process's holder record into it (APRV-479). Retries with a fixed delay
 * until `timeoutMs` elapses, then reports `lock-timeout`.
 *
 * A lock is never stolen from a holder that may be alive: silently breaking
 * someone else's lock is how two writers end up sharing a `seq`. What changed
 * with APRV-479 is a holder that is PROVABLY gone. The first time a wait finds
 * the lock held (once per wait, never per retry) it asks
 * {@link tryReclaimLock}, which judges the holder record and, only when its
 * process is gone, removes the lockfile atomically, leaving the record of the
 * reclaim pending beside it; the create is then tried again at once. A reclaim
 * that another writer's create beat is ordinary contention, and that writer
 * appends the pending record first (see {@link lockedRun}), so the record is
 * never lost with this wait. A lock that was kept is named, with the reason, in
 * the `lock-timeout` message.
 *
 * The termination-signal guard ({@link guardTerminationWhileLocked}) spans each
 * create attempt and, after a successful one, the hold: it is taken before the
 * `open`, so no default-disposition signal can kill this process between
 * creating the lockfile and removing it, and settled before every sleep between
 * attempts, so a signal during the wait is never held (APRV-479, S2).
 */
function acquireLock(logPath: string, timeoutMs: number, retryMs: number, op: LockOp): LockOutcome {
  const path = `${logPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  let judged = false;
  let kept: string | undefined;
  for (;;) {
    const releaseGuard = guardTerminationWhileLocked();
    try {
      const own = createLockFile(path, op);
      return { ok: true, own, releaseGuard };
    } catch (cause) {
      releaseGuard();
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        return {
          ok: false,
          error: { code: "io", message: `lockfile ${path} could not be created: ${errorMessage(cause)}` },
        };
      }
      if (!judged) {
        judged = true;
        const outcome = tryReclaimLock(logPath);
        if (outcome.kind === "kept") kept = outcome.why;
        // Reclaimed, or gone by the time it was read: the create again, now.
        if (outcome.kind !== "kept") continue;
      }
      if (Date.now() >= deadline) {
        const holder = kept === undefined ? "" : ` (${kept})`;
        return {
          ok: false,
          error: {
            code: "lock-timeout",
            // A zero timeout is a single try by request (APRV-478: a caller that
            // waits for the lock on its own event loop), and "gave up after 0ms"
            // would read as a writer that never tried.
            message:
              timeoutMs <= 0
                ? `another writer holds ${path}; this append tried the lock once, as its caller asked, and did not wait${holder}`
                : `another writer holds ${path}; gave up after ${timeoutMs}ms${holder}`,
          },
        };
      }
      settleTerminationGuards();
      sleepSync(retryMs);
    }
  }
}

/**
 * Is `<logPath>.lock` present right now (APRV-478)?
 *
 * ADVISORY, and nothing else. It takes no lock, writes nothing, and authorizes
 * nothing: the answer can be stale the instant it is returned. It exists so a
 * caller that must not block its event loop (a harness hook between a grant and
 * its spend, which has to stay answerable to a signal) can wait out another
 * writer by sleeping on a timer, and only then make its one synchronous attempt
 * (`lockTimeoutMs: 0`). That attempt is still {@link acquireLock}'s atomic
 * create-or-fail, and the head is still compared under the lock, so a probe
 * that said "free" and was wrong costs a refused attempt and never a shared
 * `seq`. A probe that cannot stat the path answers `false`, and the attempt
 * then meets the real error.
 */
export function appendLockHeld(logPath: string): boolean {
  return existsSync(`${logPath}.lock`);
}

/**
 * Remove this process's own lockfile, and only it (APRV-479: a lockfile that is
 * not the one this process wrote is somebody else's). Best effort: the lock is
 * advisory and a failed unlink must not mask the append's own result.
 */
function releaseLock(own: OwnLock): void {
  try {
    releaseLockFile(own);
  } catch {
    // As above.
  }
}

interface TailState {
  seq: number;
  hash: string | null;
}

type TailOutcome = { ok: true; tail: TailState } | { ok: false; error: AppendError };

/**
 * How many bytes of the file's end {@link readLastLine} reads first, doubling
 * until it has a whole line. One record of this log is a few hundred bytes, so
 * a single read almost always suffices.
 */
const TAIL_WINDOW_BYTES = 64 * 1024;

/** The byte a log line ends with. */
const NEWLINE_BYTE = 0x0a;

type LastLineOutcome =
  | { ok: true; last: string | null; terminated: boolean }
  | { ok: false; error: AppendError };

/**
 * The file's final line, read from the END of the file rather than by reading
 * the whole log (APRV-206).
 *
 * An append needs exactly two facts about the existing file: whether it ends
 * with a newline, and what its last complete line says. Reading the entire log
 * to learn them made every append — every grant, every tap — pay one full read
 * of a file that only grows. This reads a window off the tail and doubles it
 * until the window either contains a newline before the final one (so the last
 * line is whole inside it) or has reached the start of the file.
 *
 * `last` is `null` for an empty file. `terminated` is false when the file's last
 * byte is not a newline, which is the torn tail {@link readTail} refuses.
 *
 * The window is decoded as UTF-8 only after being cut at a newline boundary, so
 * a multi-byte character can never be split across the cut: every byte of the
 * returned line came from between two newlines (or from the start of the file).
 */
function readLastLine(logPath: string): LastLineOutcome {
  let fd: number;
  try {
    fd = openSync(logPath, "r");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, last: null, terminated: true };
    }
    return {
      ok: false,
      error: { code: "io", message: `log ${logPath} could not be read: ${errorMessage(cause)}` },
    };
  }

  try {
    const size = fstatSync(fd).size;
    if (size === 0) return { ok: true, last: null, terminated: true };

    for (let window = TAIL_WINDOW_BYTES; ; window *= 2) {
      const length = Math.min(window, size);
      const start = size - length;
      const buffer = Buffer.allocUnsafe(length);
      // `read(2)` may return short. Loop until the window is full rather than
      // trusting one call: a short read would leave uninitialised bytes in the
      // buffer and a garbage "last line" built out of them.
      for (let filled = 0; filled < length; ) {
        const got = readSync(fd, buffer, filled, length - filled, start + filled);
        if (got === 0) {
          return {
            ok: false,
            error: {
              code: "io",
              message: `log ${logPath} ended early while reading its tail: wanted ${String(length)} bytes at offset ${String(start)}, got ${String(filled)}`,
            },
          };
        }
        filled += got;
      }

      const terminated = buffer[length - 1] === NEWLINE_BYTE;
      // The last line runs from just after the newline before it, to the end of
      // the file (minus its own terminator when it has one).
      const end = terminated ? length - 1 : length;
      const cut = buffer.lastIndexOf(NEWLINE_BYTE, end - 1);
      if (cut === -1 && start > 0) {
        // The line is longer than this window and the window does not reach the
        // start of the file: widen and look again.
        continue;
      }
      return {
        ok: true,
        last: buffer.toString("utf8", cut + 1, end),
        terminated,
      };
    }
  } catch (cause) {
    return {
      ok: false,
      error: { code: "io", message: `log ${logPath} could not be read: ${errorMessage(cause)}` },
    };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Nothing actionable: the read is done and the result stands.
    }
  }
}

/**
 * Determine the next `seq`/`prev` from the existing file. Refuses on any tail
 * that is not a complete, parseable record: a missing trailing newline means a
 * previous writer died mid-line, and chaining onto it would make the damage
 * permanent.
 */
function readTail(logPath: string): TailOutcome {
  const tailRead = readLastLine(logPath);
  if (!tailRead.ok) return { ok: false, error: tailRead.error };

  if (tailRead.last === null) return { ok: true, tail: { seq: 0, hash: GENESIS_PREV } };

  if (!tailRead.terminated) {
    return {
      ok: false,
      error: {
        code: "corrupt-tail",
        message: `log ${logPath} ends without a newline: the last line is truncated, refusing to append onto a partial record`,
      },
    };
  }

  const last = tailRead.last;
  if (last.trim().length === 0) {
    return {
      ok: false,
      error: {
        code: "corrupt-tail",
        message: `log ${logPath} ends with a blank line; refusing to append onto an ambiguous tail`,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "corrupt-tail",
        message: `log ${logPath} last line is not valid JSON (${errorMessage(cause)}); refusing to append`,
      },
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: {
        code: "corrupt-tail",
        message: `log ${logPath} last line is not a JSON object; refusing to append`,
      },
    };
  }

  const record = parsed as Record<string, unknown>;
  const seq = record["seq"];
  const hash = record["hash"];
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
    return {
      ok: false,
      error: {
        code: "corrupt-tail",
        message: `log ${logPath} last line has no usable integer "seq"; refusing to append`,
      },
    };
  }
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
    return {
      ok: false,
      error: {
        code: "corrupt-tail",
        message: `log ${logPath} last line has no usable 64-hex "hash"; refusing to append`,
      },
    };
  }

  return { ok: true, tail: { seq, hash } };
}

/**
 * Evaluate the compare-and-append precondition against the tail read under the
 * lock. Returns the refusal, or `null` when the append may proceed.
 *
 * `tail.hash === null` (with `seq` 0) is the empty log, which is exactly what
 * `expectedHead: null` asserts. Anything else is a head that moved: the message
 * names both heads because the operator's next question is always "moved to
 * what?".
 */
function headPrecondition(
  logPath: string,
  expected: LogHead | null,
  tail: TailState,
): AppendError | null {
  const actual = tail.hash === null ? "empty" : `seq ${tail.seq} ${tail.hash}`;
  if (expected === null) {
    if (tail.hash === null) return null;
    return {
      code: "head-moved",
      message: `log ${logPath} was expected to be empty but its head is ${actual}; a record was appended between the caller's read and this append, so the checks that authorized it are stale. Nothing was written.`,
    };
  }
  if (tail.seq === expected.seq && tail.hash === expected.hash) return null;
  return {
    code: "head-moved",
    message: `log ${logPath} head moved: expected seq ${expected.seq} ${expected.hash}, found ${actual}. A record was appended between the caller's read and this append, so the checks that authorized it are stale. Nothing was written; re-reading and re-deciding is the caller's choice, never this module's.`,
  };
}

/**
 * Build a complete record from caller content plus chain state. Property
 * insertion order is irrelevant to the digest (JCS sorts keys) but is kept
 * readable here for anyone eyeballing the code.
 *
 * `daemon` comes from the writing process and never from `input`, which is why it
 * is a parameter here rather than a member of {@link EventInput}: this function
 * composes a record field by field, so there is no spelling of a caller's input
 * that can put a `daemon` on a record.
 */
function buildRecord(
  input: EventInput,
  seq: number,
  prev: string | null,
  daemon: string | null,
): EventRecord {
  const record: EventRecord = {
    seq,
    ts: input.ts,
    event: input.event,
    actor: input.actor,
    alg: ALG,
    prev,
    hash: "",
  };
  // Beside `actor`, because it answers the same question about a different layer:
  // who caused the event, and which process wrote it down.
  if (daemon !== null) record.daemon = daemon;
  if (input.task !== undefined) record.task = input.task;
  if (input.action_key !== undefined) record.action_key = input.action_key;
  if (input.channel !== undefined) record.channel = input.channel;
  if (input.payload !== undefined) record.payload = input.payload;
  record.hash = computeRecordHash(record);
  return record;
}

/**
 * Append exactly one event to `logPath`, stamping `seq`, `prev`, `alg`, and
 * `hash`.
 *
 * Returns a structured result rather than throwing: an append that cannot be
 * made safely leaves the file byte-identical and says why.
 *
 * Pass {@link AppendOptions.expectedHead} whenever the append is authorized by
 * something read from the log: the head is compared under the lock and a moved
 * head refuses `head-moved` without writing.
 */
/**
 * Hold `<logPath>.lock` for the whole of `run`, then release it.
 *
 * The lockfile exists so that a read-tail → compute → write sequence cannot
 * interleave with another writer's. Some operations need that exclusion over a
 * span much longer than one append: `approval log sync` (APRV-125) reads the
 * chain, moves the file aside, lets git advance the committed baseline, and
 * puts the chain back, and an append landing anywhere inside that window is
 * exactly the interleaving that forked this repository's own log on 2026-08-20.
 *
 * The callback is handed no lock handle and no write primitive: this module
 * still exposes nothing that mutates an existing byte, and a caller holding the
 * lock has the same append-only API everyone else has. What it gains is the
 * guarantee that nobody else is appending while it works.
 */
export function withAppendLock<T>(
  logPath: string,
  run: () => T,
  options: LockOptions = {},
): LockedResult<T> {
  return lockedRun(logPath, () => run(), options, "hold");
}

/**
 * {@link withAppendLock}, also telling `run` the first directory its `mkdir`
 * created (`undefined` when the log's directory already existed), which the
 * append needs to know which directory entries are new (APRV-440).
 */
function lockedRun<T>(
  logPath: string,
  run: (firstCreatedDir: string | undefined) => T,
  options: LockOptions,
  op: LockOp,
): LockedResult<T> {
  let firstCreatedDir: string | undefined;
  try {
    firstCreatedDir = mkdirSync(dirname(logPath), { recursive: true });
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "io",
        message: `log directory for ${logPath} could not be created: ${errorMessage(cause)}`,
      },
    };
  }

  const lock = acquireLock(
    logPath,
    options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS,
    op,
  );
  if (!lock.ok) return { ok: false, error: lock.error };

  let reclaimWrote = false;
  try {
    try {
      // Every reclaim whose record is not yet in the log, this writer's own or
      // another's that lost the create to this one (APRV-479, S1), is recorded
      // first, before the caller reads the tail.
      for (const pending of pendingReclaims(logPath)) {
        const recorded = appendReclaimRecord(logPath, pending.note, firstCreatedDir);
        if (recorded.wrote) reclaimWrote = true;
        if (!recorded.result.ok) return { ok: false, error: recorded.result.error };
        clearPendingReclaim(pending);
      }
      return { ok: true, value: run(firstCreatedDir) };
    } finally {
      releaseLock(lock.own);
    }
  } finally {
    lock.releaseGuard();
    if (reclaimWrote) noteAppend(logPath);
  }
}

/**
 * The record of a reclaimed lock (APRV-479), appended as the first write under
 * the next lock any writer takes after the reclaim: before the caller's own read
 * of the tail, so the caller's compare-and-append sees it as the moved head it
 * is. Written through the same path as every other record, with no head
 * precondition (it decides nothing from the log) and the same daemon stamp. It
 * authorizes nothing and nothing reads it to decide anything.
 *
 * The record is pending in a file beside the lock from before the reclaim's
 * commit point until it is appended, so it is never lost with the reclaimer:
 * when it cannot be appended the caller's operation is refused with the
 * writer's own error, the lock is released, and the record stays pending for
 * the next writer (which meets the same refusal while the log takes no record
 * at all: a corrupt tail, a full disk, a daemon refused its id). It is removed
 * only after it was appended; a writer killed between the two leaves it to be
 * appended again, so the one failure left is a duplicate record, never a
 * missing one.
 */
function appendReclaimRecord(
  logPath: string,
  note: PendingReclaim["note"],
  firstCreatedDir: string | undefined,
): { result: AppendResult; wrote: boolean } {
  const stamp = daemonStampForAppend();
  if (stamp.kind === "refuse") return { result: fail(stamp.code, stamp.message), wrote: false };
  const payload: Record<string, unknown> = {
    lockfile: note.lockfile,
    reason: note.reason,
    age_ms: note.age_ms,
  };
  if (note.holder !== undefined) payload["holder"] = { ...note.holder };
  const recorded = appendUnderLock(
    logPath,
    { ts: systemClock(), event: "audit.lock_reclaimed", actor: "system:log", payload },
    {},
    firstCreatedDir,
    stamp.kind === "stamp" ? stamp.id : null,
  );
  if (recorded.result.ok) return recorded;
  return {
    result: {
      ok: false,
      error: {
        ...recorded.result.error,
        message: `${recorded.result.error.message} (${note.lockfile} was reclaimed from a holder that is gone${note.why === undefined ? "" : `, ${note.why}`}, and this writer could not record the reclaim, so it appended nothing; the record stays pending for the next writer)`,
      },
    },
    wrote: recorded.wrote,
  };
}

/**
 * Listeners told that this process appended to a log (APRV-217).
 *
 * One subscriber exists: the verified-read cache, which marks the log it wrote
 * for a full re-proof on its next read. It is a registration rather than a call
 * into `core/state.ts` because a value import that way would close a cycle
 * through `core/verify.ts`. Nothing a listener does can change what was
 * appended — the append has already succeeded — and a listener that throws must
 * not turn a written record into a failed one, so throws are swallowed.
 */
const appendListeners: Array<(logPath: string) => void> = [];

/**
 * Subscribe to appends that put bytes in the file: every successful one, and
 * since APRV-440 one that wrote and then failed to confirm them durable (a
 * short write, a failed fsync). Process-wide, memory-only, additive.
 */
export function onLogAppended(listener: (logPath: string) => void): void {
  appendListeners.push(listener);
}

function noteAppend(logPath: string): void {
  for (const listener of appendListeners) {
    try {
      listener(logPath);
    } catch {
      // A bookkeeping listener may not un-write a record that is on disk.
    }
  }
}

export function appendEvent(
  logPath: string,
  input: EventInput,
  options: AppendOptions = {},
): AppendResult {
  // Which daemon is writing, and whether it may (APRV-383). Asked of this
  // process's own state rather than of the caller, and asked BEFORE the lock
  // because it reads no log state: taking a lock only to refuse would make every
  // other writer wait for an answer that was never going to touch the file. It is
  // the write boundary in the sense that matters — one code path, nothing written
  // on the refused branch, and the record's own schema pins the field's shape so a
  // malformed id could not land even if this check were absent.
  const stamp = daemonStampForAppend();
  if (stamp.kind === "refuse") return fail(stamp.code, stamp.message);
  const daemon = stamp.kind === "stamp" ? stamp.id : null;

  // Set once bytes may reach the file, success or not: the read cache
  // must re-prove a log whose bytes changed even when the append then failed to
  // confirm them durable.
  let wrote = false;
  const held = lockedRun<AppendResult>(
    logPath,
    (firstCreatedDir) => {
      const appended = appendUnderLock(logPath, input, options, firstCreatedDir, daemon);
      wrote = appended.wrote;
      return appended.result;
    },
    options,
    "append",
  );

  const result: AppendResult = held.ok ? held.value : { ok: false, error: held.error };
  // After the lock is released, for every append that put bytes in the file:
  // the reader cache must not serve a prefix proof anchored before this write.
  if (wrote) noteAppend(logPath);
  return result;
}

/**
 * One append, with `<logPath>.lock` already held by this process: read the
 * tail, compare the head, build, validate, write, fsync. The body of
 * {@link appendEvent}, shared with the reclaim record (APRV-479) so that record
 * goes through every check any other record does. `wrote` says whether bytes
 * may have reached the file, success or not.
 */
function appendUnderLock(
  logPath: string,
  input: EventInput,
  options: AppendOptions,
  firstCreatedDir: string | undefined,
  daemon: string | null,
): { result: AppendResult; wrote: boolean } {
  let wrote = false;
  const done = (result: AppendResult): { result: AppendResult; wrote: boolean } => ({ result, wrote });
  const run = (): AppendResult => {
    const tail = readTail(logPath);
    if (!tail.ok) return { ok: false, error: tail.error };

    // Compare-and-append: the precondition is evaluated here, inside the lock,
    // against the tail that was just read. Outside the lock it would be exactly
    // the race it exists to close.
    if (options.expectedHead !== undefined) {
      const moved = headPrecondition(logPath, options.expectedHead, tail.tail);
      if (moved !== null) return { ok: false, error: moved };
    }

    let record: EventRecord;
    let line: string;
    try {
      record = buildRecord(input, tail.tail.seq + 1, tail.tail.hash, daemon);
      // Stored line = JCS of the complete record; digest input excluded `hash`.
      line = serializeRecord(record);
    } catch (cause) {
      if (cause instanceof JcsError) {
        return fail("canonicalization", `record could not be canonicalized: ${cause.message}`);
      }
      return fail("canonicalization", `record could not be prepared: ${errorMessage(cause)}`);
    }

    // Write boundary: nothing reaches the file until the schema says yes.
    const validation = validate(
      "event",
      record,
      options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
    );
    if (!validation.ok) {
      return fail(
        "validation",
        `event failed schema validation at the write boundary; log left unchanged`,
        validation.errors,
      );
    }

    let opened: { fd: number; created: boolean };
    try {
      opened = openForAppend(logPath);
    } catch (cause) {
      return fail("io", `log ${logPath} could not be opened for append: ${errorMessage(cause)}`);
    }
    const { fd, created } = opened;
    const writeLayer = appendWriteLayer();
    const bytes = Buffer.from(`${line}\n`, "utf8");
    try {
      // Single write syscall on an O_APPEND handle: the line lands whole or not at all.
      // Set BEFORE the write: one that throws may still have put bytes in the
      // file, and a needless re-proof by the read cache costs only time.
      wrote = true;
      let written: number;
      try {
        written = writeLayer.write(fd, bytes);
      } catch (cause) {
        return fail("io", `log ${logPath} could not be written: ${errorMessage(cause)}`);
      }
      if (written !== bytes.length) {
        return fail(
          "io",
          `log ${logPath} took ${String(written)} of ${String(bytes.length)} bytes of seq ${String(record.seq)}: the write was short, so the file now ends with a torn line and the record was not appended`,
        );
      }
      // Durable before ok (guarantee 5b). Until this returns, the record exists
      // in the page cache only, and a kill before writeback leaves the file
      // extended over unwritten blocks: a NUL-filled tail where the record was.
      try {
        writeLayer.fsync(fd);
      } catch (cause) {
        return fail(
          "io",
          `log ${logPath}: seq ${String(record.seq)} was written but fsync failed (${errorMessage(cause)}), so it is not known to be durable: it may be in the file now and gone after a crash. Re-read the log before deciding anything from it.`,
        );
      }
    } finally {
      try {
        writeLayer.close(fd);
      } catch {
        // Nothing actionable: the bytes are written and, on the ok path, synced.
      }
    }

    // A new file is a new directory entry, and fsync of the file does not make
    // its NAME durable: without this a crash can keep the bytes and lose the file.
    if (created) {
      for (const dir of directoriesToSync(logPath, firstCreatedDir)) {
        try {
          fsyncDirectory(dir);
        } catch (cause) {
          return fail(
            "io",
            `log ${logPath}: seq ${String(record.seq)} was written and synced but its directory ${dir} could not be (${errorMessage(cause)}), so the newly created file is not known to survive a crash. Re-read the log before deciding anything from it.`,
          );
        }
      }
    }

    return { ok: true, record, line };
  };
  return done(run());
}
