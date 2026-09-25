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
 * {@link HOOK_THREADS_IDLE}; beyond that a finished thread is terminated. The
 * number BUSY at once is not capped here: a hook call is already bounded by its
 * own wait, and a cap would bring back exactly the queueing this file exists to
 * remove.
 *
 * Reusing a thread is what the listener did before this file existed: every
 * hook call ran in the one main thread, one after another, with whatever
 * module state the previous call left.
 */

import { SHARE_ENV, Worker } from "node:worker_threads";

import type { HookJob, HookWorkerMessage } from "./hook-worker.js";

/** How many finished hook threads are kept warm for the next call. */
export const HOOK_THREADS_IDLE = 4;

/** The store lock, as `mcp/server.ts`'s `serializer()` shapes one. */
export type StoreLock = <T>(work: () => Promise<T>) => Promise<T>;

/** What one hook call produced: the stdin form's exit code and both streams. */
export interface HookOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export interface HookThreads {
  /** Run `approval hook <argv>` with `body` as its stdin, under `lock`'s sections. */
  run(argv: string[], cwd: string, logPath: string, body: string): Promise<HookOutcome>;
  /**
   * Terminate every thread, busy or idle, never inside a mutation section. A
   * call in flight rejects.
   */
  close(): Promise<void>;
}

export function hookThreads(lock: StoreLock): HookThreads {
  const idle: Worker[] = [];
  const all = new Set<Worker>();
  let closed = false;

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
    else void worker.terminate();
  }

  async function run(argv: string[], cwd: string, logPath: string, body: string): Promise<HookOutcome> {
    if (closed) throw new Error("the listener is closing");
    const worker = idle.pop() ?? spawn();
    const shared = new SharedArrayBuffer(4);
    const flag = new Int32Array(shared);

    return await new Promise<HookOutcome>((settle, fail) => {
      /** Ends the section the thread is in, when it is in one. */
      let release: (() => void) | null = null;
      let finished = false;

      /** Take the store lock on the thread's behalf, then let it proceed. */
      const enter = (): void => {
        void lock(
          async () =>
            await new Promise<void>((done) => {
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
            finish();
            give(worker);
            settle({ code: message.code, stdout: message.stdout, stderr: message.stderr });
            return;
          case "failed":
            finish();
            give(worker);
            fail(new Error(message.message));
            return;
        }
      }
      function onExit(code: number): void {
        finish();
        fail(new Error(`the hook thread exited (${String(code)}) before it answered`));
      }

      worker.on("message", onMessage);
      worker.once("exit", onExit);
      const job: HookJob = { argv, cwd, body, logPath, flag: shared };
      // The thread warms its read cache first and then asks for its first
      // section with `resume`, so no cold walk of the log is ever made inside
      // the lock (see `hook-worker.ts`).
      worker.postMessage(job);
    });
  }

  return {
    run,
    close: async () => {
      closed = true;
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
