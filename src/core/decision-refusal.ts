/**
 * What the log says when a human decided and the gate could not take it
 * (APRV-235, amended SPEC.md §5.2).
 *
 * ## The fact this module is about
 *
 * Seen live on 2026-09-02, after the seq 13704 ceremony. Carter tapped approve
 * on a request that had been asked under the previous policy. The gate refused
 * `policy-drift`, which is right: the rules the approver was shown are not the
 * rules in force, so a grant recorded there would claim a decision under a
 * policy nobody put in front of them. But the refusal went to the operator's
 * terminal and nowhere else. Nothing was appended, the request stayed pending
 * in `QUEUE.md` and on Telegram, and the person who had tapped saw no reaction
 * at all.
 *
 * Three things were wrong and this module fixes two of them (the third, the
 * message edit, belongs to the channels).
 *
 * ## 1. A human's decision is a fact even when the gate cannot honour it
 *
 * The log is the truth. SPEC.md §11 makes human attention the audit budget, and
 * an approver's tap SPENDS it whether or not an authorization comes out the
 * other end. A reader looking at that log later found a request sitting
 * unanswered with nothing to say a person had answered it, which is a question
 * the log is supposed to be able to settle.
 *
 * So {@link recordRefusedDecision} appends one `audit.decision_refused`. It is
 * an **audit-tier** record in the strict sense:
 *
 * - it grants nothing and mints no token;
 * - `core/state.ts` does not settle a request on it, so no verdict moves;
 * - `core/budgets.ts` charges nothing for it, so no budget moves;
 * - `core/audit.ts` does not sample it and no streak counts it.
 *
 * `tests/decision-refusal.test.ts` asserts that last group by construction: the
 * derived request state, the budget verdicts and the sampling draw are taken
 * before and after and compared, and they are identical.
 *
 * ## The asymmetry: humans yes, agents no
 *
 * Gate-side refusals handed to an AGENT stay unlogged, and that is a choice
 * rather than an omission. An agent that is refused reads the code, stops or
 * asks again, and nothing was spent that a record could account for. A human
 * who is refused has already spent the scarce thing, and cannot be asked to
 * spend it again without the log saying the first spend happened. Recording
 * every agent-side refusal would also put the busiest path in the runtime — a
 * hook classifying every shell command — into the append path, which is a cost
 * with no reader.
 *
 * ## 2. A request the gate calls void must stop being offered
 *
 * `policy-drift` is the one refusal where the gate does not merely decline this
 * decision, it declares the REQUEST dead: "the pending request is void and the
 * action must be requested again". Leaving it pending afterwards offers every
 * approver on every channel a tap that cannot be honoured, forever, until the
 * TTL lapses. So a drift refusal also appends `approval.withdrawn` with the
 * runtime's own reason, `policy-drift` (APRV-106 gave the event; the schema's
 * cross-rule makes that reason `system:`-only and `system:` that-reason-only).
 * `approval queue`, `QUEUE.md` and every channel then read the request as
 * settled, because they all derive state from `core/state.ts` and it settles on
 * `approval.withdrawn` without looking at who wrote it or why.
 *
 * The action is not stranded: its caller requests it again, and the new request
 * is routed, budgeted and displayed under the policy actually in force. That is
 * what the refusal message already told them to do.
 *
 * ## Order, and what an interrupted write leaves behind
 *
 * The audit record is appended first and the withdrawal second, naming it in
 * `payload.refused_seq`. Two appends are two records — the log never batches —
 * so a crash between them is a state this code can reach, and the order is
 * chosen for which half is safe to have alone. The explanation without the
 * withdrawal leaves the request pending exactly as it is today, and a reader can
 * see why. The withdrawal without the explanation would take a request out of a
 * human's queue with nothing on the record saying who tapped, or why it was
 * refused, which is the failure this task exists to end.
 *
 * ## Invariants
 *
 * - **Gate-typed events never accept caller timestamps** (§11.1). `ts` comes
 *   from the injected clock at the write boundary; there is no parameter.
 * - **Every check-then-append passes through compare-and-append** (§11.1(5)).
 *   Both writes state the head they were derived against, and the whole cycle
 *   re-enters from a fresh read on `head-moved` through
 *   {@link withHeadRetry} — the same bounded retry APRV-236 gave `decide`.
 * - **Self-reported fields never reduce scrutiny** (§11.1). Everything here only
 *   ADDS to what a reviewer sees. The approver's identity comes from the
 *   decision surface's configured actor, the same source a grant's does, and the
 *   record's own actor is `system:` so that neither party to the refusal is its
 *   author.
 * - **Refusals stay machine-readable and distinct** (§11.1). The gate's code is
 *   copied verbatim; nothing here invents, merges or softens one.
 *
 * ## No attestation check, deliberately
 *
 * Nothing here asks whether the policy is attested, for the reason `reject` and
 * `revoke` do not: this write confers no authority. Refusing to record a refusal
 * because a file changed would be the strict direction pointing the wrong way,
 * and the case where it would bite hardest is `policy-not-attested` itself —
 * exactly the refusal an operator most needs the log to remember. The write
 * boundary still validates every record, so what lands is still constrained.
 */

