/**
 * The study operator's withdraw (APRV-527, amended SPEC.md §8, the study record).
 *
 * A hosted operator running a study may DENY one request that is still pending,
 * before it can run. It is never a grant, never an edit of a decision and never
 * a reopening: the verb calls the gate's `decide` with the constant `reject`,
 * under the constant actor `human:study-team` on the constant channel `study`,
 * and the record carries `payload.study {reason: "study_withdrawn", operator,
 * ref}`. Every reader that ignores the field reads an ordinary rejection, so the
 * requester's `wait` exits 1, the queue drops the request, and nothing executes.
 *
 * Four properties are load-bearing, and each is enforced here rather than by
 * whoever calls this:
 *
 * 1. **Off is a no-op.** Unless the process environment holds
 *    `APPROVAL_STUDY_MODE` exactly `1`, the verb refuses `study-mode-off` before
 *    it opens the log. The value is read from the environment and never from a
 *    policy, because nothing an agent can propose into a policy file may switch
 *    it on.
 * 2. **Pending only.** The verified log must derive `requested` for the key at
 *    this instant; anything else (granted, rejected, revoked, expired, withdrawn,
 *    never requested) is `not-pending`. `decide` then re-derives the state under
 *    its own head-moved retry, so a resident's tap that lands between this read
 *    and the append wins and the withdraw becomes `not-pending` too.
 * 3. **A too-late withdraw is on the record.** Like `approval reject`, a
 *    refused attempt that names one request appends ONE `audit.decision_refused`
 *    (`recordRefusedDecision`, under `human:study-team` on channel `study`, with
 *    the gate's own code): the study team's attempt is a decision a person made,
 *    and an invisible refusal would be a gap in the study's own record. Nothing
 *    is appended when study mode is off, on a replay, on an ambiguous ref, on a
 *    ref or key naming no request, or on a log fault. (The gate's own lazy
 *    `approval.expired` can also land when a TTL lapses inside the read-to-append
 *    window; see SPEC.md §11.2's preamble.)
 * 4. **Replay-safe.** The `ref` the operator supplies is matched against the
 *    verified log first, and again after a lost race, so a concurrent retry of
 *    the same `ref` (a control plane's retry after its own timeout) answers
 *    `idempotent` and appends nothing rather than a false refusal.
 *
 * The verb is human-only in the verb registry, so neither `approval serve` nor
 * the MCP wrapper publishes it, and its one intended caller is a root exec on
 * the box running as the store's own uid.
 */

import { createHash } from "node:crypto";

import {
  decide,
  readGatePolicy,
  readGateRecords,
  type GateOptions,
  type GateRefusalCode,
} from "./gate.js";
import { tick } from "./clock.js";
import { recordRefusedDecision } from "./decision-refusal.js";
import type { EventRecord } from "./log.js";
import { requestState, type RequestState } from "./state.js";

/** The environment variable that switches study mode on, read from the process alone. */
export const STUDY_MODE_ENV = "APPROVAL_STUDY_MODE";

/** Study mode is on only when {@link STUDY_MODE_ENV} is exactly `1`. */
export function studyModeOn(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[STUDY_MODE_ENV] === "1";
}

/** The actor every study withdrawal is recorded under (the schema pins it). */
export const STUDY_TEAM_ACTOR = "human:study-team";

/** The record's `channel` for a study withdrawal (the schema pins it). */
export const STUDY_CHANNEL = "study";

/** The record's `payload.note` for a study withdrawal. */
export const STUDY_WITHDRAW_NOTE = "withdrawn by the study team";

/**
 * The operator id: 8 lowercase hex the control plane derives from the staff email with a key it
 * alone holds (an HMAC, so a staff list cannot reverse it). Never the email; core checks the shape only.
 */
export const STUDY_OPERATOR_PATTERN = /^[0-9a-f]{8}$/u;

/** The withdraw's replay reference, minted once by the operator's tool. */
export const STUDY_REF_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;

/** How many hex characters of the key's sha256 an action ref carries. */
export const STUDY_ACTION_REF_HEX = 12;

