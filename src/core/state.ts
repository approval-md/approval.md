/**
 * Derived state: the one place the runtime turns the log into answers
 * (SPEC.md §6.3, §7, §8).
 *
 * Everything the gate, the token module, and the executor believe about an
 * action comes from here. The module exists for two reasons, both structural,
 * both from the APRV-20 review:
 *
 * 1. **Verified reads (finding S1).** {@link readVerifiedRecords} is the only
 *    sanctioned way for a decision-making module to read the log. It runs the
 *    *full* chain verification — hash recompute, schema validation, `prev`/`seq`
 *    walk — by calling `core/verify.ts`'s {@link verifyWithRecords}, and refuses
 *    a corrupt log outright. Before this, the gate parsed lines as JSON and
 *    trusted them: a forged or spliced record could authorize an action, and the
 *    corruption would surface only when someone ran `approval log verify`. A
 *    permission system that reads its own evidence without checking it is not a
 *    permission system.
 *
 *    NOTE: linear-cost verification is accepted at v0.1; head-caching is an M5
 *    optimization. Every gate operation therefore walks the whole log. That is
 *    O(n) per call on a file that grows with every decision, and it is the right
 *    trade for now: correctness first, and an incremental verifier that caches a
 *    verified head is a measurable optimization with its own tests, not a thing
 *    to smuggle into a correctness fix.
 *
 * 2. **One derivation, no cycle (finding S4).** {@link requestState} used to
 *    live in `core/gate.ts`, which `core/token.ts` imported — while
 *    `core/gate.ts` imported `core/token.ts` to mint at grant. That import cycle
 *    made "which module owns approval state?" unanswerable. The derivation lives
 *    here now; `gate.ts`, `token.ts`, and `execute.ts` all import it, and the
 *    only remaining edge between them is the intended one, gate → token, at the
 *    mint seam. `gate.ts` re-exports the moved names so existing importers (the
 *    CLI, the tests) are unaffected.
 *
 * Determinism: nothing here reads the clock, the network, or any cache. `ts` is
 * a parameter everywhere, so a derivation can be replayed from the log exactly
 * as it was made.
 */

import { closeSync, openSync } from "node:fs";

import type { EventRecord, LogHead } from "./log.js";
import { verifyWithRecords, type VerifyOptions } from "./verify.js";

// ---------------------------------------------------------------------------
// Verified log reads
// ---------------------------------------------------------------------------

/**
 * Why a verified read refused. These names are shared verbatim by the gate, the
 * token module, and the executor, so the CLI maps all three onto the frozen exit
 * table with one function.
 */
export type LogReadRefusalCode =
  /** The log could not be opened (permissions, a directory, a broken path). */
  | "log-unreadable"
  /** The log's final line is unterminated: the signature of a crashed write. */
  | "log-torn-tail"
  /**
   * The chain does not verify: a mutated, spliced, reordered, or schema-invalid
   * record. Distinct from `log-unreadable` because the facts are different — one
   * is a filesystem problem, the other is evidence of tampering — and the
   * repairs are different. `approval log verify` owns the detailed vocabulary
   * (`hash-mismatch`, `seq-gap`, …); this code says only "the log is not
   * trustworthy, so nothing may be authorized from it".
   */
  | "log-corrupt";

/** A refused read. Structurally a subset of every consumer's refusal shape. */
export interface LogReadRefusal {
  ok: false;
  code: LogReadRefusalCode;
  message: string;
}

/** A successful verified read: the records and the head they end at. */
export interface VerifiedRecords {
  ok: true;
  records: EventRecord[];
  /**
   * The chain head — `(seq, hash)` of the last record, or `null` for an empty
   * log. This is what a caller passes as `appendEvent`'s `expectedHead`, so that
   * a decision made from these records cannot be appended onto a log that moved
   * underneath it (APRV-20 finding B1).
   */
  head: LogHead | null;
}

export type ReadRecordsResult = VerifiedRecords | LogReadRefusal;