import { tick } from "./clock.js";
import { attemptsOf, withHeadRetry } from "./head-retry.js";
import { appendEvent, type AppendError, type EventInput, type EventRecord, type LogHead } from "./log.js";
import { readVerifiedRecords, requestState, type Decision } from "./state.js";
import type { GateOptions } from "./gate.js";

/**
 * The actor every record here carries. `system:`, and the same id the runtime's
 * other unprompted writes use: this is the gate stating what the gate did.
 */
export const DECISION_REFUSAL_ACTOR = "system:gate";

/** The runtime's withdrawal reason, closed to requesters by the event schema. */
export const POLICY_DRIFT_REASON = "policy-drift";

/**
 * The decisions this module records: a person's, and nobody else's.
 *
 * Matches `core/gate.ts`'s own `HUMAN_ACTOR`, and it is the FIRST thing checked
 * rather than a schema refusal caught late. `actor-not-human` is a real gate
 * refusal — a misconfigured channel claiming an `agent:` identity produces it —
 * and it is precisely the case where no human decided anything, so there is no
 * spent attention for a record to account for. Letting it through would also
 * mean composing a record whose `payload.actor` the event schema then refuses,
 * which is a failure discovered at the write boundary rather than a rule stated
 * where it belongs.
 */
const HUMAN_ACTOR = /^human:.+/u;

/** Who decided what, on which surface — everything the record needs about the tap. */
export interface RefusedDecision {
  /** The action whose decision was refused. */
  actionKey: string;
  /** Which of the three human-only verbs was attempted. */
  decision: Decision;
  /** The approver, `human:<id>`, from the surface's configured identity. */
  actor: string;
  /** The surface that collected the gesture: `telegram`, `web`, `cli`. */
  channel: string;
}

/** The gate refusal being recorded. Only these fields are ever read. */
export interface RefusalFacts {
  /** The gate's code, verbatim. */
  code: string;
  /** The gate's message, verbatim. */
  message: string;
  /**
   * The two policy hashes the gate compared, on `policy-drift` alone. Supplied
   * by the refusal that made the comparison rather than re-derived here: a
   * second derivation could disagree with the one that actually refused, and
   * then the record would describe a comparison nobody made.
   */
  drift?: { requested: string; attested: string };
}

/** What the module could not do. Never thrown; the caller carries on regardless. */
export interface RefusalRecordFailure {
  ok: false;
  code: "log-unreadable" | "append-failed";
  message: string;
  append?: AppendError;
}

export type RecordRefusedDecisionResult =
  | {
      ok: true;
      /**
       * The `audit.decision_refused` record, or `null` when the refused actor
       * was not a person and there was therefore nothing to record.
       */
      audit: EventRecord | null;
      /** The `approval.withdrawn` record, on `policy-drift` alone; `null` otherwise. */
      withdrawn: EventRecord | null;
    }
  | RefusalRecordFailure;

/** Is this the refusal that declares the request itself void? */
export function voidsTheRequest(code: string): boolean {
  return code === "policy-drift";
}

/**
 * Record that a human's decision was refused, and withdraw the request when the
 * refusal was the gate declaring it void.
 *
 * Called by the decision SURFACES — `channels/contract.ts`'s
 * `recordChannelDecision` and `cli/gate.ts`'s `commandDecide` — and never from
 * inside `decide()`. That placement is deliberate twice over. `decide()`'s
 * contract is that a refusal appends nothing, which is what lets a caller retry
 * one without wondering what it wrote; and this record is about a HUMAN having
 * decided, which is a fact only a surface that collected a human's gesture can
 * assert.
 *
 * Best-effort by design: a failure here is returned, never thrown, and the
 * caller shows the gate's refusal either way. The decision was already refused
 * before this ran, and nothing about that outcome depends on this write landing.
 *
 * **Two writes, two retry cycles, and deliberately not one.** `head-retry.ts`
 * asks that the unit of retry be a whole read-check-append cycle, and putting
 * both appends inside one cycle would break that in the direction that matters:
 * a moved head under the SECOND write would re-enter from the top and append a
 * second `audit.decision_refused` for one tap. So each write has its own cycle,
 * each re-reads and re-derives, and the withdrawal's cycle re-checks that the
 * request is still pending — a decision or a withdrawal that landed in the
 * window is the new verdict, and there is then nothing left to withdraw.
 */
