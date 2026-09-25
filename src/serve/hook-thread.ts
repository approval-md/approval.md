/**
 * Hook calls off the listener's main thread, holding the store lock only while
 * they append (APRV-427).
 *
 * `serve/hook-worker.ts` holds the reasoning for the thread and the handshake.
 * This is the listener's half: a small pool of warm worker threads, and the
 * function that runs one hook call on one of them while taking and releasing
 * the store's lock on the thread's behalf.
 *
 * ## What the lock covers for a hook call
 *
 * Every stretch in which the call may append: from its first line to the start
 * of its poll loop (intake, the abandoned-question sweep, register, request),
 * and from the end of the loop to its verdict (the spend, a withdrawal). Those
 * are the stretches another in-process writer must not land inside. The loop
 * itself only reads the verified log and sleeps, so while the call polls the
 * lock is free and so is the main thread: other hooks open their own questions,
 * and the tenant's reads answer.
 *
 * ## Why a pool
 *
 * A thread per call would work, and would pay two costs per call that a warm
 * thread pays once: loading the CLI's modules, and proving the verified log
 * from genesis on its first read (each thread has its own read cache, as each
 * `approval hook` process does). Idle threads are kept up to
 * {@link HOOK_THREADS_IDLE}; beyond that a finished thread is terminated.
 *
 * ## Bounded, because each thread is a copy of the log (APRV-427 review)
 *
 * A thread carries its own parsed log in its read cache: about 26 MB for an
 * idle thread and another 84 MB once it has proved a 73k-record log. An
 * uncapped pool let thirty concurrent gated calls, or one harness retrying
 * faster than its hook timeout, grow the facade until the kernel killed it, and
 * a kill that lands inside an append leaves the log's lockfile behind with
 * nothing to recover it. So at most {@link HookThreadLimits.threads} calls run
 * at once (default {@link DEFAULT_HOOK_THREADS}); up to
 * {@link HookThreadLimits.queue} more wait for a slot in arrival order (default
 * {@link DEFAULT_HOOK_QUEUE}); and a call past both is refused at once with
 * {@link HookSaturatedError}, which the listener answers as a block
 * (`serve-hook-saturated`). A queued call has opened nothing yet, so the wait
 * costs the tenant nothing but time.
 *
 * Reusing a thread is what the listener did before this file existed: every
 * hook call ran in the one main thread, one after another, with whatever
 * module state the previous call left.
 */

import { SHARE_ENV, Worker } from "node:worker_threads";

import { HARNESS_CAP_MARGIN_MS, harnessCapFitsMargin } from "../core/harness-wait.js";
import type { HookJob, HookWorkerMessage } from "./hook-worker.js";

/** How many finished hook threads are kept warm for the next call. */
export const HOOK_THREADS_IDLE = 4;

/** Hook calls that may run at once, and so threads that may exist, by default. */
export const DEFAULT_HOOK_THREADS = 16;

/** Hook calls that may wait for a thread, by default, before one is refused. */
export const DEFAULT_HOOK_QUEUE = 64;

/** The two bounds on the pool. */
export interface HookThreadLimits {
  /** Calls running at once, and the most threads that ever exist. At least 1. */
  threads: number;
  /** Calls waiting for a slot. Zero refuses whatever finds every slot taken. */
  queue: number;
}

/** A call refused because every slot and every place in the queue is taken. */
export class HookSaturatedError extends Error {
  constructor(limits: HookThreadLimits) {
    super(
      `every hook slot is busy (${String(limits.threads)} running, ${String(limits.queue)} queued); nothing was registered or requested. Retry the tool call later; the operator raises the bounds with --hook-threads and --hook-queue`,
    );
    this.name = "HookSaturatedError";
  }

  /**
   * The call waited so long for a slot, or for the lock, that the harness's
   * ceiling leaves no window a human could answer in (APRV-427 review).
   */
  static outOfBudget(capMs: number, remainingMs: number): HookSaturatedError {
    const error = new HookSaturatedError({ threads: 0, queue: 0 });
    error.message = `this call waited for a hook slot until only ${String(Math.max(0, remainingMs))}ms of its ${String(capMs)}ms harness ceiling was left, which does not clear the ${String(HARNESS_CAP_MARGIN_MS)}ms margin: a question opened now would still be pending when the harness kills the call. Nothing was registered or requested. Retry the tool call; the operator raises --hook-threads if calls queue this long`;
    return error;
  }
}

/** When a call arrived and the harness ceiling it arrived under, or `null`. */
export interface HookBudget {
  arrivedAt: number;
  capMs: number | null;
}

/**
 * A call that will never be answered, because its client went away or the
 * listener is closing. Nothing is sent for it.
 */
export class HookCancelledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "HookCancelledError";
  }
}