function refuseRead(code: LogReadRefusalCode, message: string): LogReadRefusal {
  return { ok: false, code, message };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The head of a record list: the last record's `(seq, hash)`, or `null`. */
export function headOf(records: EventRecord[]): LogHead | null {
  const last = records[records.length - 1];
  return last === undefined ? null : { seq: last.seq, hash: last.hash };
}

/**
 * Read the log and refuse unless the whole chain verifies.
 *
 * An absent log is an empty log (nothing has happened yet), exactly as
 * `appendEvent` and `approval log verify` treat it.
 *
 * The file is opened once as a readability probe *before* verification so that
 * "I could not open this file" stays an I/O fact (`log-unreadable`) and never
 * arrives dressed as corruption — the same split the CLI's exit table draws, and
 * the one thing `verify()` alone cannot express, since from inside the chain
 * walker an unreadable log is indistinguishable from a broken one.
 *
 * Torn-tail behavior is unchanged from the pre-APRV-20 reader: the tear is
 * reported as `log-torn-tail` and nothing is repaired, because truncating a torn
 * line is a human decision.
 */
export function readVerifiedRecords(
  logPath: string,
  options: VerifyOptions = {},
): ReadRecordsResult {
  try {
    closeSync(openSync(logPath, "r"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, records: [], head: null };
    }
    return refuseRead(
      "log-unreadable",
      `log ${logPath} could not be read: ${errorMessage(cause)}`,
    );
  }

  const verified = verifyWithRecords(logPath, options);
  switch (verified.result.status) {
    case "clean":
      return { ok: true, records: verified.records, head: verified.result.head };
    case "torn-tail":
      return refuseRead(
        "log-torn-tail",
        `log ${logPath} ends without a newline: the final record is truncated, the signature of a crashed write. Nothing is repaired here; run \`approval log verify\`.`,
      );
    case "corrupt":
      return refuseRead(
        "log-corrupt",
        `log ${logPath} does not verify (${verified.result.reason}${
          verified.result.firstBadSeq === null ? "" : ` at seq ${verified.result.firstBadSeq}`
        }): ${verified.result.message}. Nothing may be authorized from a log that does not verify; run \`approval log verify\`.`,
      );
  }
}

// ---------------------------------------------------------------------------
// Approval state derivation
// ---------------------------------------------------------------------------

/**
 * One action's approval state, derived from the log.
 *
 * These are the gate's names for the approval lifecycle of SPEC.md §6.3. The
 * envelope's `state:` enum is the projection of the same thing over a whole
 * task (`proposed`/`awaiting`/`approved`/…); the mapping is one-to-one for the
 * action-scoped states and is applied by the projection layer, not here.
 */
export type RequestState =
  /** No `approval.requested` for this key. */
  | "none"
  /** Requested and undecided — the envelope's `awaiting`. */
  | "requested"
  /** A human granted it — the envelope's `approved`. */
  | "granted"
  | "rejected"
  | "revoked"
  /** TTL lapsed, by event or by arithmetic. */
  | "expired";

/** The three terminal decisions a human can record, plus runtime expiry. */
export type Decision = "grant" | "reject" | "revoke";

/** What the request declared, copied out of the `approval.requested` payload. */
export interface DeclaredAction {
  class: string | null;
  est_cost_usd: number | null;
  reversible: boolean | null;
  summary: string | null;
}

/** Execution facts for the action key: the seq of each event, or `null`. */
export interface ExecutionFacts {
  started: number | null;
  completed: number | null;
  failed: number | null;
}

/** The full derivation, so a caller never re-walks the log to explain itself. */
export interface RequestDerivation {
  actionKey: string;
  state: RequestState;
  task: string | null;
  requestSeq: number | null;
  requestTs: string | null;
  decision: "granted" | "rejected" | "revoked" | "expired" | null;
  decisionSeq: number | null;
  decisionTs: string | null;
  /** An `approval.expired` record exists for the current request. */
  expiredByEvent: boolean;
  /** The TTL lapsed by arithmetic, with no `approval.expired` record. */
  expiredLazily: boolean;
  declared: DeclaredAction;
  execution: ExecutionFacts;
}

/** A record's payload as a map, or `{}` when it has none. */
export function payloadOf(record: EventRecord): Record<string, unknown> {
  const payload = record.payload;
  return typeof payload === "object" && payload !== null ? payload : {};
}

function declaredFrom(record: EventRecord): DeclaredAction {
  const payload = payloadOf(record);
  const cls = payload["class"];
  const cost = payload["est_cost_usd"];
  const reversible = payload["reversible"];
  const summary = payload["summary"];
  return {
    class: typeof cls === "string" ? cls : null,
    est_cost_usd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    reversible: typeof reversible === "boolean" ? reversible : null,
    summary: typeof summary === "string" ? summary : null,
  };
}

/**
 * Derive `actionKey`'s approval state from `records`.
 *
 * Pure: no I/O, no clock. `ts` is the moment the question is being asked and is
 * **required** — lazy expiry is arithmetic on it, and a state function that read
 * the clock could not be replayed.
 *
 * Sequencing rules, all of them deliberate:
 *
 * - An `approval.requested` **resets** the derivation. A key that was rejected
 *   or expired may be requested again; the new request starts a fresh cycle and
 *   the old decision no longer governs. (An action that has *executed* is a
 *   different matter — `core/gate.ts`'s `request` refuses that on idempotency
 *   grounds.)
 * - The **first** decision after a request wins. The gate refuses to append a
 *   second one, so a log carrying two is a log written by something else; the
 *   fail-closed reading is that the earliest human decision stands rather than
 *   that a later append can overwrite it.
 * - Execution facts accumulate across the whole log for the key, independent of
 *   the request cycle: an action that has executed has executed, and no
 *   subsequent request un-executes it.
 * - Expiry: an `approval.expired` record sets `expiredByEvent`. With no such
 *   record, `ttlMs !== null` and `ts > requestTs + ttlMs` sets `expiredLazily`.
 *   Both yield `state: "expired"`. An unparseable `requestTs` or `ts` also
 *   yields `expired`: liveness that cannot be demonstrated is not assumed. (The
 *   event schema's `date-time` format makes that unreachable through the real
 *   append path; it is a backstop, not a live branch.)
 */
export function requestState(
  records: EventRecord[],
  actionKey: string,
  ts: string,
  ttlMs: number | null,
): RequestDerivation {
  let task: string | null = null;
  let requestSeq: number | null = null;
  let requestTs: string | null = null;
  let decision: RequestDerivation["decision"] = null;
  let decisionSeq: number | null = null;
  let decisionTs: string | null = null;
  let expiredByEvent = false;
  let declared: DeclaredAction = {
    class: null,
    est_cost_usd: null,
    reversible: null,
    summary: null,
  };
  const execution: ExecutionFacts = { started: null, completed: null, failed: null };

  const settle = (
    record: EventRecord,
    value: NonNullable<RequestDerivation["decision"]>,
  ): void => {
    if (requestSeq === null) return;
    // Revocation is the one decision that legitimately follows another: a
    // human withdraws a grant they already made, so `approval.revoked`
    // supersedes. Every other decision settles only an undecided request —
    // the gate refuses to append a second one, and a log carrying two was
    // written by something else, where the fail-closed reading is that the
    // earliest human answer stands rather than that a later append overwrites it.
    if (decision !== null && value !== "revoked") return;
    decision = value;
    decisionSeq = record.seq;
    decisionTs = record.ts;
    if (value === "expired") expiredByEvent = true;
  };

  for (const record of records) {
    if (record.action_key !== actionKey) continue;
    switch (record.event) {
      case "approval.requested":
        task = record.task ?? task;
        requestSeq = record.seq;
        requestTs = record.ts;
        decision = null;
        decisionSeq = null;
        decisionTs = null;
        expiredByEvent = false;
        declared = declaredFrom(record);
        break;
      case "approval.granted":
        settle(record, "granted");
        break;
      case "approval.rejected":
        settle(record, "rejected");
        break;
      case "approval.revoked":
        settle(record, "revoked");
        break;
      case "approval.expired":
        settle(record, "expired");
        break;
      case "execution.started":
        execution.started = record.seq;
        task = record.task ?? task;
        break;
      case "execution.completed":
        execution.completed = record.seq;
        break;
      case "execution.failed":
        execution.failed = record.seq;
        break;
      default:
        break;
    }
  }

  let state: RequestState;
  let expiredLazily = false;
  if (requestSeq === null) {
    state = "none";
  } else if (decision !== null) {
    state = decision;
  } else if (ttlMs === null) {
    // No `defaults.approval_ttl` means the policy declares no lapse. A request
    // stays live until a human decides it; inventing a default TTL here would
    // silently reject approvals a policy author never asked to expire.
    state = "requested";
  } else {
    const requestedAt = Date.parse(requestTs ?? "");
    const now = Date.parse(ts);
    if (Number.isNaN(requestedAt) || Number.isNaN(now)) {
      state = "expired";
      expiredLazily = true;
    } else if (now > requestedAt + ttlMs) {
      state = "expired";
      expiredLazily = true;
    } else {
      state = "requested";
    }
  }

  return {
    actionKey,
    state,
    task,
    requestSeq,
    requestTs,
    decision,
    decisionSeq,
    decisionTs,
    expiredByEvent,
    expiredLazily,
    declared,
    execution,
  };
}
