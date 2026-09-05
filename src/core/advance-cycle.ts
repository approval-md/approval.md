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

import { danglingExecutions } from "./execute.js";
import type { EventRecord } from "./log.js";
import { payloadOf, requestState, type RequestState } from "./state.js";

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

/**
 * The most recent advance cycle's request, as the log derives it (APRV-211).
 *
 * The whole answer a tick needs before it considers asking anything: which key
 * the last question was opened under, what the human did with it, what bytes it
 * bound to, and whether anything has spent it yet.
 */
export interface OpenAdvanceRequest {
  actionKey: string;
  task: string | null;
  state: RequestState;
  /** The `payload_hash` the request declared, so an adopting tick binds to it. */
  payloadHash: string | null;
  /** True once an `execution.started` has spent this cycle. */
  spent: boolean;
}

/**
 * The latest advance request in the log, with its derived state, or `null`.
 *
 * ## Why the daemon asks this before it asks the gate anything
 *
 * A gated advance leaves an `approval.requested` open and its own two records
 * on the log. Until APRV-211 the next tick recomputed a key from the moving
 * head, found no request under it, and opened a second question about the same
 * owed work; the human got one phone buzz per tick for one advance. So the tick
 * now reads the log for what it already asked, and the answer here is that
 * reading.
 *
 * PURE, and over records the caller verified: the enforcement path never reads
 * an unverified log (SPEC.md §11.1). The TTL is applied through
 * {@link requestState}, so a request whose window lapsed reads `expired` here
 * whether or not the daemon has yet materialised an `approval.expired` record —
 * an adopting tick must not wait forever on a question nobody can answer.
 */
export function openAdvanceRequest(
  records: readonly EventRecord[],
  ts: string,
  ttlMs: number | null,
): OpenAdvanceRequest | null {
  let actionKey: string | null = null;
  for (const record of records) {
    if (record.event !== "approval.requested") continue;
    const key = record.action_key;
    if (typeof key !== "string" || !key.startsWith(`${ADVANCE_KEY_PREFIX}-`)) continue;
    // The class is read off the record rather than assumed from the prefix: a
    // key that merely LOOKS like the daemon's must not be able to make the
    // daemon adopt somebody else's question.
    if (payloadOf(record)["class"] !== ADVANCE_CLASS) continue;
    actionKey = key;
  }
  if (actionKey === null) return null;

  const derivation = requestState([...records], actionKey, ts, ttlMs);
  return {
    actionKey,
    task: derivation.task,
    state: derivation.state,
    payloadHash: derivation.declared.payload_hash,
    spent: derivation.execution.started !== null,
  };
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
  /**
   * Why it failed, as the verb said it (APRV-211): the refusal code and message
   * `cli/log-advance.ts` produced, copied onto `execution.failed` at the write
   * boundary. `null` for every other outcome and for a failure recorded before
   * the field existed — an exit status with no reason, which is the defect this
   * carries the fix for and not a shape any reader may assume away.
   */
  code: string | null;
  message: string | null;
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
  const payload = payloadOf(last);
  const code = typeof payload["code"] === "string" ? payload["code"] : null;
  const message = typeof payload["message"] === "string" ? payload["message"] : null;
  return {
    toSeq: Number.isNaN(toSeq) ? 0 : toSeq,
    ts: last.ts,
    outcome,
    code,
    message,
  };
}

// ---------------------------------------------------------------------------
// Dangling advance cycles, and what the trunk can prove about them (APRV-264)
// ---------------------------------------------------------------------------

/**
 * The one-line repair for a pile of dangling executions, spelled once.
 *
 * Every surface that reports an advance nobody closed ends with this command:
 * the daemon's refusal, its warning line, and the `log-advance-cadence` doctor
 * row. Spelled here because a repair an operator has to reconstruct from three
 * slightly different sentences is a repair they retype by hand five times,
 * which is exactly what was observed on 2026-09-05 and exactly what this task
 * removes.
 */
export const RESOLVE_DANGLING_COMMAND = "approval execution resolve --dangling";

/**
 * The seq the span named by `daemon-log-advance-<from>-<to>` ends at, or `null`.
 *
 * `null` for a key this runtime did not mint the shape of. A key whose tail is
 * not an integer names no span, so nothing about it can be proved from the
 * refs, and it is reported as unprovable rather than guessed at.
 */
export function advanceSpanEnd(actionKey: string): number | null {
  if (!actionKey.startsWith(`${ADVANCE_KEY_PREFIX}-`)) return null;
  const parsed = Number.parseInt(actionKey.split("-").pop() ?? "", 10);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * One dangling execution, and what this checkout's git refs can prove about it.
 *
 * `provenBy` is the whole point: a ref name, or `null`. A sweep may close only
 * the first kind, and every surface that reports the second kind reports it as
 * a human's to establish rather than as a failure — an `execution.failed`
 * written over an advance that actually published would be worse than the
 * dangling record it replaced.
 */
export interface DanglingAdvance {
  actionKey: string;
  task: string | null;
  /** The `execution.started` record's position. */
  seq: number;
  /** The seq the key names, or `null` when the key names no span. */
  toSeq: number | null;
  /** The ref that carries `toSeq`, or `null` when nothing in this checkout does. */
  provenBy: string | null;
}

/** Every dangling execution whose key is one this daemon mints, in log order. */
export function danglingAdvances(records: readonly EventRecord[]): DanglingAdvance[] {
  return danglingExecutions([...records])
    .filter((entry) => entry.actionKey.startsWith(`${ADVANCE_KEY_PREFIX}-`))
    .map((entry) => ({
      actionKey: entry.actionKey,
      task: entry.task,
      seq: entry.seq,
      toSeq: advanceSpanEnd(entry.actionKey),
      provenBy: null,
    }));
}

/**
 * The same list, with each entry's proof filled in from a published state.
 *
 * PURE, and the published state is an argument rather than something read here:
 * `publishedState` lives in `cli/log-advance.ts` because it reads git, a CLI
 * module may not import the daemon, and the daemon, the doctor row and
 * `execution resolve --dangling` must not disagree about which key counts as
 * proved. So the git read happens once in each caller and the RULE lives here.
 *
 * The rule is one comparison: the ref that carries the highest published seq
 * carries every seq below it, because `publishedState` only ever counts a copy
 * of this chain that is a PREFIX of the working log. So a span ending at or
 * below `publishedSeq` is on that ref, and a span above it is on nothing this
 * checkout can see.
 */
export function proveDanglingAdvances(
  records: readonly EventRecord[],
  published: { publishedSeq: number; publishedRev: string | null },
): DanglingAdvance[] {
  return danglingAdvances(records).map((entry) => ({
    ...entry,
    provenBy:
      entry.toSeq !== null && published.publishedRev !== null && entry.toSeq <= published.publishedSeq
        ? published.publishedRev
        : null,
  }));
}
