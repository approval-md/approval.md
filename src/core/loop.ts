/**
 * Loop safety (SPEC.md §10.2): "three consecutive `execution.failed` events for
 * one task escalate to `manual` regardless of policy".
 *
 * This is a **pure projection over the log** and nothing else. It reads records,
 * counts, and returns; it never appends, never reads the clock, and never
 * consults the policy. Two very different consumers need the same answer and
 * must not be allowed to disagree about it:
 *
 * - `core/gate.ts` refuses to admit a *new* non-manual request for an escalated
 *   task (the `loop-escalated` refusal);
 * - `core/execute.ts` refuses to *start* a supervised/autonomous execution for
 *   one, directing the caller to the manual path.
 *
 * It lives in its own module rather than inside `core/execute.ts` for a boring
 * structural reason: `execute.ts` imports the gate, so the gate cannot import
 * `execute.ts` back without a cycle. `core/execute.ts` re-exports these names, so
 * the documented home of the projection is still the execution module.
 *
 * ## What "consecutive" means here, stated exactly
 *
 * The streak is **per task**, not per action key — SPEC.md §10.2 says "for one
 * task", and an agent that fails three different actions of the same task in a
 * row is exactly the runaway loop the rule exists to stop.
 *
 * Only two event types move the counter:
 *
 * - `execution.failed` increments it;
 * - `execution.completed` resets it to zero.
 *
 * Everything else — `execution.started`, approvals, budget events, another
 * task's failures — is transparent. In particular a *retry* is not a reset: a
 * failed action that is started again and fails again is two consecutive
 * failures, which is the entire point. Only a successful completion is evidence
 * that the loop broke, so only a completion clears the count.
 *
 * ## Escalation is a floor, never a ban
 *
 * An escalated task is escalated **to manual**, not to refused. Its manual
 * actions still request, still grant, and still execute with a token — a human
 * is now in the loop for every one of them, which is what "escalate to manual"
 * means. Escalation is also **not** cleared by a human decision, only by an
 * `execution.completed`: the log records the recovery, or the escalation stands.
 *
 * ## The harness scopes (APRV-145)
 *
 * Everything above is the per-task streak of SPEC.md §10.2 and is unchanged. A
 * harness adapter (§10.1) mints a fresh task id for every tool call, so that
 * streak cannot leave zero on that surface however wedged the session is. The
 * amended §10.2 answers it with two more streaks, both derived here and both
 * counted in TOOL CALLS rather than in events:
 *
 * - the **session**, `hook:<session id>`, which is a real prefix of every task
 *   id the adapter mints, so the scope is recovered from a string the runtime
 *   itself wrote rather than from a field an agent hands the gate;
 * - the **actor**, the identity the adapter runs as, because a session id is
 *   authored by the party under oversight and a scope key the subject can
 *   rotate is a streak the subject can clear (§11.1 invariant 4).
 *
 * A command is escalated when EITHER reaches {@link LOOP_ESCALATION_THRESHOLD}.
 */

import type { EventRecord } from "./log.js";
import { payloadOf } from "./state.js";

/**
 * Consecutive failures that force a task to manual (SPEC.md §10.2). Three, and
 * the number is spelled here once so the gate, the executor, and the CLI cannot
 * hold three opinions about it.
 */
export const LOOP_ESCALATION_THRESHOLD = 3;

/** One task's loop state, derived from the log. */
export interface TaskLoopState {
  task: string;
  /** Failures since the last `execution.completed` for this task. */
  consecutiveFailures: number;
  /** `consecutiveFailures >= LOOP_ESCALATION_THRESHOLD`. */
  escalated: boolean;
  /** The seq of the failure that opened the current streak, or `null`. */
  streakStartSeq: number | null;
  /** The seq of the most recent failure in the streak, or `null`. */
  lastFailureSeq: number | null;
}

/**
 * Loop state for every task that has recorded an execution outcome.
 *
 * Returned sorted by task id so the projection is byte-stable: two runs over
 * the same log produce the same list in the same order, which is what lets
 * `approval status --json` be pinned by a `deepEqual` test.
 *
 * Tasks with executions but no failures are included with
 * `consecutiveFailures: 0` — a caller rendering health wants to know the task
 * was seen and is clean, and filtering is the caller's business, not this
 * function's.
 */
