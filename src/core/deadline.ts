import { createContext, Script, type Context } from "node:vm";

/**
 * Run synchronous work under a wall-clock deadline, in this thread.
 *
 * The hook answers a harness that runs it on a timer, and a hook the harness
 * kills is a tool call that PROCEEDS (Claude Code treats a killed hook as a
 * non-blocking error). So any input whose classification outlasts the
 * harness's limit would run with no gate at all, whatever it was. A deadline
 * this process keeps for itself turns that into an answer: the caller refuses.
 *
 * `node:vm` gives the one supported way to stop synchronous JavaScript from
 * outside it: a script run with `timeout` is watched by a second thread, which
 * terminates execution in this isolate when the time is up. The work is an
 * ordinary closure of this module's realm, called from a one-line script, so
 * nothing is copied and nothing runs in another context but that one call.
 * About 0.06 ms a call.
 *
 * TERMINATION IS NOT AN EXCEPTION. No `catch` sees it and no `finally` runs,
 * so whatever the work was in the middle of stays half done: a module's
 * reading flags, a cache being filled. After `{ ok: false }` the caller must
 * not ask the interrupted code anything again; it answers and ends.
 *
 * It bounds JavaScript. A blocking system call (a synchronous child process)
 * is not interrupted until it returns.
 *
 * An error the work throws is thrown on, unchanged. A nested call runs inline
 * under the outer deadline.
 */
export function runUnderDeadline<T>(milliseconds: number, run: () => T): { ok: true; value: T } | { ok: false } {
  if (running) return { ok: true, value: run() };
  context ??= createContext({ run: null, out: null });
  const holder = context as unknown as { run: (() => unknown) | null; out: unknown };
  holder.run = run;
  holder.out = undefined;
  running = true;
  try {
    CALL.runInContext(context, { timeout: Math.max(1, Math.floor(milliseconds)) });
    return { ok: true, value: holder.out as T };
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return { ok: false };
    throw error;
  } finally {
    running = false;
    holder.run = null;
    holder.out = null;
  }
}

const CALL = new Script("out = run()");
let context: Context | null = null;
let running = false;
