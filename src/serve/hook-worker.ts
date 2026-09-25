/**
 * The thread a `POST /hook/<harness>` call runs on (APRV-427).
 *
 * A harness hook is synchronous from its first line to its verdict, and its
 * wait sleeps with `Atomics.wait`. Run on the listener's main thread, one hook
 * waiting on a human froze the event loop for the whole of that wait: no socket
 * was read, so the tenant's `GET /status` and `POST /verb/queue` sat unanswered
 * until the question was decided, and N gated calls from one sandbox queued
 * behind each other. Scoping a lock cannot fix a thread that does not run, so
 * the call runs here instead and the main thread stays free.
 *
 * This file runs the hook and nothing else. The verdict is `commandHook`'s, with
 * the request body as the stdin it would have read, exactly as before; what is
 * added is the {@link HookWaitSeam}, which is how this thread hands the store
 * lock back to the listener while the hook polls and asks for it again before
 * the hook appends.
 *
 * ## The handshake
 *
 * The lock lives on the main thread (`serve/server.ts`), because every other
 * writer in the process takes it there. This thread holds it BY PROXY: the
 * main thread acquires it on this thread's behalf and flips a shared flag.
 *
 * - A job arrives with the flag at 0. This thread first reads the verified log
 *   ONCE, outside the lock, to warm its own read cache (below), then posts
 *   `resume` and blocks on the flag before it runs a line of the hook, so
 *   intake, the sweep, register and request all happen under the lock.
 * - `enterWait` clears the flag FIRST and then posts `wait`: the main thread
 *   releases the lock, and a later `leaveWait` cannot be satisfied by the grant
 *   that has just ended.
 * - `leaveWait` posts `resume` and blocks on the flag until the main thread has
 *   re-acquired the lock and set it to 1.
 * - `done` carries the exit code and both streams, and ends the last section.
 *
 * A blocked `Atomics.wait` here costs this thread and nothing else, which is
 * the point of the thread.
 *
 * ## The warm read, outside the lock (APRV-427 review)
 *
 * A new thread's cache is empty, and its first verified read walks the whole
 * chain: 633 ms on a mature tenant log. Taken inside the lock, five threads
 * arriving together serialised five cold walks and held the tenant's `status`
 * behind all of them. So the cold walk happens here, before the lock is asked
 * for, and in parallel with every other thread's. The hook's own reads under
 * the lock are then warm: a hash over the prefix this thread already proved,
 * plus a walk of whatever was appended since. Nothing is decided from the warm
 * read itself, and nothing is appended on the strength of it; every append
 * inside the lock is still compare-and-append against a head read inside the
 * lock (SPEC.md §11.1 invariant 5).
 */

import { parentPort } from "node:worker_threads";

import { commandHook, type HookWaitSeam } from "../cli/hook.js";
import { readVerifiedRecords, useVerifiedSnapshots } from "../core/state.js";

/** One hook call, as the listener hands it over. */
export interface HookJob {
  argv: string[];
  cwd: string;
  body: string;
  /** The store's log, for the warm read before the lock. */
  logPath: string;
  /** One `Int32`: 1 while this thread holds the store lock by proxy, else 0. */
  flag: SharedArrayBuffer;
}

/** What this thread posts back. */
export type HookWorkerMessage =
  | { type: "wait" }
  | { type: "resume" }
  | { type: "done"; code: number; stdout: string; stderr: string }
  | { type: "failed"; message: string };

const port = parentPort;
if (port === null) {
  throw new Error("serve/hook-worker.ts runs as a worker thread and was loaded on the main thread");
}

// This thread is an `approval hook` process in every way that matters to a
// read, so it makes the same opt-in the hook makes on its gated path (APRV-188):
// a read may resume behind the daemon's published snapshot, admitted only
// against a hash this thread computes itself. Set once, before the warm read,
// so the warm read and the hook's own reads are one cache under one proof.
useVerifiedSnapshots(true);

port.on("message", (job: HookJob) => {
  const flag = new Int32Array(job.flag);
  const post = (message: HookWorkerMessage): void => port.postMessage(message);
  /** Block until the main thread has taken the store lock for this thread. */
  const held = (): void => {
    while (Atomics.load(flag, 0) !== 1) Atomics.wait(flag, 0, 0);
  };

  const seam: HookWaitSeam = {
    enterWait: () => {
      Atomics.store(flag, 0, 0);
      post({ type: "wait" });
    },
    leaveWait: () => {
      post({ type: "resume" });
      held();
    },
  };

  const out: string[] = [];
  const err: string[] = [];
  try {
    // Outside the lock, and its answer is thrown away: its only effect is the
    // proved prefix this thread's cache now holds. A read that fails here is
    // the hook's to meet and report, inside the lock, in its own words.
    readVerifiedRecords(job.logPath);
    post({ type: "resume" });
    held();
    const code = commandHook(
      job.argv,
      { out: (text) => out.push(text), err: (text) => err.push(text) },
      job.cwd,
      () => job.body,
      seam,
    );
    post({ type: "done", code, stdout: out.join(""), stderr: err.join("") });
  } catch (cause) {
    // `commandHook` already turns a throw inside the harness path into an
    // ordinary deny, so reaching this is a failure of the thread itself. It is
    // reported as one, and the listener answers it as a refusal: never an allow.
    post({ type: "failed", message: cause instanceof Error ? cause.message : String(cause) });
  }
});
