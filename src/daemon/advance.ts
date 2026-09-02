/**
 * The daemon's log advance, on a cadence and through the gate (APRV-204).
 *
 * ## Why the daemon does this at all
 *
 * The committed log is this project's truth, and until this module its
 * freshness depended on somebody remembering to run `approval log advance`. The
 * daemon is already the committed log's sole writer in the primary checkout, it
 * is already awake, and since the seq 7413 ceremony `log.advance` resolves
 * `supervised-live 0.1` — a class that needs no hand on the keyboard for nine
 * runs in ten. So the bookkeeping moves here, and the human's part shrinks to
 * the tenth run and the merge.
 *
 * ## It borrows every mechanism and owns none
 *
 * - The advance itself is `cli/log-advance.ts`'s `logAdvance`, called
 *   unmodified: the same append lock, the same chain verify, the same staged-set
 *   refusal, the same commit-on-the-remote-without-a-checkout. A second
 *   implementation would be a second thing to get wrong about the one file
 *   nothing may rewind.
 * - The authorization is `core/gate.ts`'s `register` + `request` and
 *   `core/execute.ts`'s `startExecution` / `finishExecution`, in that order and
 *   with no shortcuts. The daemon proposes as `agent:daemon` and the runtime
 *   decides, exactly as it decides for a session.
 * - The cadence and the reporting are the only decisions here, and neither
 *   touches the log.
 *
 * ## What happens when the gate says no
 *
 * A `supervised-live` draw that SELECTS this advance, a class amended to
 * `manual`, a policy that will not load: all three end the attempt with nothing
 * committed and nothing pushed. The outcome is reported on the daemon's event
 * stream and readable afterwards from the log itself, and the next tick tries
 * again — after the cadence interval, never immediately, because the
 * last-attempt clock is set by a refusal exactly as it is by a success. There
 * is no retry loop and no backoff ladder: the cadence IS the backoff.
 *
 * ## `gh pr merge` appears nowhere in this file
 *
 * The daemon opens or updates the day's records pull request and stops there.
 * Merging to the trunk is `vcs.push.main`, which is a session's supervised act
 * or a human's, and a daemon that merged its own records would be the gate
 * approving its own evidence.
 *
 * ## The self-perpetuation trap, and how the trigger avoids it
 *
 * One advance cycle appends three records of its own (`task.registered`,
 * `execution.started`, `execution.completed`). Two of them land before the
 * commit and ride it; the third lands after, so every successful advance leaves
 * the log one record ahead of the records branch. A trigger that counted those
 * would advance forever on an idle repository. So the TRIGGER counts only
 * records that are not an advance's own bookkeeping (`PublishedState.substantive`),
 * while the count REPORTED to an operator is the honest raw one.
 *
 * ## Where the pieces live
 *
 * The cycle's vocabulary (the actor, the class, the task and key shapes, and
 * reading the last cycle back out of the log) is `core/advance-cycle.ts`, and
 * the git-side "what is already published" question is `cli/log-advance.ts`.
 * Both are shared with `approval doctor`, which reports the same numbers in a
 * different process — and a CLI module may not import the daemon.
 */

import { tick, type Clock } from "../core/clock.js";
import {
  ADVANCE_ACTOR,
  ADVANCE_CLASS,
  advanceActionKey,
  advanceTaskId,
} from "../core/advance-cycle.js";
import { finishExecution, startExecution } from "../core/execute.js";
import { register, request, type GateOptions } from "../core/gate.js";
import type { EventRecord } from "../core/log.js";
import { payloadHash } from "../core/payload.js";
import { defaultRecordsBranch, logAdvance, publishedState } from "../cli/log-advance.js";
import { repoRoot } from "../cli/git-scope.js";

/**
 * How often the daemon advances, absent the record-count trigger: 15 minutes.
 *
 * Chosen against what a records pull request costs and what staleness costs. A
 * shorter interval publishes a pull request whose diff is a handful of lines
 * and burns a CI run for each; a longer one leaves the guards that read the
 * committed log (the CI protected-path cross-check especially) looking at a log
 * that is hours behind the decisions it is supposed to evidence.
 */
export const DEFAULT_ADVANCE_INTERVAL_MS = 900_000;

/**
 * How many unpublished records force an advance before the interval elapses: 20.
 *
 * The busy-hour case. Twenty records is a few minutes of an active session, and
 * a records branch that far behind is a records branch a person starts doing
 * arithmetic against.
 */
export const DEFAULT_ADVANCE_AFTER_RECORDS = 20;

/** The cadence, as the daemon is configured with it. */
export interface AdvanceCadence {
  /** Minimum time between attempts, successful or not. */
  intervalMs: number;
  /** Attempt as soon as this many substantive records are unpublished. */
  afterRecords: number;
  remote: string;
  /** The remote branch the first advance of a day is parented on. */
  base: string | null;
  /** Open or update the day's pull request. */
  pr: boolean;
}