/** An action ref: the first {@link STUDY_ACTION_REF_HEX} hex of sha256(action key). */
export const STUDY_ACTION_REF_PATTERN = /^[0-9a-f]{12}$/u;

/**
 * The short reference an operator names a request by, so that no action key
 * (which can carry text an agent wrote) ever has to leave the box. It is the
 * same 12 hex the Telegram listener's "Looks wrong" line prints
 * (`studyLogRefOf`, a prefix of the callback's `actionRefOf`), so one operator
 * vocabulary covers both study surfaces.
 */
export function studyActionRefOf(actionKey: string): string {
  return createHash("sha256").update(actionKey, "utf8").digest("hex").slice(0, STUDY_ACTION_REF_HEX);
}

/**
 * Every way the study withdraw refuses on its own (SPEC.md §11.1 invariant 6,
 * §11.2 `study_withdraw_refusal_codes`), in evaluation order. Only
 * `not-pending` on a request that exists appends, and it appends one
 * `audit.decision_refused`. A log that cannot be read or written reaches the
 * caller under the gate's own code (`log-unreadable`, `log-torn-tail`,
 * `log-corrupt`, `append-failed`), appends nothing, and is not a member here.
 */
export const STUDY_WITHDRAW_REFUSAL_CODES = [
  /** The process was not launched with `APPROVAL_STUDY_MODE=1`. Nothing was read. */
  "study-mode-off",
  /** The request is not pending: decided, expired, withdrawn, never requested, or lost a race. */
  "not-pending",
  /** An action ref names more than one pending request. Nothing was decided. */
  "action-ref-ambiguous",
] as const;

export type StudyWithdrawRefusalCode = (typeof STUDY_WITHDRAW_REFUSAL_CODES)[number];

/** The gate codes that say the LOG could not be read or written: passed through, never `not-pending`. */
const LOG_FAULT_CODES: ReadonlySet<GateRefusalCode> = new Set([
  "log-unreadable",
  "log-torn-tail",
  "log-corrupt",
  "append-failed",
]);

/** Which request to withdraw: its key, or the 12-hex ref of a pending one. Exactly one. */
export type StudyWithdrawTarget = { actionKey: string } | { actionRef: string };

export interface StudyWithdrawInput {
  target: StudyWithdrawTarget;
  /** {@link STUDY_OPERATOR_PATTERN}. Validated by the caller; the schema holds it again. */
  operator: string;
  /** {@link STUDY_REF_PATTERN}. Validated by the caller; the schema holds it again. */
  ref: string;
}

export interface StudyWithdrawOptions extends GateOptions {
  /** The environment study mode is read from. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

export type StudyWithdrawResult =
  | {
      ok: true;
      /** True when the same `ref` had already withdrawn this request: nothing was appended. */
      idempotent: boolean;
      /** The seq of the `approval.rejected` that withdrew it (this run's, or the earlier one's). */
      seq: number;
      /** The key withdrawn. For the caller's own bookkeeping; the CLI never prints it. */
      actionKey: string;
    }
  | StudyWithdrawRefusal;

export interface StudyWithdrawRefusal {
  ok: false;
  code: StudyWithdrawRefusalCode | GateRefusalCode;
  message: string;
  /** The derived state, on `not-pending`. */
  state?: RequestState;
  /**
   * The gate's own code for the refusal, on `not-pending` for a request that
   * exists (`already-decided`, `expired`, `request-withdrawn`, or whatever
   * `decide` answered after a race). It is the code the audit record carries.
   */
  gateCode?: GateRefusalCode;
  /** The seq of the `audit.decision_refused` this refusal appended, when it appended one. */
  auditSeq?: number;
  /** How many pending requests the ref named, on `action-ref-ambiguous`. */
  matches?: number;
}

function refusal(
  code: StudyWithdrawRefusal["code"],
  message: string,
  extra: Omit<StudyWithdrawRefusal, "ok" | "code" | "message"> = {},
): StudyWithdrawRefusal {
  return { ok: false, code, message, ...extra };
}

function payloadOf(record: EventRecord): Record<string, unknown> {
  const payload = record.payload;
  return typeof payload === "object" && payload !== null ? payload : {};
}