export function recordRefusedDecision(
  logPath: string,
  decided: RefusedDecision,
  refusal: RefusalFacts,
  options: GateOptions = {},
): RecordRefusedDecisionResult {
  // No person, no record. See {@link HUMAN_ACTOR}: `actor-not-human` is the
  // refusal a misconfigured channel gets, and it is the one refusal that says
  // nobody's attention was spent.
  if (!HUMAN_ACTOR.test(decided.actor)) return { ok: true, audit: null, withdrawn: null };

  const attempts = attemptsOf(options.retryOnHeadMoved);
  const audit = withHeadRetry(attempts, () => appendAudit(logPath, decided, refusal, options));
  if (!audit.ok) return audit;

  if (!voidsTheRequest(refusal.code)) return { ok: true, audit: audit.record, withdrawn: null };
  const withdrawn = withHeadRetry(attempts, () =>
    appendWithdrawal(logPath, decided, refusal, audit.record.seq, options),
  );
  if (!withdrawn.ok) return withdrawn;
  return { ok: true, audit: audit.record, withdrawn: withdrawn.record };
}

/** One appended record, or the reason there is none. */
type AppendOutcome = { ok: true; record: EventRecord } | RefusalRecordFailure;

/** As {@link AppendOutcome}, with "there was nothing to write" as a third answer. */
type MaybeAppendOutcome = { ok: true; record: EventRecord | null } | RefusalRecordFailure;

/** The audit record's whole cycle: a fresh read, the task off it, one append. */
function appendAudit(
  logPath: string,
  decided: RefusedDecision,
  refusal: RefusalFacts,
  options: GateOptions,
): AppendOutcome {
  const ts = tick(options);
  const read = readRecords(logPath, options);
  if (!read.ok) return read;

  // The task the request named, off the verified log rather than off the
  // caller: a surface holds a rendering, and the record should say what the log
  // says. TTL is irrelevant here (nothing is being decided), so the derivation
  // is asked for the task alone.
  const derivation = requestState(read.records, decided.actionKey, ts, null);

  const payload: Record<string, unknown> = {
    actor: decided.actor,
    decision: decided.decision,
    code: refusal.code,
    message: refusal.message,
  };
  if (refusal.drift !== undefined) {
    payload["policy_sha256_requested"] = refusal.drift.requested;
    payload["policy_sha256_attested"] = refusal.drift.attested;
  }

  return appendOne(
    logPath,
    {
      ts,
      event: "audit.decision_refused",
      actor: DECISION_REFUSAL_ACTOR,
      ...(derivation.task === null ? {} : { task: derivation.task }),
      action_key: decided.actionKey,
      channel: decided.channel,
      payload,
    },
    options,
    read.head,
  );
}

/**
 * The withdrawal's whole cycle, run only for `policy-drift`.
 *
 * The pending-ness check is inside the cycle rather than carried from the audit
 * record's read, which is what makes the retry safe: a request that was decided
 * or withdrawn while this was writing is settled by that record, and appending
 * a second terminal event for it would be this module overwriting an answer.
 * `record: null` is that case, and it is a success — there was nothing to
 * withdraw.
 */
function appendWithdrawal(
  logPath: string,
  decided: RefusedDecision,
  refusal: RefusalFacts,
  refusedSeq: number,
  options: GateOptions,
): MaybeAppendOutcome {
  const ts = tick(options);
  const read = readRecords(logPath, options);
  if (!read.ok) return read;

  const derivation = requestState(read.records, decided.actionKey, ts, null);
  if (derivation.state !== "requested") return { ok: true, record: null };

  return appendOne(
    logPath,
    {
      ts,
      event: "approval.withdrawn",
      actor: DECISION_REFUSAL_ACTOR,
      ...(derivation.task === null ? {} : { task: derivation.task }),
      action_key: decided.actionKey,
      payload: {
        action_key: decided.actionKey,
        reason: POLICY_DRIFT_REASON,
        note: driftNote(refusal),
        refused_seq: refusedSeq,
      },
    },
    options,
    read.head,
  );
}

function readRecords(
  logPath: string,
  options: GateOptions,
): { ok: true; records: EventRecord[]; head: LogHead | null } | RefusalRecordFailure {
  const read = readVerifiedRecords(
    logPath,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
  return read.ok ? read : { ok: false, code: "log-unreadable", message: read.message };
}

/**
 * The withdrawal's note: both hashes, so a reader checks the runtime's verdict
 * against the log instead of taking it.
 */
function driftNote(refusal: RefusalFacts): string {
  const drift = refusal.drift;
  const hashes =
    drift === undefined
      ? ""
      : ` The request pinned policy ${drift.requested} and the attested policy is now ${drift.attested}.`;
  return `withdrawn by the runtime: a human's decision was refused \`policy-drift\`, so the rules that routed this request are no longer in force and no decision can be recorded about it.${hashes} The action is not refused — request it again, and it is routed, budgeted and displayed under the policy actually in force.`;
}

function appendOne(
  logPath: string,
  input: EventInput,
  options: GateOptions,
  expectedHead: LogHead | null,
): { ok: true; record: EventRecord } | RefusalRecordFailure {
  const append = { ...options.append };
  if (options.schemaDir !== undefined) append.schemaDir = options.schemaDir;
  const result = appendEvent(logPath, input, { ...append, expectedHead });
  if (result.ok) return { ok: true, record: result.record };
  return {
    ok: false,
    code: "append-failed",
    message: `${input.event} could not be appended: ${result.error.message}`,
    append: result.error,
  };
}
