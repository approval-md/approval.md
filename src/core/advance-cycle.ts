/**
 * The vocabulary of a daemon advance cycle, as facts about the log (APRV-204).
 *
 * Pure over records: no git, no filesystem, no clock. It lives in `core/`
 * because three layers ask the same two questions of it — the daemon that
 * writes the cycles (`daemon/advance.ts`), the doctor row that reports the last
 * one (`cli/doctor.ts`), and the trigger arithmetic that must not count the
 * daemon's own bookkeeping — and a CLI module may not import the daemon
 * (`tests/layering.test.ts`). One home, so the three cannot disagree about
 * which records are an advance's own.
 */

import type { EventRecord } from "./log.js";

/**
 * Who proposes an advance.
 *
 * `agent:daemon`, not the `system:daemon` of `envelope.drift`: the gate's
 * proposing side is a PRINCIPAL (`human:` or `agent:`), and an advance is a
 * request to act on the world rather than a fact the runtime observed about
 * itself. The distinction is load-bearing in the log — a reader tells the
 * daemon's observations from the daemon's actions by the actor alone.
 */
export const ADVANCE_ACTOR = "agent:daemon";

/** The class an advance is gated as. Declared, resolved, and never assumed. */
export const ADVANCE_CLASS = "log.advance";

/** The task id every advance cycle registers under, plus its head seq. */
export const ADVANCE_TASK_PREFIX = "daemon-advance";

/** The idempotency key prefix. One key per (published head → working head) span. */
export const ADVANCE_KEY_PREFIX = "daemon-log-advance";

/** The task id for a cycle that publishes up to `toSeq`. */
export function advanceTaskId(toSeq: number): string {
  return `${ADVANCE_TASK_PREFIX}-${String(toSeq)}`;
}

/** The idempotency key for the span `fromSeq..toSeq`. */
export function advanceActionKey(fromSeq: number, toSeq: number): string {
  return `${ADVANCE_KEY_PREFIX}-${String(fromSeq)}-${String(toSeq)}`;
}

/**
 * Is this record part of an advance cycle's own bookkeeping?
 *
 * Keyed on the task id the daemon registers under, which nothing else writes.
 * A record whose task merely LOOKS like one of those but was written by another
 * actor is still excluded, deliberately: the exclusion only ever makes the
 * cadence advance LESS eagerly, so a false positive costs latency while a false
 * negative would cost an endless cadence (one cycle appends three records, the
 * last of them after the commit).
 */
export function isAdvanceBookkeeping(record: EventRecord): boolean {
  return typeof record.task === "string" && record.task.startsWith(`${ADVANCE_TASK_PREFIX}-`);
}

/** What the log says about the most recent advance cycle. */
export interface LastAdvance {
  /** The working head the cycle was registered for. */
  toSeq: number;
  ts: string;
  /**
   * `completed` / `failed` for a cycle that executed, `awaiting` for one the
   * gate sent to a human and that nobody has answered, `requested` for one
   * whose question was decided but never executed, `registered` for a cycle
   * that got no further.
   */
  outcome: "completed" | "failed" | "awaiting" | "requested" | "registered";
}

/**
 * The most recent advance cycle in the log, or `null` when there is none.
 *
 * Read from the LOG rather than from a status file, because the log already
 * carries every fact this answer needs and a second copy could disagree with
 * it. That is what lets `approval doctor` answer it in a different process from
 * the daemon that made the attempt, with no shared state between them, and what
 * makes the answer outlive the daemon's own event stream.
 */
export function lastAdvance(records: readonly EventRecord[]): LastAdvance | null {
  let task: string | null = null;
  for (const record of records) {
    if (record.event === "task.registered" && isAdvanceBookkeeping(record)) {
      task = record.task ?? null;
    }
  }
  if (task === null) return null;

  const mine = records.filter((record) => record.task === task);
  const last = mine[mine.length - 1];
  if (last === undefined) return null;
  const toSeq = Number.parseInt(task.slice(`${ADVANCE_TASK_PREFIX}-`.length), 10);
  const outcome: LastAdvance["outcome"] =
    last.event === "execution.completed"
      ? "completed"
      : last.event === "execution.failed"
        ? "failed"
        : last.event === "approval.requested"
          ? "awaiting"
          : last.event === "task.registered"
            ? "registered"
            : "requested";
  return { toSeq: Number.isNaN(toSeq) ? 0 : toSeq, ts: last.ts, outcome };
}