function studyOf(record: EventRecord): Record<string, unknown> | null {
  const study = payloadOf(record)["study"];
  return typeof study === "object" && study !== null && !Array.isArray(study)
    ? (study as Record<string, unknown>)
    : null;
}

/** Does the target name this key? A ref matches by its hash prefix. */
function targets(target: StudyWithdrawTarget, actionKey: string): boolean {
  return "actionKey" in target
    ? target.actionKey === actionKey
    : studyActionRefOf(actionKey) === target.actionRef;
}

/** The earlier withdrawal this `ref` made of the target, if any. */
function replayOf(
  records: readonly EventRecord[],
  target: StudyWithdrawTarget,
  ref: string,
): EventRecord | null {
  for (const record of records) {
    if (record.event !== "approval.rejected") continue;
    if (typeof record.action_key !== "string" || !targets(target, record.action_key)) continue;
    const study = studyOf(record);
    if (study === null) continue;
    if (study["reason"] === "study_withdrawn" && study["ref"] === ref) return record;
  }
  return null;
}

/**
 * The gate's own code for a request that exists and is not pending: the code
 * `decide` would answer, derived without calling it (a call would also write the
 * gate's lazy expiry record).
 */
function gateCodeOf(state: RequestState): GateRefusalCode {
  if (state === "expired") return "expired";
  if (state === "withdrawn") return "request-withdrawn";
  return "already-decided";
}