/** The pool's state, for diagnostics and the tests that bound it. */
export interface HookThreadStats {
  /** Threads that exist (running or idle), not counting ones being terminated. */
  threads: number;
  /** Calls running on a thread. */
  busy: number;
  /** Calls waiting for a slot. */
  queued: number;
  /** The most threads that ever existed at once. */
  peakThreads: number;
  /** Calls whose thread has asked for the store lock and not yet been given it. */
  awaitingLock: number;
  /**
   * Verified reads from genesis made while a thread held the store lock, over
   * every call this pool has finished. The warm read keeps it at zero.
   */
  coldReadsInLock: number;
}

/** The store lock, as `mcp/server.ts`'s `serializer()` shapes one. */
export type StoreLock = <T>(work: () => Promise<T>) => Promise<T>;

/** What one hook call produced: the stdin form's exit code and both streams. */
export interface HookOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export interface HookThreads {
  /**
   * Run `approval hook <argv>` with `body` as its stdin, under `lock`'s
   * sections. `signal` aborts when the caller has gone away: a queued call
   * leaves the line, and a running one stops at its next poll tick without
   * spending or withdrawing (see `HookWaitSeam.cancelled`). Either way the
   * promise may still settle with the hook's own output, which nobody is owed.
   */
  run(
    argv: string[],
    cwd: string,
    logPath: string,
    body: string,
    signal?: AbortSignal,
    budget?: HookBudget,
  ): Promise<HookOutcome>;
  /**
   * Shut the pool down: cancel every running call and every queued one, then
   * terminate every thread, busy or idle, from inside the store lock so that
   * none is killed in a mutation section. A call in flight rejects or settles
   * with output nobody is owed.
   */
  close(): Promise<void>;
  /** The pool's state now. */
  stats(): HookThreadStats;
}

