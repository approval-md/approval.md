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

import { parentPort, workerData } from "node:worker_threads";

import { commandHook, type HookWaitSeam } from "../cli/hook.js";
import {
  declareResolvedDaemonIdentity,
  narrowerAllowlist,
  refreshDaemonAllowlistFrom,
  type DaemonIdResolution,
} from "../core/daemon-host.js";
import { daemonIdentity, setDaemonAllowlist } from "../core/daemon-identity.js";
import { harnessCapFitsMargin } from "../core/harness-wait.js";
import type { LoadPolicyOptions } from "../core/policy-load.js";
import { processReadCache, readVerifiedRecords, useVerifiedSnapshots } from "../core/state.js";

/**
 * What every thread in the pool writes as (APRV-448), handed over once as the
 * thread's `workerData`.
 *
 * A worker thread holds its own copy of every module, so the identity the
 * listener declared on its own thread is not declared here: without this, a
 * hook call's records would carry no `daemon` field and meet no `daemons`
 * allowlist while a verb call's beside them did. The listener resolves the id
 * ONCE, from its launch environment and its log path, and every thread declares
 * that same resolution; no request carries any part of it.
 */
export interface HookWriter {
  /** The listener's own resolution, declared verbatim. */
  daemon: DaemonIdResolution;
  /** Where the store's policy is, for the per-call allowlist refresh. */
  policy: LoadPolicyOptions;
}

/** One hook call, as the listener hands it over. */
export interface HookJob {
  argv: string[];
  cwd: string;
  body: string;
  /** The store's log, for the warm read before the lock. */
  logPath: string;
  /**
   * When the call arrived (epoch ms, the listener's clock, which is this
   * thread's too) and the harness ceiling it arrived under, or `null` where
   * the harness has none. The remainder is computed ONCE, when the lock
   * arrives, and the hook is handed that exact number.
   */
  budget: { arrivedAt: number; capMs: number | null };
  /**
   * The `daemons` allowlist the listener holds in force when it hands the call
   * over (APRV-448 review), or `null` for no restriction. The thread starts
   * each call from the stricter of this and its own, so a thread whose own
   * resolution fails (a policy edited and not re-attested) never runs wider
   * than the listener beside it.
   */
  allowed: readonly string[] | null;
  /**
   * Two `Int32`s. `[0]` is 1 while this thread holds the store lock by proxy,
   * else 0. `[1]` is set to 1 by the listener when the HTTP client that asked
   * has gone away (or the listener is closing), and read by the hook's poll as
   * {@link HookWaitSeam.cancelled}.
   */
  flag: SharedArrayBuffer;
}

/** What this thread posts back. */
export type HookWorkerMessage =
  | { type: "wait" }
  | { type: "resume" }
  | {
      type: "done";
      code: number;
      stdout: string;
      stderr: string;
      /**
       * Verified reads from genesis this call made while holding the store
       * lock. Zero is the property the warm read exists for; the listener
       * sums it into its diagnostics so a test can assert it without timing.
       */
      coldReadsInLock: number;
    }
  | { type: "failed"; message: string }
  /** The caller went away before the hook began: nothing was run or appended. */
  | { type: "cancelled" }
  /**
   * The call's harness budget ran below the margin while it waited for the
   * lock, so no question it opened could be held: nothing was run or appended.
   */
  | { type: "saturated"; remainingMs: number };

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

// APRV-448. This thread appends on the gate's behalf exactly as the listener's
// own thread does, so it declares the same identity before it runs a line of
// any hook. Declared once: the resolution is the listener's, fixed at startup.
const writer = workerData as HookWriter;
declareResolvedDaemonIdentity(writer.daemon);