/** The default cadence, spelled once. */
export function defaultCadence(): AdvanceCadence {
  return {
    intervalMs: DEFAULT_ADVANCE_INTERVAL_MS,
    afterRecords: DEFAULT_ADVANCE_AFTER_RECORDS,
    remote: "origin",
    base: null,
    pr: true,
  };
}

/**
 * How an attempt ended. Machine-readable and closed (SPEC.md §11.1 invariant 6).
 *
 * - `advanced` — records were committed and pushed.
 * - `nothing-owed` — the records branch already carries every record.
 * - `gated` — the gate sent this advance to a human (the live draw selected it,
 *   or the class resolves `manual`). Nothing was committed.
 * - `refused` — the gate refused it outright (unattested policy, an escalated
 *   task, a `human-only` class, a budget). Nothing was committed.
 * - `failed` — the advance itself did not complete (a rejected push, a diverged
 *   remote, an unreadable index). The failure is recorded as an
 *   `execution.failed`.
 */
export type AdvanceOutcome = "advanced" | "nothing-owed" | "gated" | "refused" | "failed";

/** One attempt, as the daemon reports it and as a status reader recovers it. */
export interface AdvanceAttempt {
  outcome: AdvanceOutcome;
  /** The runtime's own clock reading, taken once at the top of the attempt. */
  ts: string;
  /** Records not yet on a records branch, counted honestly (bookkeeping included). */
  recordsPending: number;
  recordsBranch: string | null;
  commit: string | null;
  prUrl: string | null;
  /** True when this attempt OPENED the day's pull request rather than updating it. */
  prCreated: boolean;
  range: { from: number; to: number } | null;
  /** The refusal code, for every outcome that carries one. */
  code: string | null;
  message: string;
}

/** What {@link attemptAdvance} needs. Everything is injected; nothing is ambient. */
export interface AdvanceInput {
  logPath: string;
  /** The working directory the advance runs in: the primary checkout. */
  cwd: string;
  policy: { dir?: string; file?: string };
  schemaDir?: string;
  clock?: Clock;
  cadence: AdvanceCadence;
  /** The day the records branch is named for. Injected by tests. */
  today?: string;
}

// ---------------------------------------------------------------------------
// One gated attempt
// ---------------------------------------------------------------------------