/** Every key that has an `approval.requested`, in first-seen order. */
function requestedKeys(records: readonly EventRecord[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (record.event !== "approval.requested") continue;
    const key = record.action_key;
    if (typeof key !== "string" || key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

const NOTHING = "Nothing was appended.";

/**
 * Withdraw one pending request for the study team. See the module header for
 * the four properties; the order of checks is normative (SPEC.md §11.2).
 */
export function studyWithdraw(
  logPath: string,
  input: StudyWithdrawInput,
  options: StudyWithdrawOptions = {},
): StudyWithdrawResult {
  // 1. The switch, before anything is read.
  if (!studyModeOn(options.env ?? process.env)) {
    return refusal(
      "study-mode-off",
      `study mode is off: this process was not launched with ${STUDY_MODE_ENV}=1, so no study withdrawal can be recorded. ${NOTHING}`,
    );
  }

  // 2. The verified log. A read fault is the log's, never "not pending".
  const read = readGateRecords(logPath, options.schemaDir);
  if (!read.ok) return refusal(read.code, read.message);

  // 3. Replay: the same ref already withdrew this request.
  const earlier = replayOf(read.records, input.target, input.ref);
  if (earlier !== null) {
    return {
      ok: true,
      idempotent: true,
      seq: earlier.seq,
      actionKey: earlier.action_key as string,
    };
  }

  // 4. Pending, at this instant, under the policy's TTL (the same derivation
  // `approval queue` and the gate use). A lapsed request is `not-pending` with
  // the gate's code `expired`; the gate's lazy expiry record is not written for
  // it here (only the audit record is).
  const ts = tick(options);
  const load = readGatePolicy(options);
  const ttlMs = load.ok ? load.durations.approvalTtlMs : null;

  // The one key the target names. A ref is resolved over every requested key:
  // the pending ones first (so a decided card that shares a ref never shadows a
  // pending one), then all of them, so a too-late withdraw by ref still learns
  // which request it was too late for and can be put on the record.
  let actionKey: string;
  if ("actionKey" in input.target) {
    actionKey = input.target.actionKey;
  } else {
    const target = input.target;
    const named = requestedKeys(read.records).filter((key) => studyActionRefOf(key) === target.actionRef);
    const pending = named.filter(
      (key) => requestState(read.records, key, ts, ttlMs).state === "requested",
    );
    if (pending.length > 1) {
      return refusal(
        "action-ref-ambiguous",
        `${String(pending.length)} pending requests carry this action ref, so it names no single request. Nothing was decided. ${NOTHING}`,
        { matches: pending.length },
      );
    }
    if (pending.length === 1) {
      actionKey = pending[0] as string;
    } else if (named.length === 1) {
      actionKey = named[0] as string;
    } else {
      // No request, or several settled ones (a 48-bit collision among decided
      // cards): there is no one request to account the attempt to.
      return refusal(
        "not-pending",
        `no pending request carries this action ref; a study withdrawal reaches only a request still awaiting a decision. ${NOTHING}`,
        { state: "none" },
      );
    }
  }

  const derivation = requestState(read.records, actionKey, ts, ttlMs);
  if (derivation.state === "none") {
    return refusal(
      "not-pending",
      `no request carries this action key; a study withdrawal reaches only a request still awaiting a decision. ${NOTHING}`,
      { state: "none" },
    );
  }
  if (derivation.state !== "requested") {
    const gateCode = gateCodeOf(derivation.state);
    return refusedOnRecord(
      logPath,
      actionKey,
      gateCode,
      `the request is not pending (state ${derivation.state}); a study withdrawal reaches only a request still awaiting a decision`,
      derivation.state,
      options,
    );
  }

  // 5. The deny, through the gate's own path: human-only check, fresh
  // derivation under the head-moved retry, schema at the write boundary,
  // compare-and-append. The decision is a constant.
  const decided = decide(logPath, actionKey, "reject", STUDY_TEAM_ACTOR, {
    ...options,
    channel: STUDY_CHANNEL,
    note: STUDY_WITHDRAW_NOTE,
    study: { reason: "study_withdrawn", operator: input.operator, ref: input.ref },
  });
  if (!decided.ok) {
    if (LOG_FAULT_CODES.has(decided.code)) return refusal(decided.code, decided.message);
    // A concurrent run of this same ref may be what won the race (a control
    // plane retrying after its own timeout): that is this withdrawal, already
    // done, and it answers as the replay it is, with nothing written.
    const again = readGateRecords(logPath, options.schemaDir);
    if (!again.ok) return refusal(again.code, again.message);
    const won = replayOf(again.records, { actionKey }, input.ref);
    if (won !== null) return { ok: true, idempotent: true, seq: won.seq, actionKey };
    // The one record the gate itself can leave here is the lazy
    // `approval.expired` of a TTL that lapsed inside the window.
    const lapse =
      decided.record === undefined
        ? ""
        : ` (the gate recorded the lapse it derived: ${decided.record.event}, seq ${String(decided.record.seq)})`;
    return refusedOnRecord(
      logPath,
      actionKey,
      decided.code,
      `the gate refused the withdrawal (${decided.code}): the request stopped being decidable before the study team's answer could be recorded${lapse}`,
      decided.state,
      options,
      decided.drift,
    );
  }
  return { ok: true, idempotent: false, seq: decided.record.seq, actionKey };
}

/**
 * A `not-pending` refusal for a request that exists, put on the record as
 * `approval reject` puts one (cli/gate.ts `commandDecide`): ONE
 * `audit.decision_refused` by the gate, naming `human:study-team` on channel
 * `study` and the gate's own code. Best effort, as there: the refusal stands
 * whatever the write does, and a write that failed is said in the message.
 */
function refusedOnRecord(
  logPath: string,
  actionKey: string,
  gateCode: GateRefusalCode,
  why: string,
  state: RequestState | undefined,
  options: StudyWithdrawOptions,
  drift?: { requested: string; attested: string },
): StudyWithdrawRefusal {
  const recorded = recordRefusedDecision(
    logPath,
    { actionKey, decision: "reject", actor: STUDY_TEAM_ACTOR, channel: STUDY_CHANNEL },
    { code: gateCode, message: why, ...(drift === undefined ? {} : { drift }) },
    options,
  );
  const audit = recorded.ok ? recorded.audit : null;
  const left =
    audit === null
      ? "The refused attempt could not be put on the record."
      : `The refused attempt is on the record (audit.decision_refused, seq ${String(audit.seq)}).`;
  return refusal("not-pending", `${why}. ${left}`, {
    gateCode,
    ...(state === undefined ? {} : { state }),
    ...(audit === null ? {} : { auditSeq: audit.seq }),
  });
}