port.on("message", (job: HookJob) => {
  const flag = new Int32Array(job.flag);
  const post = (message: HookWorkerMessage): void => port.postMessage(message);
  // Cold reads (cache misses) made inside a locked section, counted section
  // by section: `mark` is taken when the lock arrives and settled when it goes.
  let coldReadsInLock = 0;
  let mark = 0;
  const settle = (): void => {
    coldReadsInLock += processReadCache.stats.misses - mark;
  };
  /** Block until the main thread has taken the store lock for this thread. */
  const held = (): void => {
    while (Atomics.load(flag, 0) !== 1) Atomics.wait(flag, 0, 0);
    mark = processReadCache.stats.misses;
  };

  const seam: HookWaitSeam = {
    enterWait: () => {
      settle();
      Atomics.store(flag, 0, 0);
      post({ type: "wait" });
    },
    leaveWait: () => {
      post({ type: "resume" });
      held();
      // Every append after a wait (the execution after a grant, an expiry) is
      // judged against the list in force NOW, not the one read before a wait
      // that may have lasted minutes (APRV-448 review).
      refreshDaemonAllowlistFrom(job.logPath, writer.policy);
    },
    cancelled: () => Atomics.load(flag, 1) === 1,
  };
  const gone = (): boolean => Atomics.load(flag, 1) === 1;

  const out: string[] = [];
  const err: string[] = [];
  try {
    // Outside the lock, and its answer is thrown away: its only effect is the
    // proved prefix this thread's cache now holds. A read that fails here is
    // the hook's to meet and report, inside the lock, in its own words.
    //
    // A caller that went away before the hook began is owed nothing and has
    // asked nothing yet (APRV-427 review), so the call ends without running a
    // line of the hook: looked at before the warm read, after it, and once
    // more when the lock arrives, because the wait for the lock is where a
    // queue of busy sections makes a client give up. Past this point the
    // hook's own poll is what notices.
    if (gone()) {
      post({ type: "cancelled" });
      return;
    }
    readVerifiedRecords(job.logPath);
    if (gone()) {
      post({ type: "cancelled" });
      return;
    }
    post({ type: "resume" });
    held();
    if (gone()) {
      settle();
      post({ type: "cancelled" });
      return;
    }
    // The `daemons` allowlist in force for this call (APRV-448), resolved from
    // the attested policy and this thread's verified read, inside the lock and
    // before the hook appends anything: the listener's thread does the same
    // before every verb call. A resolution that fails leaves the previous one
    // standing, as the daemon's tick does; and the standing one is never wider
    // than the listener's, so a thread spawned after the policy lost its
    // attestation does not start unrestricted (APRV-448 review).
    setDaemonAllowlist(narrowerAllowlist(daemonIdentity()?.allowed ?? null, job.allowed));
    refreshDaemonAllowlistFrom(job.logPath, writer.policy);
    // The budget, looked at once more now the lock is here (APRV-427 review):
    // a call that had room when it arrived and spent it waiting in line or for
    // the lock would open a question the harness kills its asker before
    // anyone can answer. Refused as saturation instead, appending nothing.
    //
    // Measured ONCE, and the same number is what the hook judges by, waits by
    // and records: a remainder re-measured inside the hook a few milliseconds
    // later could fall under the margin after this check had admitted it, and
    // turn an admitted call into `hook-harness-cap-too-short`.
    const { arrivedAt, capMs } = job.budget;
    if (capMs !== null) {
      const remainingMs = Math.max(0, capMs - Math.max(0, Date.now() - arrivedAt));
      if (harnessCapFitsMargin(capMs) && !harnessCapFitsMargin(remainingMs)) {
        settle();
        post({ type: "saturated", remainingMs });
        return;
      }
      seam.remainingCapMs = remainingMs;
    }
    const code = commandHook(
      job.argv,
      { out: (text) => out.push(text), err: (text) => err.push(text) },
      job.cwd,
      () => job.body,
      seam,
    );
    settle();
    post({ type: "done", code, stdout: out.join(""), stderr: err.join(""), coldReadsInLock });
  } catch (cause) {
    // `commandHook` already turns a throw inside the harness path into an
    // ordinary deny, so reaching this is a failure of the thread itself. It is
    // reported as one, and the listener answers it as a refusal: never an allow.
    post({ type: "failed", message: cause instanceof Error ? cause.message : String(cause) });
  }
});