/** The argv the payload binds to: the verb this attempt is authorization for. */
export function advanceArgv(cadence: AdvanceCadence): string[] {
  return [
    "approval",
    "log",
    "advance",
    ...(cadence.pr ? ["--pr"] : []),
    "--remote",
    cadence.remote,
    ...(cadence.base === null ? [] : ["--base", cadence.base]),
  ];
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Register, request, start, advance, finish. One attempt, in that order.
 *
 * The order is the whole point and none of it is optional: nothing is committed
 * before the gate has answered, and nothing the gate answered for goes
 * unrecorded. `execution.started` is appended BEFORE the advance runs, so the
 * commit the advance builds carries the record of its own authorization; the
 * `execution.completed` that follows lands after the commit and is published by
 * the next advance, which is why the trigger discounts it.
 */
export function attemptAdvance(
  input: AdvanceInput,
  records: readonly EventRecord[],
): AdvanceAttempt {
  const ts = tick(input.clock === undefined ? {} : { clock: input.clock });
  const today = input.today ?? ts;
  const root = repoRoot(input.cwd) ?? input.cwd;
  const recordsBranch = defaultRecordsBranch(today);
  const state = publishedState(root, input.logPath, records, input.cadence, today);

  const answer = (over: Partial<AdvanceAttempt> & { outcome: AdvanceOutcome; message: string }): AdvanceAttempt => ({
    ts,
    recordsPending: state.pending,
    recordsBranch,
    commit: null,
    prUrl: null,
    prCreated: false,
    range: null,
    code: null,
    ...over,
  });

  if (state.pending === 0) {
    return answer({
      outcome: "nothing-owed",
      message: `every record through seq ${String(state.publishedSeq)} is already on a records branch`,
    });
  }

  const gate: GateOptions = { policy: input.policy };
  if (input.schemaDir !== undefined) gate.schemaDir = input.schemaDir;
  if (input.clock !== undefined) gate.clock = input.clock;

  const task = advanceTaskId(state.workingSeq);
  const actionKey = advanceActionKey(state.publishedSeq + 1, state.workingSeq);
  // The bytes this authorization binds to: the command, where it runs, and the
  // seq span it publishes. The span is IN the hash deliberately (APRV-204). A
  // payload identical across cycles would give the `supervised-live` draw the
  // same verdict forever — a selected advance would stay selected on every
  // later tick and the cadence would stop for good — and a span is not a
  // re-roll: different records are a different action, which is exactly what
  // §5.2's no-re-roll property means by "changing the bytes is a different
  // request".
  const hash = payloadHash({
    argv: advanceArgv(input.cadence),
    cwd: root,
    seq: { from: state.publishedSeq + 1, to: state.workingSeq },
  });

  const registered = register(
    input.logPath,
    {
      task,
      envelope: {
        origin: { app: "approval-daemon", created_by: ADVANCE_ACTOR },
        state: "proposed",
        actions: [
          {
            class: ADVANCE_CLASS,
            idempotency_key: actionKey,
            summary: `log advance: seq ${String(state.publishedSeq + 1)}..${String(state.workingSeq)} onto ${recordsBranch}`,
            reversible: true,
            est_cost_usd: "0",
            payload_hash: hash,
          },
        ],
      },
    },
    ADVANCE_ACTOR,
    gate,
  );
  // A re-attempt at an unchanged head finds its own registration already in the
  // log. That is the retry working, not a failure: the cycle continues and the
  // request below adopts the declaration this one already wrote.
  if (!registered.ok && registered.code !== "task-already-registered") {
    return answer({ outcome: "refused", code: registered.code, message: registered.message });
  }

  const asked = request(
    input.logPath,
    {
      task,
      actionKey,
      cls: ADVANCE_CLASS,
      reversible: true,
      est_cost_usd: "0",
      summary: `log advance: seq ${String(state.publishedSeq + 1)}..${String(state.workingSeq)}`,
      payload_hash: hash,
      payload: { value: { argv: advanceArgv(input.cadence), cwd: root, seq: { from: state.publishedSeq + 1, to: state.workingSeq } } },
    },
    ADVANCE_ACTOR,
    gate,
  );
  if (!asked.ok) {
    return answer({ outcome: "refused", code: asked.code, message: asked.message });
  }
  if (!asked.proceed) {
    return answer({
      outcome: "gated",
      code: asked.live?.reason ?? "manual",
      message: `the gate sent this advance to a human (${
        asked.live === undefined
          ? `class ${ADVANCE_CLASS} resolves ${asked.autonomy}`
          : `supervised-live draw: ${asked.live.reason} at rate ${String(asked.live.rate)}`
      }); nothing was committed. The question is in the queue as ${actionKey}, and the next tick tries again.`,
    });
  }

  const started = startExecution(
    input.logPath,
    actionKey,
    {
      policy: input.policy,
      presentedPayloadHash: hash,
      ...(input.schemaDir === undefined ? {} : { schemaDir: input.schemaDir }),
      ...(input.clock === undefined ? {} : { clock: input.clock }),
    },
    ADVANCE_ACTOR,
  );
  if (!started.ok) {
    return answer({ outcome: "refused", code: started.code, message: started.message });
  }

  // The side effect, through the verb itself. Everything above this line is
  // authorization; everything below is reporting what the verb did.
  let advanced;
  try {
    advanced = logAdvance({
      cwd: root,
      remote: input.cadence.remote,
      base: input.cadence.base,
      pr: input.cadence.pr,
      branch: recordsBranch,
      today,
    });
  } catch (cause) {
    advanced = {
      ok: false as const,
      code: "log-advance-git-failed" as const,
      message: `the advance threw: ${detail(cause)}`,
    };
  }

  // The outcome, recorded. A finish that is itself refused (an external writer
  // moved the head between the advance and this append) leaves a dangling
  // execution, which is the honest state and which nothing here auto-repairs:
  // `approval status` surfaces it and a human resolves it. It is named in the
  // reported message rather than swallowed.
  const finished = finishExecution(input.logPath, actionKey, advanced.ok ? 0 : 1, ADVANCE_ACTOR, {
    policy: input.policy,
    ...(input.schemaDir === undefined ? {} : { schemaDir: input.schemaDir }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  const dangling = finished.ok
    ? ""
    : ` (the execution outcome could not be recorded: ${finished.message}; ${actionKey} is left dangling)`;

  if (!advanced.ok) {
    return answer({
      outcome: "failed",
      code: advanced.code,
      message: `${advanced.message}${dangling}`,
    });
  }
  const report = advanced.report;
  return answer({
    outcome: report.commit === null ? "nothing-owed" : "advanced",
    commit: report.commit,
    prUrl: report.prUrl,
    prCreated: report.prCreated ?? false,
    range: report.range,
    recordsBranch: report.recordsBranch,
    message:
      report.commit === null
        ? "the records branch already carried these bytes; nothing was committed"
        : `seq ${String(report.range?.from ?? 0)}..${String(
            report.range?.to ?? 0,
          )} is on ${report.recordsBranch}${report.prUrl === null ? "" : ` (${report.prUrl})`}${dangling}`,
  });
}
