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

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { tick, type Clock } from "../core/clock.js";
import {
  ADVANCE_ACTOR,
  ADVANCE_CLASS,
  ADVANCE_KEY_PREFIX,
  advanceActionKey,
  advanceTaskId,
  openAdvanceRequest,
} from "../core/advance-cycle.js";
import { childEnvironment } from "../core/child-env.js";
import {
  danglingExecutions,
  finishExecution,
  startExecution,
  type FailureReason,
  type FinishOptions,
  type FinishResult,
} from "../core/execute.js";
import { register, request, type GateOptions } from "../core/gate.js";
import { attemptsOf, withHeadRetry } from "../core/head-retry.js";
import type { EventRecord } from "../core/log.js";
import { payloadHash } from "../core/payload.js";
import { loadPolicy } from "../core/policy-load.js";
import {
  defaultRecordsBranch,
  logAdvance,
  publishedState,
  type LogAdvanceReport,
} from "../cli/log-advance.js";
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
  /**
   * True when the day's records branch was REBUILT on the base rather than
   * stacked on its own tip (APRV-234), and the ref it was rebuilt on.
   */
  rebuilt: boolean;
  rebuiltOn: string | null;
  /**
   * The outcome this attempt observed and could NOT record (APRV-233).
   *
   * `null` in the ordinary case, where `execution.completed` or
   * `execution.failed` landed. Non-null when the bounded head-moved retry was
   * spent and the execution is therefore left open: the advance's effect has
   * happened, this process knows how it ended, and the log does not yet. The
   * daemon carries it to the next tick and settles it there
   * ({@link settleAdvanceFinish}) before it evaluates any trigger, which is
   * what stops a lost outcome record from reading as "no advance yet".
   */
  pendingFinish: PendingAdvanceFinish | null;
}

/**
 * An advance outcome that happened and is not yet in the log (APRV-233).
 *
 * Every field is an OBSERVATION this runtime made, carried forward verbatim: a
 * later tick appends exactly the record the failing one would have appended.
 * Nothing here is re-derived and nothing is guessed — a dangling execution
 * whose outcome this process does not hold stays dangling for a human, exactly
 * as `core/execute.ts` says it must.
 */