export function hookThreads(
  lock: StoreLock,
  limits: HookThreadLimits = { threads: DEFAULT_HOOK_THREADS, queue: DEFAULT_HOOK_QUEUE },
): HookThreads {
  const idle: Worker[] = [];
  const all = new Set<Worker>();
  let closed = false;
  /** Calls holding a slot. Never more than `limits.threads`. */
  let busy = 0;
  /** Calls waiting for a slot, oldest first. */
  const waiting: Array<{ grant: () => void; drop: (cause: Error) => void }> = [];
  /** The cancel word of every call running on a thread. */
  const running = new Set<Int32Array>();
  let peakThreads = 0;
  let coldReadsInLock = 0;
  let awaitingLock = 0;

  /**
   * Take a slot, waiting in line for one if every slot is held, or refuse.
   *
   * A thread is only ever spawned by a call holding a slot and finding no idle
   * thread, so the threads that exist never outnumber the slots.
   */
  async function slot(signal: AbortSignal | undefined): Promise<void> {
    if (busy < limits.threads) {
      busy += 1;
      return;
    }
    if (waiting.length >= limits.queue) throw new HookSaturatedError(limits);
    // The slot is handed over by `freeSlot`, so `busy` is unchanged by it. A
    // caller that leaves while in line leaves the line: it has opened nothing,
    // and a slot spent on it would be a slot a caller who is still there waits
    // for.
    await new Promise<void>((granted, dropped) => {
      const entry = {
        grant: () => {
          signal?.removeEventListener("abort", leave);
          granted();
        },
        drop: (cause: Error) => {
          signal?.removeEventListener("abort", leave);
          dropped(cause);
        },
      };
      function leave(): void {
        const at = waiting.indexOf(entry);
        if (at !== -1) waiting.splice(at, 1);
        entry.drop(new HookCancelledError("the caller went away while its hook call was queued"));
      }
      waiting.push(entry);
      signal?.addEventListener("abort", leave, { once: true });
    });
  }

  function freeSlot(): void {
    const next = waiting.shift();
    if (next !== undefined) next.grant();
    else busy -= 1;
  }

  function retire(worker: Worker): void {
    all.delete(worker);
    void worker.terminate();
  }

  function spawn(): Worker {
    const worker = new Worker(new URL("./hook-worker.js", import.meta.url), {
      // The launch environment, live, rather than a copy taken when the thread
      // was born: the verb reads the environment the host started this process
      // with (SPEC.md §11.1 invariant 7), and a warm thread must not answer
      // from an older one.
      env: SHARE_ENV,
    });
    // Neither an idle thread nor a busy one keeps the process alive on its own:
    // the listener does that, and a closed listener leaves nothing behind.
    worker.unref();
    all.add(worker);
    peakThreads = Math.max(peakThreads, all.size);
    // A thread that dies while idle must not take the process with it through
    // an unhandled `error`, nor be handed the next call.
    worker.on("error", () => undefined);
    worker.once("exit", () => {
      all.delete(worker);
      const at = idle.indexOf(worker);
      if (at !== -1) idle.splice(at, 1);
    });
    return worker;
  }

  function give(worker: Worker): void {
    if (!closed && idle.length < HOOK_THREADS_IDLE) idle.push(worker);
    else retire(worker);
  }

  async function run(
    argv: string[],
    cwd: string,
    logPath: string,
    body: string,
    signal?: AbortSignal,
    budget: HookBudget = { arrivedAt: Date.now(), capMs: null },
  ): Promise<HookOutcome> {
    if (closed) throw new HookCancelledError("the listener is closing");
    if (signal?.aborted === true) throw new HookCancelledError("the caller went away");
    await slot(signal);
    try {
      // The time in line is spent out of the harness's budget (APRV-427
      // review). A call that arrived with room and has none left is refused
      // here, before a thread is spent on it. A ceiling that never had room is
      // the hook's own refusal to make (`hook-harness-cap-too-short`), and an
      // autonomous call under it is still answered.
      const { capMs } = budget;
      if (capMs !== null && harnessCapFitsMargin(capMs)) {
        const remainingMs = capMs - Math.max(0, Date.now() - budget.arrivedAt);
        if (!harnessCapFitsMargin(remainingMs)) {
          throw HookSaturatedError.outOfBudget(capMs, remainingMs);
        }
      }
      return await runOnThread(argv, cwd, logPath, body, signal, budget);
    } finally {
      freeSlot();
    }
  }

  async function runOnThread(
    argv: string[],
    cwd: string,
    logPath: string,
    body: string,
    signal: AbortSignal | undefined,
    budget: HookBudget,
  ): Promise<HookOutcome> {
    if (closed) throw new HookCancelledError("the listener is closing");
    if (signal?.aborted === true) throw new HookCancelledError("the caller went away");
    const worker = idle.pop() ?? spawn();
    const shared = new SharedArrayBuffer(8);
    const flag = new Int32Array(shared);
    // The cancel word the hook's poll reads every tick. Set, never cleared: a
    // call whose caller left is over whatever happens next.
    const cancel = (): void => {
      Atomics.store(flag, 1, 1);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    running.add(flag);

    return await new Promise<HookOutcome>((settle, fail) => {
      /** Ends the section the thread is in, when it is in one. */
      let release: (() => void) | null = null;
      let finished = false;

      /** Take the store lock on the thread's behalf, then let it proceed. */
      const enter = (): void => {
        awaitingLock += 1;
        void lock(
          async () =>
            await new Promise<void>((done) => {
              awaitingLock -= 1;
              // The thread died while this was queued: nothing to hand over.
              if (finished) {
                done();
                return;
              }
              release = done;
              Atomics.store(flag, 0, 1);
              Atomics.notify(flag, 0);
            }),
        );
      };
      const leave = (): void => {
        const done = release;
        release = null;
        done?.();
      };

      const finish = (): void => {
        finished = true;
        leave();
        running.delete(flag);
        signal?.removeEventListener("abort", cancel);
        worker.off("message", onMessage);
        worker.off("exit", onExit);
      };

      function onMessage(message: HookWorkerMessage): void {
        switch (message.type) {
          case "wait":
            leave();
            return;
          case "resume":
            enter();
            return;
          case "done":
            coldReadsInLock += message.coldReadsInLock;
            finish();
            give(worker);
            settle({ code: message.code, stdout: message.stdout, stderr: message.stderr });
            return;
          case "failed":
            finish();
            give(worker);
            fail(new Error(message.message));
            return;
          case "saturated":
            finish();
            give(worker);
            fail(HookSaturatedError.outOfBudget(budget.capMs ?? 0, message.remainingMs));
            return;
          case "cancelled":
            finish();
            give(worker);
            fail(new HookCancelledError("the caller went away before its hook call began"));
            return;
        }
      }
      function onExit(code: number): void {
        finish();
        fail(new Error(`the hook thread exited (${String(code)}) before it answered`));
      }

      worker.on("message", onMessage);
      worker.once("exit", onExit);
      const job: HookJob = { argv, cwd, body, logPath, budget, flag: shared };
      // The thread warms its read cache first and then asks for its first
      // section with `resume`, so no cold walk of the log is ever made inside
      // the lock (see `hook-worker.ts`).
      worker.postMessage(job);
    });
  }

  return {
    run,
    stats: () => ({ threads: all.size, busy, queued: waiting.length, peakThreads, coldReadsInLock, awaitingLock }),
    close: async () => {
      closed = true;
      // Every running call stops at its next poll tick without spending or
      // withdrawing, exactly as for a client that went away; nobody in line
      // will be served.
      for (const flag of running) Atomics.store(flag, 1, 1);
      for (const entry of waiting.splice(0)) {
        entry.drop(new HookCancelledError("the listener is closing"));
      }
      const resting = idle.splice(0);
      await Promise.all(resting.map(async (worker) => await worker.terminate()));
      // A busy thread is terminated only from INSIDE the store lock. Holding it
      // means no thread is in a mutation section, so none is between taking the
      // log's append lockfile and releasing it: a thread killed there would
      // leave the lockfile behind and every later append would time out on it.
      // A thread in its wait holds neither, and a question it opened stays open
      // for the retry grace, exactly as for an `approval hook` process that was
      // killed mid-wait.
      await lock(async () => {
        await Promise.all([...all].map(async (worker) => await worker.terminate()));
      });
    },
  };
}
