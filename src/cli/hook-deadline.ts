/**
 * The hook's own deadline on classifying a tool call.
 *
 * Every harness this runtime speaks to bounds the hook process, and on all but
 * one of them a hook that is killed for running long is a NON-BLOCKING error:
 * Claude Code, Cursor, Grok Build and Muse Code run the tool call, and Hermes
 * blocks only with `fail_closed: true` on a build that honours it. The wait for
 * a human has had a deadline since APRV-106 (`--timeout`, clamped by APRV-423),
 * but classification runs before that wait, synchronously, and no timer can
 * fire during synchronous work. So a command whose classification is
 * super-linear in some word of it (a 40,000-segment path, a long run of glob
 * stars against a large directory) ran past the harness cap, the harness killed
 * the hook, and the call went through unjudged. Each such path is fixed when it
 * is found; this module turns the whole class of bug into a refusal.
 *
 * The classification runs inside `vm.Script#runInThisContext` with a
 * `timeout`. Node arms a watchdog thread for the call, and when it fires V8
 * terminates the running JavaScript wherever it is, a backtracking regular
 * expression included, and throws `ERR_SCRIPT_EXECUTION_TIMEOUT` at the `vm`
 * boundary. A JavaScript `catch` or `finally` inside the job cannot intercept
 * the termination, so the interrupted classification cannot produce a verdict.
 * Nothing in the classification appends to the log, holds the log's lock or
 * writes a file, so stopping it part way leaves nothing to undo; the caller
 * answers deny and the process (or the `approval serve` thread) moves on.
 *
 * A call that finishes in time returns exactly what it would have returned
 * without the deadline: the job is the same function called with the same
 * arguments, in the same realm, and its value or its error is passed through.
 * The cost on that path is one watchdog thread per call (about 0.07 ms on the
 * machine this was measured on), paid once per gated tool call.
 */

import { Script } from "node:vm";

/**
 * The longest this hook spends classifying one tool call, in milliseconds, when
 * nothing shorter is known about the harness's cap.
 *
 * 20 s. Claude Code's documented default hook timeout is 60 s, and its adapter
 * declares no cap of its own, so this is a third of that default: the rest is
 * for Node's start-up, the verified read of the log, the verdict, and slack for
 * a loaded machine, where wall time stretches. Ordinary classification takes
 * milliseconds (the slowest bounded path the suite prices, the brace expander,
 * is about 2 CPU s), so this is reached only on a pathological input or on a
 * machine slowed more than tenfold.
 */
export const HOOK_CLASSIFY_DEADLINE_MS = 20_000;

/**
 * The deny code a call whose classification ran out of time is refused with.
 * A member of `HOOK_DENY_CODES` in `cli/hook.ts`.
 */
export const HOOK_CLASSIFY_DEADLINE_CODE = "hook-classify-deadline";

/** The deadline and the injected slowness a test may set. Nothing in `src/` sets one. */
export interface ClassifyDeadlineSeam {
  /** Replaces the computed deadline, in milliseconds. */
  deadlineMs?: number;
  /** Runs inside the deadline, before the classification (a stand-in for a slow classifier). */
  before?: () => void;
}

let seamForTests: ClassifyDeadlineSeam | null = null;

/** Set the deadline seam (tests only). `null` restores the real deadline and removes the injected work. */
export function setClassifyDeadlineForTests(seam: ClassifyDeadlineSeam | null): void {
  seamForTests = seam;
}

/**
 * The classification deadline for a hook running under `harnessCapMs`, the
 * effective harness cap (`effectiveHarnessCapMs` in `cli/hook.ts`, already
 * charged for time spent in `approval serve`'s queue), or `null` when no cap
 * is known.
 *
 * With a cap, a third of it, and never more than
 * {@link HOOK_CLASSIFY_DEADLINE_MS}: Hermes's default 30 s callback timeout
 * gives 10 s, a stated 60 s gives 20 s, and anything longer stays at 20 s,
 * because a classification still running after 20 s is pathological whatever
 * the harness would tolerate. Without one, the 20 s that fits Claude Code's
 * 60 s default. At least 1 ms, the smallest timeout `vm` accepts.
 */
export function classifyDeadlineMs(harnessCapMs: number | null): number {
  if (seamForTests?.deadlineMs !== undefined) return seamForTests.deadlineMs;
  if (harnessCapMs === null) return HOOK_CLASSIFY_DEADLINE_MS;
  return Math.max(1, Math.min(HOOK_CLASSIFY_DEADLINE_MS, Math.floor(harnessCapMs / 3)));
}

/** What {@link runWithinDeadline} returns: the job's value, or the time it was stopped at. */
export type DeadlineOutcome<T> = { ok: true; value: T } | { ok: false; elapsedMs: number };

/** The global slot the runner script reads the job from, for the length of one call. */
const JOB_SLOT = Symbol.for("approval-md.classify-deadline-job");

/** Compiled once, on first use, and run once per call. */
let runner: Script | null = null;

function isTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
  );
}

/**
 * Run `job` synchronously, and stop it if it is still running after
 * `deadlineMs`.
 *
 * The job reaches the script through a symbol-keyed global set for the length
 * of the call and restored afterwards, because `runInThisContext` evaluates
 * source text and the call must happen inside it for the watchdog to cover it.
 * The script reads the slot before the job starts, so a nested call (none
 * exists today) would still run its own job.
 */
export function runWithinDeadline<T>(deadlineMs: number, job: () => T): DeadlineOutcome<T> {
  runner ??= new Script(`globalThis[Symbol.for("approval-md.classify-deadline-job")]()`, {
    filename: "approval-md:classify-deadline",
  });
  const before = seamForTests?.before;
  const slots = globalThis as unknown as Record<symbol, unknown>;
  const previous = slots[JOB_SLOT];
  slots[JOB_SLOT] = (): T => {
    before?.();
    return job();
  };
  const started = performance.now();
  try {
    const value = runner.runInThisContext({
      timeout: Math.max(1, Math.floor(deadlineMs)),
      displayErrors: false,
    }) as T;
    return { ok: true, value };
  } catch (error) {
    if (isTimeout(error)) return { ok: false, elapsedMs: performance.now() - started };
    throw error;
  } finally {
    slots[JOB_SLOT] = previous;
  }
}

/** Seconds, to one decimal place, for the refusal's words. */
function secondsText(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The detail of a {@link HOOK_CLASSIFY_DEADLINE_CODE} refusal: what happened,
 * that the call was not judged, and what to do instead.
 */
export function classifyDeadlineDetail(elapsedMs: number, deadlineMs: number): string {
  return `the hook stopped judging this call after ${secondsText(elapsedMs)}, its own deadline of ${secondsText(deadlineMs)}, so the call was not judged and is refused rather than left to the harness's timeout, which would let it run. Nothing was appended. Split the command into shorter commands, or shorten the long path, glob pattern or word that made it slow, and try again.`;
}
