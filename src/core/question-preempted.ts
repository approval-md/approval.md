/**
 * What the log says when something other than this gate answered a question
 * this gate exists to ask (APRV-378, amended SPEC.md §8).
 *
 * ## The fact this module is about
 *
 * Codex's app-server carries a server-side auto-reviewer. It can resolve an
 * approval with a genuine model call BEFORE the client path runs, and the
 * client is told afterwards through an `item/autoApprovalReview` notification
 * (`docs/codex-app-server-bridge.md`, question 3). `approval codex bridge`
 * stops when it sees one (APRV-364), because a session with a reviewer in front
 * of the gate is a session whose silence means nothing: a question that was
 * resolved elsewhere and a question nobody wanted to ask look the same from
 * here.
 *
 * Stopping is a verdict. This module is the RECORD, and it exists because a
 * verdict with nothing behind it is the shape of claim this project is built
 * against. Without it, the moment something else answered lives in an exit code
 * and a terminal line, and the log — which is the truth — says nothing at all.
 *
 * ## Why it is not one of the three records that already exist
 *
 * - `audit.dark_session` is the sweep: activity with no records beside it.
 * - `audit.decision_refused` is a human gesture the gate would not take, and it
 *   requires an `action_key` and a `decision` this has neither of.
 * - `audit.gesture_refused` (APRV-355) is a human gesture that is not a
 *   decision at all.
 *
 * Here the question existed, the gate would have asked it, and somebody else
 * answered first. That is a different fact from all three, and it is the one
 * this project most wants written down.
 *
 * ## What this record is, and what it is not
 *
 * AUDIT TIER on the strict terms `audit.decision_refused` set:
 *
 * - it grants nothing and mints no token;
 * - `core/state.ts` settles nothing on it, so no verdict moves;
 * - `core/budgets.ts` charges nothing for it, so no budget moves;
 * - `core/audit.ts` does not sample it and no streak counts it;
 * - NO ENFORCEMENT PATH READS IT. `tests/question-preempted.test.ts` pins that
 *   by reading the module graph rather than by asserting an intention.
 *
 * `approval doctor` reads it, and that is not an exception to the rule above:
 * the row it feeds diagnoses, and a diagnosis authorizes nothing and refuses
 * nothing. It is the only reader, and it is a reader of history rather than a
 * step in any decision.
 *
 * The record's own actor is `system:`, for the reason `audit.dark_session`'s
 * and `audit.gesture_refused`'s are: a record of an event authored by either
 * party to it is a record neither party can be held to. Both parties here are
 * machines — the harness that pre-empted the question, and the agent whose
 * action it was — which makes the rule sharper rather than softer.
 *
 * ## The verdict is never defaulted
 *
 * {@link PreemptedQuestion.verdict} carries the other party's word verbatim
 * when the notification stated one, and is absent when it did not. A record
 * that said `accept` because nothing said otherwise would be this runtime
 * inventing another party's decision, which is the one thing a record about
 * another party's decision may not do.
 *
 * ## Invariants
 *
 * - **Gate-typed events never accept caller timestamps** (§11.1). `ts` comes
 *   from the injected clock at the write boundary; there is no parameter.
 * - **Every check-then-append passes through compare-and-append** (§11.1(5)).
 *   The write states the head it was derived against and the whole cycle
 *   re-enters from a fresh read on `head-moved` through {@link withHeadRetry}.
 * - **Self-reported fields never reduce scrutiny** (§11.1). Everything here
 *   only ADDS to what a reviewer sees, and every field is the other party's own
 *   frame rather than anything the agent under oversight said about itself.
 * - **Refusals stay machine-readable and distinct** (§11.1). The bridge's stop
 *   code is unchanged by this record's success or failure.
 */

import { tick } from "./clock.js";
import { attemptsOf, withHeadRetry } from "./head-retry.js";
import { appendEvent, type AppendError, type EventRecord, type LogHead } from "./log.js";
import { readVerifiedRecords } from "./state.js";
import type { GateOptions } from "./gate.js";

/** The actor every record here carries: the gate stating what the gate saw. */
export const QUESTION_PREEMPTED_ACTOR = "system:gate";

/** The event type this module writes, named once. */
export const QUESTION_PREEMPTED_EVENT = "audit.question_preempted" as const;

