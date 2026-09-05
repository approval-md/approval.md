/**
 * One `settleAdvanceFinish` in its own process, paused between its read and its
 * append (APRV-233, made deterministic by APRV-261).
 *
 * The second party in the interleaving the outcome record used to lose. It is a
 * separate process for the reason `tests/concurrency.test.ts` gives: the record
 * that moves the head under this writer should be another process's record,
 * written through the real gate against the same log file, rather than a line
 * the test typed.
 *
 * What changed at APRV-261 is WHEN the parent is told to write it. This process
 * used to signal `ready` before it began, and the parent then slept a flat
 * 300 ms hoping the read had happened inside it. Now the signal comes from
 * within the finish path itself, through `AdvanceInput.afterFinishRead`: on the
 * FIRST attempt only, the seam writes `ready` — meaning "my read is done, the
 * head is yours to move" — and blocks until the parent creates `go`. The window
 * is constructed rather than waited for, and nothing here depends on how loaded
 * the machine is.
 *
 * Later attempts neither signal nor block: the retry's own read must see the
 * parent's record, which is the whole point of it.
 *
 * argv: logPath, policyFile, cwd, actionKey, exitCode, attempts, readyFile, goFile.
 * Prints `{ok, code, message, attempts}` as one JSON line, where `attempts` is
 * how many times the seam fired, which is how many whole read-check-append
 * cycles the writer made.
 */

import { existsSync, writeFileSync } from "node:fs";

import { settleAdvanceFinish } from "../../../dist/src/daemon/advance.js";
import { defaultCadence } from "../../../dist/src/daemon/advance.js";

const [logPath, policyFile, cwd, actionKey, exitCode, attempts, ready, go] = process.argv.slice(2);

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let seen = 0;

const input = {
  logPath,
  cwd,
  policy: { file: policyFile },
  cadence: { ...defaultCadence(), base: "main" },
  afterFinishRead: () => {
    seen += 1;
    if (seen > 1) return;
    writeFileSync(ready, "read", "utf8");
    while (!existsSync(go)) sleep(1);
  },
};
if (attempts !== "default") input.retryOnHeadMoved = Number(attempts);

const result = settleAdvanceFinish(input, {
  actionKey,
  exitCode: Number(exitCode),
});
process.stdout.write(JSON.stringify({ ...result, attempts: seen }));
