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
 *    into every subsequent hash.
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
 *
 * Determinism: `ts` is supplied by the caller. This module never reads the
 * clock, because a hash-relevant field sourced from ambient state would make
 * the log irreproducible.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import { canonicalize, JcsError } from "./jcs.js";
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
  | "budget.exceeded"
  | "policy.updated"
  | "envelope.drift"
  | "audit.sampled"
  | "audit.reviewed"
  | "payload.pruned";

/** Caller-supplied content of an event. Chain fields are not accepted. */
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

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_LOCK_RETRY_MS = 20;

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

type LockOutcome = { ok: true; path: string } | { ok: false; error: AppendError };

/**
 * Acquire `<logPath>.lock` by `open(…, "wx")` — atomic create-or-fail, which
 * needs no dependency and works on every platform Node supports. Retries with
 * a fixed delay until `timeoutMs` elapses, then reports `lock-timeout`. A
 * stale lock is never stolen: silently breaking someone else's lock is how two
 * writers end up sharing a `seq`.
 */
function acquireLock(logPath: string, timeoutMs: number, retryMs: number): LockOutcome {
  const path = `${logPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      closeSync(openSync(path, "wx"));
      return { ok: true, path };
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        return {
          ok: false,
          error: { code: "io", message: `lockfile ${path} could not be created: ${errorMessage(cause)}` },
        };
      }
      if (Date.now() >= deadline) {
        return {
          ok: false,
          error: {
            code: "lock-timeout",
            message: `another writer holds ${path}; gave up after ${timeoutMs}ms`,
          },
        };
      }
      sleepSync(retryMs);
    }
  }
}

function releaseLock(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Best effort: the lock is advisory and a failed unlink must not mask the
    // append's own result.
  }
}

interface TailState {
  seq: number;
  hash: string | null;
}

type TailOutcome = { ok: true; tail: TailState } | { ok: false; error: AppendError };

/**
 * Determine the next `seq`/`prev` from the existing file. Refuses on any tail
 * that is not a complete, parseable record: a missing trailing newline means a
 * previous writer died mid-line, and chaining onto it would make the damage
 * permanent.
 */
function readTail(logPath: string): TailOutcome {
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, tail: { seq: 0, hash: GENESIS_PREV } };
    }
    return {
      ok: false,
      error: { code: "io", message: `log ${logPath} could not be read: ${errorMessage(cause)}` },
    };
  }

  if (raw.length === 0) return { ok: true, tail: { seq: 0, hash: GENESIS_PREV } };

  if (!raw.endsWith("\n")) {
    return {
      ok: false,
      error: {
        code: "corrupt-tail",
        message: `log ${logPath} ends without a newline: the last line is truncated, refusing to append onto a partial record`,
      },
    };
  }

  const lines = raw.split("\n");
  lines.pop(); // trailing "" after the final newline
  const last = lines[lines.length - 1];
  if (last === undefined || last.trim().length === 0) {
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
 */
function buildRecord(input: EventInput, seq: number, prev: string | null): EventRecord {
  const record: EventRecord = {
    seq,
    ts: input.ts,
    event: input.event,
    actor: input.actor,
    alg: ALG,
    prev,
    hash: "",
  };
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
export function appendEvent(
  logPath: string,
  input: EventInput,
  options: AppendOptions = {},
): AppendResult {
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;

  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch (cause) {
    return fail("io", `log directory for ${logPath} could not be created: ${errorMessage(cause)}`);
  }

  const lock = acquireLock(logPath, lockTimeoutMs, lockRetryMs);
  if (!lock.ok) return { ok: false, error: lock.error };

  try {
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
      record = buildRecord(input, tail.tail.seq + 1, tail.tail.hash);
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

    let fd: number;
    try {
      fd = openSync(logPath, "a");
    } catch (cause) {
      return fail("io", `log ${logPath} could not be opened for append: ${errorMessage(cause)}`);
    }
    try {
      // Single write syscall on an O_APPEND handle: the line lands whole or not at all.
      writeSync(fd, `${line}\n`);
    } catch (cause) {
      return fail("io", `log ${logPath} could not be written: ${errorMessage(cause)}`);
    } finally {
      try {
        closeSync(fd);
      } catch {
        // Nothing actionable; the data is already handed to the kernel.
      }
    }

    return { ok: true, record, line };
  } finally {
    releaseLock(lock.path);
  }
}