export function loopEscalation(records: EventRecord[]): TaskLoopState[] {
  const states = new Map<string, TaskLoopState>();

  const stateFor = (task: string): TaskLoopState => {
    const existing = states.get(task);
    if (existing !== undefined) return existing;
    const created: TaskLoopState = {
      task,
      consecutiveFailures: 0,
      escalated: false,
      streakStartSeq: null,
      lastFailureSeq: null,
    };
    states.set(task, created);
    return created;
  };

  for (const record of records) {
    const task = record.task;
    if (typeof task !== "string" || task.length === 0) continue;
    if (record.event === "execution.failed") {
      const state = stateFor(task);
      state.consecutiveFailures += 1;
      state.escalated = state.consecutiveFailures >= LOOP_ESCALATION_THRESHOLD;
      if (state.streakStartSeq === null) state.streakStartSeq = record.seq;
      state.lastFailureSeq = record.seq;
      continue;
    }
    if (record.event === "execution.completed") {
      const state = stateFor(task);
      state.consecutiveFailures = 0;
      state.escalated = false;
      state.streakStartSeq = null;
      state.lastFailureSeq = null;
    }
  }

  return [...states.values()].sort((a, b) => (a.task < b.task ? -1 : a.task > b.task ? 1 : 0));
}

/** Is `task` escalated to manual by loop safety right now? */
export function isLoopEscalated(records: EventRecord[], task: string): boolean {
  for (const state of loopEscalation(records)) {
    if (state.task === task) return state.escalated;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The harness scopes (APRV-145, amended SPEC.md §10.2)
// ---------------------------------------------------------------------------

/** The prefix every harness adapter task id carries (`src/cli/hook.ts`). */
export const HARNESS_TASK_PREFIX = "hook:";

/**
 * The bucket every unreadable session identifier lands in.
 *
 * ONE shared bucket, not a fresh one per unreadable id, and the difference is
 * the whole rule: absence must accrue FASTER and never slower. `parseHookInput`
 * already substitutes this literal for an absent `session_id`, so the two halves
 * of the runtime spell it the same way.
 */
export const UNKNOWN_SESSION = "unknown-session";

/**
 * The session scope key of a harness task id, or `null` for a task no harness
 * adapter minted.
 *
 * DERIVED, never declared. The id is `hook:<session>:<tool-use id>` and this
 * reads its middle segment back out; nothing here reads a scope an agent named.
 * A `hook:` task that does not split into exactly three colon-separated parts is
 * an id this runtime cannot read, so it lands in {@link UNKNOWN_SESSION} with
 * every other unreadable one.
 */
export function harnessSessionOf(task: string): string | null {
  if (!task.startsWith(HARNESS_TASK_PREFIX)) return null;
  const parts = task.split(":");
  if (parts.length !== 3) return `${HARNESS_TASK_PREFIX}${UNKNOWN_SESSION}`;
  const session = parts[1];
  if (session === undefined || session.length === 0) {
    return `${HARNESS_TASK_PREFIX}${UNKNOWN_SESSION}`;
  }
  return `${HARNESS_TASK_PREFIX}${session}`;
}

/** Which derivation produced a {@link HarnessLoopState}'s key. */
export type HarnessScope = "session" | "actor";

/** One harness scope's loop state, derived from the log. */
export interface HarnessLoopState {
  scope: HarnessScope;
  /** `hook:<session id>` for a session, the actor identity for an actor. */
  key: string;
  /** Consecutive failed TOOL CALLS since the last completed one. */
  consecutiveFailures: number;
  /** `consecutiveFailures >= LOOP_ESCALATION_THRESHOLD`. */
  escalated: boolean;
  /** The seq that opened the current streak, or `null`. */
  streakStartSeq: number | null;
  /** The seq of the most recent failure in the streak, or `null`. */
  lastFailureSeq: number | null;
}

/** One harness task id folded to one outcome, placed at its closing record. */
interface ToolCallOutcome {
  session: string;
  actor: string;
  failed: boolean;
  /** The seq of the CLOSING record, which is where the outcome is ordered. */
  seq: number;
}

/**
 * Fold every harness task in the log to at most one outcome.
 *
 * THE UNIT IS THE TOOL CALL. One tool call is one task id and may declare
 * several classes, each with its own action key and its own outcome record;
 * counting events would let a three-class command trip the threshold on a single
 * failure. So a task folds first: any `execution.failed` under it makes it a
 * failed tool call, and only a task whose outcomes are all completions counts as
 * a completed one. A task whose classes disagree is a FAILURE, because ambiguity
 * resolves stricter.
 *
 * The outcome is placed at the seq of the task's LAST outcome record, so
 * interleaved sessions and a late-arriving counterpart order deterministically
 * in log order. Never by timestamp.
 */
function toolCallOutcomes(records: EventRecord[]): ToolCallOutcome[] {
  const byTask = new Map<string, ToolCallOutcome>();
  for (const record of records) {
    if (record.event !== "execution.failed" && record.event !== "execution.completed") continue;
    const task = record.task;
    if (typeof task !== "string" || task.length === 0) continue;
    const session = harnessSessionOf(task);
    if (session === null) continue;
    const existing = byTask.get(task);
    const failed = record.event === "execution.failed";
    if (existing === undefined) {
      byTask.set(task, { session, actor: record.actor, failed, seq: record.seq });
      continue;
    }
    existing.actor = record.actor;
    existing.seq = record.seq;
    // Sticky: one failure anywhere under the task makes the tool call a failure,
    // whatever its other classes reported.
    existing.failed = existing.failed || failed;
  }
  return [...byTask.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Loop state for every harness session and every harness actor the log has seen
 * an outcome for.
 *
 * Sorted by scope then key so the projection is byte-stable, exactly as
 * {@link loopEscalation} is, which is what lets `approval status --json` be
 * pinned by a `deepEqual` test.
 *
 * What resets a streak is unchanged and deliberately not widened: only an
 * `execution.completed` in the same scope. A hook timeout, a deny, a withdrawn
 * request, a granted approval, a fresh tool call, a restarted process and
 * elapsed time all leave the streak where they found it. Silence is not evidence
 * of recovery.
 */
export function harnessLoopEscalation(records: EventRecord[]): HarnessLoopState[] {
  const states = new Map<string, HarnessLoopState>();

  const stateFor = (scope: HarnessScope, key: string): HarnessLoopState => {
    const id = `${scope} ${key}`;
    const existing = states.get(id);
    if (existing !== undefined) return existing;
    const created: HarnessLoopState = {
      scope,
      key,
      consecutiveFailures: 0,
      escalated: false,
      streakStartSeq: null,
      lastFailureSeq: null,
    };
    states.set(id, created);
    return created;
  };

  for (const call of toolCallOutcomes(records)) {
    for (const state of [stateFor("session", call.session), stateFor("actor", call.actor)]) {
      if (call.failed) {
        state.consecutiveFailures += 1;
        state.escalated = state.consecutiveFailures >= LOOP_ESCALATION_THRESHOLD;
        if (state.streakStartSeq === null) state.streakStartSeq = call.seq;
        state.lastFailureSeq = call.seq;
        continue;
      }
      state.consecutiveFailures = 0;
      state.escalated = false;
      state.streakStartSeq = null;
      state.lastFailureSeq = null;
    }
  }

  return [...states.values()].sort((a, b) => {
    const left = `${a.scope} ${a.key}`;
    const right = `${b.scope} ${b.key}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * The harness scope that escalated this tool call, or `null` for a command no
 * streak has floored.
 *
 * EITHER scope escalates (amended SPEC.md §10.2). The session is the smallest
 * scope a runaway actually runs away in; the actor is the backstop, because the
 * session id is authored by the party under oversight and a scope it can rotate
 * is a streak it can shed. The session is reported in preference to the actor
 * where both are tripped, because it is the narrower fact and names the run an
 * operator has to go and look at.
 */
export function harnessLoopFloor(
  records: EventRecord[],
  task: string,
  actor: string,
): HarnessLoopState | null {
  const session = harnessSessionOf(task);
  const states = harnessLoopEscalation(records);
  const bySession =
    session === null
      ? undefined
      : states.find((state) => state.scope === "session" && state.key === session);
  if (bySession?.escalated === true) return bySession;
  const byActor = states.find((state) => state.scope === "actor" && state.key === actor);
  return byActor?.escalated === true ? byActor : null;
}

/** Is this harness tool call floored to manual by either scope right now? */
export function isHarnessLoopEscalated(
  records: EventRecord[],
  task: string,
  actor: string,
): boolean {
  return harnessLoopFloor(records, task, actor) !== null;
}

/** How many harness starts carry an outcome, and how many do not (§10.2). */
export interface HarnessOutcomeCoverage {
  started: number;
  reported: number;
  unreported: number;
}

/**
 * Coverage of the completion counterpart, for `approval status`.
 *
 * INFORMATIONAL. It moves no health verdict and no exit code, for the reason
 * §8's timestamp anomalies move neither: it is a coverage measurement rather
 * than an integrity verdict, and a control an operator learns to silence is
 * worse than one that reports beside the verdict. A persistently high
 * `unreported` is how an operator learns the post-execution hook is not
 * installed or not firing.
 */
export function harnessOutcomeCoverage(records: EventRecord[]): HarnessOutcomeCoverage {
  /** Action keys whose latest `execution.started` carried the harness marker. */
  const open = new Set<string>();
  let started = 0;
  let reported = 0;
  for (const record of records) {
    const key = record.action_key;
    if (typeof key !== "string" || key.length === 0) continue;
    if (record.event === "execution.started") {
      if (payloadOf(record)["execution"] === "harness") {
        started += 1;
        open.add(key);
      } else {
        open.delete(key);
      }
      continue;
    }
    if (
      record.event === "execution.completed" ||
      record.event === "execution.failed" ||
      record.event === "execution.indeterminate"
    ) {
      if (open.delete(key)) reported += 1;
    }
  }
  return { started, reported, unreported: started - reported };
}