export interface PendingAdvanceFinish {
  actionKey: string;
  exitCode: number;
  reason?: FailureReason;
  note?: FailureReason;
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
  /**
   * The child that runs the git side effect for {@link runAdvanceAsync}, when
   * something other than this module's own runner should run it (APRV-211).
   *
   * A test seam and nothing else: production spawns `daemon/advance-child.js`
   * under `process.execPath`. It exists because the property AC7 pins — a tap
   * answered while an advance is in flight — needs an advance that stays in
   * flight for longer than a real one does, and the alternative (making the
   * daemon's own git work slow to order) would put test-only branches on the
   * path that publishes the log.
   */
  runner?: { command: string; args: readonly string[] };
  /**
   * How many times the outcome record is re-derived against a moved head
   * (APRV-233). Clamped to 1..`core/head-retry.ts`'s `HEAD_MOVED_ATTEMPTS` by
   * that module's own `attemptsOf`, and downward only.
   *
   * The seam a test uses to pin BOTH shapes with one harness, exactly as
   * `GateOptions.retryOnHeadMoved` does for the harness writers: `1` is the
   * pre-APRV-233 writer, whose lost race left the execution dangling. A caller
   * may ask for less tolerance of a moved head, never for more; ambiguity — a
   * zero, a fraction, a negative, a larger number — resolves to the runtime's
   * own value rather than the caller's.
   */
  retryOnHeadMoved?: number;
  /**
   * The other half of that seam (APRV-261), forwarded to the finish path as
   * `FinishOptions.afterRead`: a callback fired between one attempt's read and
   * its append, which is where a test puts the record that moves the head.
   *
   * `retryOnHeadMoved` pins how hard the writer tries; this pins that it has to
   * try at all. Together they let one harness drive both shapes with no
   * sleeping anywhere: the pre-APRV-233 writer at `1`, and the retried writer
   * at the default. Production sets neither.
   */
  afterFinishRead?: () => void;
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
 * The half of an attempt that talks to the gate, with nothing committed yet.
 *
 * Split out in APRV-211 so the two halves can run in different places: the
 * authorization stays in the DAEMON's own process, where the launch environment
 * carries the sampling secret the `supervised-live` draw needs and where the
 * append lock is held for milliseconds, while the git side effect may move to a
 * child (`runAdvanceAsync`) whose environment is scrubbed of exactly that
 * secret (`core/child-env.ts`). Authorization is fast and must be trusted;
 * `git fetch` + `git push` + `gh pr create` is slow and needs no trust at all.
 */
export type AdvanceAuthorization =
  | { authorized: false; attempt: AdvanceAttempt }
  | {
      authorized: true;
      /** The clock reading the attempt was opened with. */
      ts: string;
      today: string;
      root: string;
      recordsBranch: string;
      /** The key the execution was started under: the one the human answered. */
      actionKey: string;
      recordsPending: number;
      /**
       * True when this authorization rode a decision an EARLIER tick asked for
       * rather than one this tick opened. Reported so an operator reading the
       * event stream can tell "the human just said yes" from "the human said
       * yes at 11:04 and this is the tick that spent it".
       */
      adopted: boolean;
    };

/** Build an {@link AdvanceAttempt} with this attempt's fixed fields filled in. */
function answerFor(
  ts: string,
  recordsPending: number,
  recordsBranch: string,
): (over: Partial<AdvanceAttempt> & { outcome: AdvanceOutcome; message: string }) => AdvanceAttempt {
  return (over) => ({
    ts,
    recordsPending,
    recordsBranch,
    commit: null,
    prUrl: null,
    prCreated: false,
    range: null,
    code: null,
    rebuilt: false,
    rebuiltOn: null,
    pendingFinish: null,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// The bounded head-moved retry on the outcome record (APRV-233)
// ---------------------------------------------------------------------------

/**
 * Append the advance's outcome, re-deriving it against a fresh head on
 * `head-moved` (APRV-233).
 *
 * ## What went wrong without it
 *
 * Observed 2026-09-02 on Carter's terminal: the advance pushed
 * `records-log-2026-09-02`, and then `execution.completed could not be
 * appended: head moved` — a harness hook's record landed between this module's
 * read and its append, the compare-and-append refused the stale write exactly
 * as SPEC.md §11.1 invariant 5 requires, and `daemon-log-advance-1-13984` was
 * left open. Every other writer on this path has re-derived and re-attempted
 * since APRV-150; this one did not, and the cost of losing the race was an
 * execution the log said had never ended.
 *
 * ## What an attempt is
 *
 * The WHOLE operation, not a re-append: {@link finishExecution} re-reads the
 * verified log, re-runs its `not-started` / `already-finished` /
 * `execution-delegated` checks against that read, and appends with the head
 * THAT read observed. Nothing crosses an attempt except the outcome the caller
 * observed, which is a fact about the world rather than a conclusion about the
 * log, so no stale derivation can authorize a write. A verdict that genuinely
 * changed in the window (another writer closed the execution first) is the
 * verdict returned, and the bound is returned unchanged once it is spent, so
 * the caller still fails closed.
 *
 * ## One retry, in one place
 *
 * The loop and the bound are `core/head-retry.ts`'s (APRV-236 lifted them there
 * for every gate writer, and APRV-233's first draft of this function was the
 * local copy that helper replaced). `attemptsOf` clamps a caller's
 * `retryOnHeadMoved` downward only, so the test harness can pin the unretried
 * shape at `1` and nothing can raise the ceiling; `withHeadRetry` re-runs the
 * whole `finishExecution` and adds the attempt count to the message it finally
 * hands back. What remains here is only which operation is retried.
 */
function finishWithHeadMovedRetry(
  logPath: string,
  actionKey: string,
  exitCode: number,
  options: FinishOptions & { retryOnHeadMoved?: number },
): FinishResult {
  return withHeadRetry(attemptsOf(options.retryOnHeadMoved), () =>
    finishExecution(logPath, actionKey, exitCode, ADVANCE_ACTOR, options),
  );
}

/**
 * Close an execution whose outcome an EARLIER tick observed and could not
 * record (APRV-233).
 *
 * The second half of the fix, and the one that matters after a restart of the
 * loop rather than of the process: the outcome is carried in memory as a
 * {@link PendingAdvanceFinish} and re-attempted here, on the fresh head,
 * before the next tick evaluates any trigger. It appends the same record the
 * failed attempt would have appended, through the same bounded retry.
 *
 * `already-finished` is a SUCCESS here: something (a concurrent settle, a
 * human's `approval execution resolve`) closed the cycle in the meantime, the
 * log holds an outcome, and there is nothing left to carry.
 */
export function settleAdvanceFinish(
  input: AdvanceInput,
  pending: PendingAdvanceFinish,
): { ok: boolean; code: string | null; message: string } {
  const result = finishWithHeadMovedRetry(input.logPath, pending.actionKey, pending.exitCode, {
    policy: input.policy,
    ...(input.schemaDir === undefined ? {} : { schemaDir: input.schemaDir }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    ...(input.retryOnHeadMoved === undefined ? {} : { retryOnHeadMoved: input.retryOnHeadMoved }),
    ...(input.afterFinishRead === undefined ? {} : { afterRead: input.afterFinishRead }),
    ...(pending.reason === undefined ? {} : { reason: pending.reason }),
    ...(pending.note === undefined ? {} : { note: pending.note }),
  });
  if (result.ok) {
    return {
      ok: true,
      code: null,
      message: `the outcome of ${pending.actionKey} is recorded (${result.event})`,
    };
  }
  if (result.code === "already-finished") {
    return {
      ok: true,
      code: null,
      message: `${pending.actionKey} was already closed by another writer; nothing was appended`,
    };
  }
  return {
    ok: false,
    code: result.code,
    message: `the outcome of ${pending.actionKey} still could not be recorded: ${result.message}`,
  };
}

/**
 * The advance cycle whose execution is open, if one is (APRV-233).
 *
 * Read from the log rather than from this process's memory, so a daemon that
 * restarted still sees that an advance HAPPENED. It is the fact the cadence was
 * missing on 2026-09-02: with no outcome record, nothing but an in-process
 * clock said the branch had just been pushed.
 */
export function danglingAdvanceExecution(records: readonly EventRecord[]): string | null {
  const open = danglingExecutions([...records]).filter((entry) =>
    entry.actionKey.startsWith(`${ADVANCE_KEY_PREFIX}-`),
  );
  return open[open.length - 1]?.actionKey ?? null;
}

/** The seq the span named by `daemon-log-advance-<from>-<to>` ends at, or null. */
function spanEndOf(actionKey: string): number | null {
  const parsed = Number.parseInt(actionKey.split("-").pop() ?? "", 10);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Close a dangling advance cycle whose outcome the git refs still show
 * (APRV-233).
 *
 * ## The loop this breaks
 *
 * From Carter's terminal, 2026-09-02, with the APRV-211 build running: tick two
 * advanced and pushed; its `execution.completed` lost the head race (expected
 * 14874, found 14875) and `daemon-log-advance-1-14871` was left open. Tick
 * three's authorization then reached `startExecution` on that same key and was
 * refused `already-executed: an idempotency key is single-use and nothing here
 * reconciles or reruns it` — which is the gate saying, correctly, that
 * somebody has to close the books. Nobody did, so the span moved and the daemon
 * pushed again, and again, every ninety seconds under a fifteen-minute
 * interval.
 *
 * ## What is and is not a guess here
 *
 * {@link settleAdvanceFinish} covers the case this process still holds the
 * outcome for. This covers the other one — a cycle left open by an earlier
 * process, or by a tick whose memory of it is gone — and it closes it only on
 * EVIDENCE: the records the cycle was authorized to publish are demonstrably on
 * a records branch, read from git's own object store through the same
 * `publishedState` the cadence and the doctor row read. When the evidence is
 * there the outcome is recorded as the completion it was, with a note saying
 * which ref proved it. When it is NOT there, nothing is written: the execution
 * stays open for a person, the daemon warns, and no new advance is started over
 * work nobody has accounted for. A false `execution.failed` for an advance that
 * actually published would be worse than the dangling record.
 *
 * This is a deliberate, narrow carve-out to `core/execute.ts`'s rule that
 * nothing closes a dangling execution automatically. Narrow because it closes
 * only an execution THIS runtime started, for its own `log.advance` cycle,
 * whose entire effect is a git ref this runtime can look at and did.
 */
export function reconcileDanglingAdvance(
  input: AdvanceInput,
  records: readonly EventRecord[],
): { actionKey: string; settled: boolean; message: string } | null {
  const actionKey = danglingAdvanceExecution(records);
  if (actionKey === null) return null;

  const root = repoRoot(input.cwd) ?? input.cwd;
  const today = input.today ?? tick(input.clock === undefined ? {} : { clock: input.clock });
  const state = publishedState(root, input.logPath, records, input.cadence, today);
  const to = spanEndOf(actionKey);
  if (to === null || state.publishedSeq < to) {
    return {
      actionKey,
      settled: false,
      message: `${actionKey} is an advance execution nobody closed, and no records branch in this checkout carries seq ${
        to === null ? "the span it named" : String(to)
      } (the highest published seq is ${String(
        state.publishedSeq,
      )}). Nothing is recorded for it: an outcome this runtime cannot observe is a human's to establish (\`approval status\`, then \`approval execution resolve\`). No further advance is started while it stands.`,
    };
  }

  const finished = finishWithHeadMovedRetry(input.logPath, actionKey, 0, {
    policy: input.policy,
    ...(input.schemaDir === undefined ? {} : { schemaDir: input.schemaDir }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    ...(input.retryOnHeadMoved === undefined ? {} : { retryOnHeadMoved: input.retryOnHeadMoved }),
    ...(input.afterFinishRead === undefined ? {} : { afterRead: input.afterFinishRead }),
    note: {
      code: "advance-reconciled",
      message: `the outcome record was lost when this cycle ran; seq ${String(
        to,
      )} is on a records branch in this checkout, so the advance completed`,
    },
  });
  if (finished.ok) {
    return {
      actionKey,
      settled: true,
      message: `${actionKey} was left open by an earlier advance; seq ${String(
        to,
      )} is on a records branch, so its completion is now recorded`,
    };
  }
  return {
    actionKey,
    settled: false,
    message: `${actionKey} could not be closed: ${finished.message}`,
  };
}

/**
 * Register, request, start. The authorization, and not one byte of side effect.
 *
 * The order is the whole point and none of it is optional: nothing is committed
 * before the gate has answered, and nothing the gate answered for goes
 * unrecorded. `execution.started` is appended BEFORE the advance runs, so the
 * commit the advance builds carries the record of its own authorization; the
 * `execution.completed` that follows lands after the commit and is published by
 * the next advance, which is why the trigger discounts it.
 *
 * ## What APRV-211 changed: the tick asks the log what it already asked
 *
 * Observed live on 2026-09-02: three ticks over ONE owed advance put three
 * questions on Carter's phone, because the idempotency key embedded the log
 * HEAD and the head moved with each gated attempt's own two records. Two things
 * fix it and both are here.
 *
 * 1. The key and the payload span end at `substantiveSeq` — the last unpublished
 *    record that is not an advance cycle's own bookkeeping — so a tick that
 *    appended only its own question computes the SAME key and the SAME hash.
 * 2. Before it registers anything, the tick reads {@link openAdvanceRequest}.
 *    A question still open is ADOPTED (nothing is appended, the outcome is
 *    `gated`, and the human keeps the one question they already have); a grant
 *    on it is SPENT (straight to `startExecution` on that key, with the hash
 *    that key declared, so the single-use rule the log already enforces makes
 *    one decision authorise exactly one advance); a terminal answer on the
 *    CURRENT owed span is HONOURED (`advance-decided`, and nothing is asked
 *    again until the span itself changes).
 */
export function authorizeAdvance(
  input: AdvanceInput,
  records: readonly EventRecord[],
): AdvanceAuthorization {
  const ts = tick(input.clock === undefined ? {} : { clock: input.clock });
  const today = input.today ?? ts;
  const root = repoRoot(input.cwd) ?? input.cwd;
  const recordsBranch = defaultRecordsBranch(today);
  const state = publishedState(root, input.logPath, records, input.cadence, today);
  const answer = answerFor(ts, state.pending, recordsBranch);
  const no = (
    over: Partial<AdvanceAttempt> & { outcome: AdvanceOutcome; message: string },
  ): AdvanceAuthorization => ({ authorized: false, attempt: answer(over) });

  if (state.pending === 0) {
    return no({
      outcome: "nothing-owed",
      message: `every record through seq ${String(state.publishedSeq)} is already on a records branch`,
    });
  }

  // APRV-233. An advance cycle nobody closed the books on. Reaching
  // `startExecution` from here produced the bare `already-executed` Carter saw
  // on 2026-09-02 — the gate saying, correctly, that an idempotency key is
  // single-use and nothing there reconciles or reruns it — after which the span
  // moved and the branch was pushed all over again. The reconciliation belongs
  // to {@link reconcileDanglingAdvance}, which the caller runs first; if it is
  // still here, it is still a human's, and nothing is authorized over it.
  const unreconciled = danglingAdvanceExecution(records);
  if (unreconciled !== null) {
    return no({
      outcome: "refused",
      code: "advance-unreconciled",
      message: `the advance ${unreconciled} was started and its outcome was never recorded; nothing new is authorized until that cycle is closed (\`approval status\` shows it; \`approval execution resolve\` closes it).`,
    });
  }

  const gate: GateOptions = { policy: input.policy };
  if (input.schemaDir !== undefined) gate.schemaDir = input.schemaDir;
  if (input.clock !== undefined) gate.clock = input.clock;

  const task = advanceTaskId(state.substantiveSeq);
  const actionKey = advanceActionKey(state.publishedSeq + 1, state.substantiveSeq);
  // The bytes this authorization binds to: the command, where it runs, and the
  // seq span it publishes. The span is IN the hash deliberately (APRV-204). A
  // payload identical across cycles would give the `supervised-live` draw the
  // same verdict forever — a selected advance would stay selected on every
  // later tick and the cadence would stop for good — and a span is not a
  // re-roll: different records are a different action, which is exactly what
  // §5.2's no-re-roll property means by "changing the bytes is a different
  // request".
  //
  // It ends at the OWED span's end rather than at the head (APRV-211). The
  // advance publishes whatever the log holds when it runs, which is this span
  // plus this cycle's own two or three bookkeeping records; naming the owed
  // span is what makes one owed advance one question, and the bookkeeping is
  // not work anybody is being asked to approve.
  const hash = payloadHash({
    argv: advanceArgv(input.cadence),
    cwd: root,
    seq: { from: state.publishedSeq + 1, to: state.substantiveSeq },
  });

  // What this daemon already asked, and what became of it. Read from the
  // verified records the caller handed in — the enforcement path never reads an
  // unverified log (SPEC.md §11.1) — and aged against the policy's own TTL, so a
  // question whose window lapsed stops being adopted whether or not the
  // `approval.expired` record has been materialised yet.
  const loaded = loadPolicy({
    ...(input.policy.file === undefined ? {} : { file: input.policy.file }),
    ...(input.policy.dir === undefined ? {} : { dir: input.policy.dir }),
    ...(input.schemaDir === undefined ? {} : { schemaDir: input.schemaDir }),
  });
  const open = openAdvanceRequest(records, ts, loaded.ok ? loaded.durations.approvalTtlMs : null);
  const adopted = open !== null && open.actionKey === actionKey;

  if (open !== null && open.state === "requested") {
    // Whatever the span has done since, a question is standing. Asking a second
    // one would multiply the taps this cadence exists to remove, and answering
    // the standing one authorises the advance the moment the next tick runs.
    return no({
      outcome: "gated",
      code: "advance-open",
      message: `an advance question is already open as ${open.actionKey} and nobody has answered it; nothing was asked again and nothing was committed. Answering it authorises the next tick's advance.`,
    });
  }
  if (adopted && open !== null && open.state !== "granted") {
    return no({
      outcome: "refused",
      code: "advance-decided",
      message: `the advance of seq ${String(state.publishedSeq + 1)}..${String(state.substantiveSeq)} was already answered (${open.state} as ${open.actionKey}); nothing is asked again until the owed span changes.`,
    });
  }
  if (adopted && open !== null && open.state === "granted" && open.spent) {
    // The grant was consumed — by the advance that failed, or by one whose
    // `execution.completed` has not been published yet. Either way the
    // authorisation is gone, and a fresh question about an unchanged span is a
    // retry loop with a human in it. The reason the last one failed is on the
    // `execution.failed` and on the doctor row.
    return no({
      outcome: "refused",
      code: "advance-spent",
      message: `the decision on ${open.actionKey} has already been spent on an execution; this owed span will not be asked again until it changes.`,
    });
  }

  // The grant this tick is riding was earned by an earlier tick's question, so
  // there is nothing to declare and nothing to ask: the declaration and the
  // question are in the log already, and re-asking is the defect. Straight to
  // the execution, bound to the hash THAT request declared.
  const declaredHash = adopted && open !== null && open.payloadHash !== null ? open.payloadHash : hash;
  if (!adopted) {
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
              summary: `log advance: seq ${String(state.publishedSeq + 1)}..${String(state.substantiveSeq)} onto ${recordsBranch}`,
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
    // A re-attempt at an unchanged span finds its own registration already in
    // the log. That is the retry working, not a failure: the cycle continues and
    // the request below adopts the declaration this one already wrote.
    if (!registered.ok && registered.code !== "task-already-registered") {
      return no({ outcome: "refused", code: registered.code, message: registered.message });
    }

    const asked = request(
      input.logPath,
      {
        task,
        actionKey,
        cls: ADVANCE_CLASS,
        reversible: true,
        est_cost_usd: "0",
        summary: `log advance: seq ${String(state.publishedSeq + 1)}..${String(state.substantiveSeq)}`,
        payload_hash: hash,
        payload: { value: { argv: advanceArgv(input.cadence), cwd: root, seq: { from: state.publishedSeq + 1, to: state.substantiveSeq } } },
        // APRV-211. The requester is this process, and it will open the grant
        // itself through the sealed address this request publishes. No granting
        // surface is handed a raw token, so no granting surface can print one on
        // a terminal for an action nobody at that terminal is going to run.
        delivery: "self",
      },
      ADVANCE_ACTOR,
      gate,
    );
    if (!asked.ok) {
      return no({ outcome: "refused", code: asked.code, message: asked.message });
    }
    if (!asked.proceed) {
      return no({
        outcome: "gated",
        code: asked.live?.reason ?? "manual",
        message: `the gate sent this advance to a human (${
          asked.live === undefined
            ? `class ${ADVANCE_CLASS} resolves ${asked.autonomy}`
            : `supervised-live draw: ${asked.live.reason} at rate ${String(asked.live.rate)}`
        }); nothing was committed. The question is in the queue as ${actionKey}, and the next tick adopts it rather than asking again.`,
      });
    }
  }

  const started = startExecution(
    input.logPath,
    actionKey,
    {
      policy: input.policy,
      presentedPayloadHash: declaredHash,
      ...(input.schemaDir === undefined ? {} : { schemaDir: input.schemaDir }),
      ...(input.clock === undefined ? {} : { clock: input.clock }),
    },
    ADVANCE_ACTOR,
  );
  if (!started.ok) {
    return no({ outcome: "refused", code: started.code, message: started.message });
  }

  return {
    authorized: true,
    ts,
    today,
    root,
    recordsBranch,
    actionKey,
    recordsPending: state.pending,
    adopted,
  };
}

// ---------------------------------------------------------------------------
// The side effect, and the record of how it ended
// ---------------------------------------------------------------------------

/** What the verb did, in the one shape both runners hand to {@link recordFinish}. */
type AdvanceRun =
  | { ok: true; report: LogAdvanceReport }
  | { ok: false; code: string; message: string };

/** Run the verb here, on this stack. The shutdown flush's path. */
function runVerbHere(input: AdvanceInput, auth: Extract<AdvanceAuthorization, { authorized: true }>): AdvanceRun {
  try {
    return logAdvance({
      cwd: auth.root,
      remote: input.cadence.remote,
      base: input.cadence.base,
      pr: input.cadence.pr,
      branch: auth.recordsBranch,
      today: auth.today,
    });
  } catch (cause) {
    return { ok: false, code: "log-advance-git-failed", message: `the advance threw: ${detail(cause)}` };
  }
}

/**
 * Close the execution and report. The gate work, always in this process.
 *
 * A finish that is itself refused (an external writer moved the head between
 * the advance and this append) leaves a dangling execution, which is the honest
 * state and which nothing here auto-repairs: `approval status` surfaces it and
 * a human resolves it. It is named in the reported message rather than
 * swallowed.
 *
 * The verb's own refusal code and message travel onto `execution.failed`
 * (APRV-211). Exit 1 with no reason was the reported half of the 2026-09-02
 * incident: the daemon knew why the push failed and the log did not.
 */
function recordFinish(
  input: AdvanceInput,
  auth: Extract<AdvanceAuthorization, { authorized: true }>,
  advanced: AdvanceRun,
): AdvanceAttempt {
  const answer = answerFor(auth.ts, auth.recordsPending, auth.recordsBranch);
  const exitCode = advanced.ok ? 0 : 1;
  const reason = advanced.ok ? undefined : { code: advanced.code, message: advanced.message };
  // APRV-234. A rebuilt branch is worth explaining even when the advance
  // succeeded: an operator reading the doctor row a day later needs to know
  // that today's records branch was re-parented on the trunk rather than
  // stacked, and on which commit. A REPORT, never an authorization — nothing in
  // the gate reads it back.
  const note =
    advanced.ok && advanced.report.rebuilt === true
      ? {
          code: "advance-rebuilt",
          message: `the day's records branch was rebuilt on ${
            advanced.report.rebuiltOn?.ref ?? "the base"
          } ${(advanced.report.rebuiltOn?.sha ?? "").slice(0, 12)}${
            advanced.report.recordsBranch === auth.recordsBranch
              ? ""
              : ` and opened as ${advanced.report.recordsBranch}`
          }`,
        }
      : undefined;

  // APRV-233. Bounded, and each attempt a whole operation against a fresh head.
  const finished = finishWithHeadMovedRetry(input.logPath, auth.actionKey, exitCode, {
    policy: input.policy,
    ...(input.schemaDir === undefined ? {} : { schemaDir: input.schemaDir }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    ...(input.retryOnHeadMoved === undefined ? {} : { retryOnHeadMoved: input.retryOnHeadMoved }),
    ...(input.afterFinishRead === undefined ? {} : { afterRead: input.afterFinishRead }),
    ...(reason === undefined ? {} : { reason }),
    ...(note === undefined ? {} : { note }),
  });
  // The bound is spent and the execution is open. The effect HAPPENED and this
  // process knows how it ended, so the outcome is carried to the next tick
  // rather than lost; until it is recorded the cadence treats this advance as
  // still in hand and starts no other.
  const pendingFinish: PendingAdvanceFinish | null = finished.ok
    ? null
    : {
        actionKey: auth.actionKey,
        exitCode,
        ...(reason === undefined ? {} : { reason }),
        ...(note === undefined ? {} : { note }),
      };
  const dangling = finished.ok
    ? ""
    : ` (the execution outcome could not be recorded: ${finished.message}; ${auth.actionKey} is left open and the next tick settles it before it advances anything)`;

  if (!advanced.ok) {
    return answer({
      outcome: "failed",
      code: advanced.code,
      message: `${advanced.message}${dangling}`,
      pendingFinish,
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
    rebuilt: report.rebuilt === true,
    rebuiltOn: report.rebuiltOn === undefined ? null : report.rebuiltOn.ref,
    pendingFinish,
    message:
      report.commit === null
        ? "the records branch already carried these bytes; nothing was committed"
        : `seq ${String(report.range?.from ?? 0)}..${String(
            report.range?.to ?? 0,
          )} is on ${report.recordsBranch}${
            report.rebuilt === true
              ? ` (rebuilt on ${report.rebuiltOn?.ref ?? "the base"} ${(report.rebuiltOn?.sha ?? "").slice(0, 12)})`
              : ""
          }${report.prUrl === null ? "" : ` (${report.prUrl})`}${dangling}`,
  });
}

/**
 * The advance, on this stack, start to finish. The shutdown flush's path.
 *
 * Kept synchronous deliberately: `finish()` runs inside the daemon's shutdown,
 * where there is no loop left to return to and an advance that settled after
 * the process exited would be an advance nobody recorded.
 */
export function runAdvanceSync(
  input: AdvanceInput,
  auth: Extract<AdvanceAuthorization, { authorized: true }>,
): AdvanceAttempt {
  return recordFinish(input, auth, runVerbHere(input, auth));
}

/**
 * The advance, with the git work in a child, so this loop keeps answering.
 *
 * ## Why a child rather than an `await`
 *
 * The second half of the 2026-09-02 incident: `answerCallbackQuery: HTTP 400`,
 * over and over, around the grants. Telegram drops a callback query that is not
 * answered inside its window, and `approval up` runs the channel listener and
 * the daemon in ONE process on ONE loop. `logAdvance` is `spawnSync` from end to
 * end — `git fetch`, a scratch-index commit, `git push`, `gh pr create` — so
 * every tap that arrived during an advance waited for the push to finish, and
 * the human got a button that never toasted. A promise would not have helped:
 * synchronous work does not yield no matter what it is wrapped in. Only another
 * process does.
 *
 * ## What does NOT move
 *
 * The gate work. `core/child-env.ts` strips `APPROVAL_*` from a child's
 * environment (APRV-205), and the `supervised-live` draw's secret is exactly
 * such a variable, so a child that asked the gate would be a child that could
 * not draw and would fail closed on every tick. Authorization happens in
 * {@link authorizeAdvance}, in this process, before the child is spawned;
 * {@link recordFinish} closes the execution in this process, after it settles.
 * The child gets one job — the git side effect — and no authority whatsoever.
 * It never touches the log: it cannot append, and everything it says comes back
 * as one JSON line on its stdout.
 */
export function runAdvanceAsync(
  input: AdvanceInput,
  auth: Extract<AdvanceAuthorization, { authorized: true }>,
): Promise<AdvanceAttempt> {
  return new Promise<AdvanceAttempt>((resolve) => {
    const spec = input.runner ?? {
      command: process.execPath,
      args: [fileURLToPath(new URL("./advance-child.js", import.meta.url))],
    };
    const request_ = JSON.stringify({
      cwd: auth.root,
      remote: input.cadence.remote,
      base: input.cadence.base,
      pr: input.cadence.pr,
      branch: auth.recordsBranch,
      today: auth.today,
    });
    let child;
    try {
      child = spawn(spec.command, [...spec.args, request_], {
        cwd: auth.root,
        env: childEnvironment().env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      resolve(
        recordFinish(input, auth, {
          ok: false,
          code: "log-advance-child-unspawnable",
          message: `the advance child could not be started: ${detail(cause)}`,
        }),
      );
      return;
    }
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.stderr.on("data", (chunk: string) => (err += chunk));
    const settle = (run: AdvanceRun): void => {
      resolve(recordFinish(input, auth, run));
    };
    child.on("error", (cause) => {
      settle({
        ok: false,
        code: "log-advance-child-unspawnable",
        message: `the advance child could not be started: ${detail(cause)}`,
      });
    });
    child.on("close", (code) => {
      const parsed = parseChildReport(out);
      if (parsed !== null) {
        settle(parsed);
        return;
      }
      settle({
        ok: false,
        code: "log-advance-child-unreadable",
        message: `the advance child exited ${String(code)} and said nothing this runtime could read${
          err.trim() === "" ? "" : `: ${err.trim().slice(0, 400)}`
        }`,
      });
    });
  });
}

/**
 * The child's one line, or `null` when it is not the shape this expects.
 *
 * Validated rather than cast: the child is another process, its stdout is
 * input, and a report this runtime cannot recognise is a failed advance with a
 * machine-readable reason — never a success taken on faith.
 */
function parseChildReport(text: string): AdvanceRun | null {
  const line = text.trim().split("\n").pop();
  if (line === undefined || line === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const shape = value as Record<string, unknown>;
  if (shape["ok"] === true && typeof shape["report"] === "object" && shape["report"] !== null) {
    return { ok: true, report: shape["report"] as LogAdvanceReport };
  }
  if (shape["ok"] === false && typeof shape["code"] === "string" && typeof shape["message"] === "string") {
    return { ok: false, code: shape["code"], message: shape["message"] };
  }
  return null;
}

/**
 * Register, request, start, advance, finish. One attempt, on this stack.
 *
 * The whole cycle for a caller that has no loop to protect: the shutdown flush,
 * `--once`, and every test that asserts on what one tick did.
 */
export function attemptAdvance(
  input: AdvanceInput,
  records: readonly EventRecord[],
): AdvanceAttempt {
  const auth = authorizeAdvance(input, records);
  if (!auth.authorized) return auth.attempt;
  return runAdvanceSync(input, auth);
}
