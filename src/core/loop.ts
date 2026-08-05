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
 */

import type { EventRecord } from "./log.js";

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