/**
 * Who answered instead of the gate. **Closed and additive-only** (§11.1
 * invariant 6), and pinned against the event schema's own enum by
 * `tests/question-preempted.test.ts`.
 *
 * One member today. The name of the event is general because the instance will
 * not be: the next system that resolves one of these questions before the gate
 * sees it gains a member here rather than an event type of its own.
 */
export const PREEMPTION_SOURCES = ["codex-auto-reviewer"] as const;

export type PreemptionSource = (typeof PREEMPTION_SOURCES)[number];

/** The question, as the OTHER PARTY identified it. */
export interface PreemptedQuestion {
  /** Who answered it. */
  source: PreemptionSource;
  /** Their own identifier for the question. Codex's `itemId`. */
  id: string;
  /** The notification that disclosed it, verbatim. */
  method?: string;
  /** Their session identifier, where the frame named one. */
  thread?: string;
  /** Their turn identifier, where the frame named one. */
  turn?: string;
  /**
   * The verdict they reached, in their own vocabulary.
   *
   * Absent when the frame stated none. Never defaulted; see the module header.
   */
  verdict?: string;
  /** The runtime's own line about what it did next. */
  detail?: string;
}

/** What the module could not do. Never thrown; the caller carries on regardless. */
export interface QuestionPreemptedFailure {
  ok: false;
  code: "log-unreadable" | "append-failed";
  message: string;
  append?: AppendError;
}

export type RecordPreemptedQuestionResult =
  | {
      ok: true;
      /** The record, or `null` when there was nothing this module could record. */
      audit: EventRecord | null;
    }
  | QuestionPreemptedFailure;

/**
 * Record that something else answered a question the gate exists to ask.
 *
 * Called by the client that saw the disclosure, on the branch where it stops.
 *
 * Best-effort by design: a failure here is returned, never thrown, and the
 * caller stops either way. The session is ending on its own stop code, and
 * nothing about that outcome depends on this write landing. What a failed write
 * costs is exactly what this task exists to stop costing: the log's silence.
 *
 * One case appends nothing, and it is the honest answer rather than a silence:
 * a question the other party did not identify. A record whose `question.id` was
 * invented here would name nothing a reader could go and find on the other
 * side, and the schema refuses it.
 */
export function recordPreemptedQuestion(
  logPath: string,
  question: PreemptedQuestion,
  options: GateOptions = {},
): RecordPreemptedQuestionResult {
  if (question.id.length === 0) return { ok: true, audit: null };
  if (!(PREEMPTION_SOURCES as readonly string[]).includes(question.source)) {
    return { ok: true, audit: null };
  }

  const appended = withHeadRetry(attemptsOf(options.retryOnHeadMoved), () =>
    appendAudit(logPath, question, options),
  );
  return appended.ok ? { ok: true, audit: appended.record } : appended;
}

type AppendOutcome = { ok: true; record: EventRecord } | QuestionPreemptedFailure;

/** The whole cycle: a fresh read for the head, then one append against it. */
function appendAudit(
  logPath: string,
  question: PreemptedQuestion,
  options: GateOptions,
): AppendOutcome {
  const ts = tick(options);
  const read = readVerifiedRecords(
    logPath,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
  if (!read.ok) {
    return { ok: false, code: "log-unreadable", message: read.message };
  }

  const payload: Record<string, unknown> = {
    source: question.source,
    question: {
      id: question.id,
      ...(question.method === undefined ? {} : { method: question.method }),
      ...(question.thread === undefined ? {} : { thread: question.thread }),
      ...(question.turn === undefined ? {} : { turn: question.turn }),
    },
    ...(question.verdict === undefined ? {} : { verdict: question.verdict }),
    ...(question.detail === undefined ? {} : { detail: question.detail }),
  };

  return appendOne(logPath, { ts, payload }, options, read.head);
}

function appendOne(
  logPath: string,
  input: { ts: string; payload: Record<string, unknown> },
  options: GateOptions,
  expectedHead: LogHead | null,
): AppendOutcome {
  const append = { ...options.append };
  if (options.schemaDir !== undefined) append.schemaDir = options.schemaDir;
  const result = appendEvent(
    logPath,
    { ...input, event: QUESTION_PREEMPTED_EVENT, actor: QUESTION_PREEMPTED_ACTOR },
    { ...append, expectedHead },
  );
  if (result.ok) return { ok: true, record: result.record };
  return {
    ok: false,
    code: "append-failed",
    message: `${QUESTION_PREEMPTED_EVENT} could not be appended: ${result.error.message}`,
    append: result.error,
  };
}
