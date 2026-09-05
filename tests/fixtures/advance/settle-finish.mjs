/**
 * One `settleAdvanceFinish` in its own process (APRV-233).
 *
 * The second racer in the append race the outcome record used to lose. It is a
 * separate process for the reason `tests/concurrency.test.ts` gives: a race
 * between a reader and a writer inside one event loop is not the race, and the
 * parent has to be able to hold the append lock across this process's READ.
 *
 * argv: logPath, policyFile, cwd, actionKey, exitCode, attempts, readyFile.
 * It writes the ready file first, so the parent knows the process is up before
 * it starts timing anything, and prints the settle result as one JSON line.
 */

import { writeFileSync } from "node:fs";

import { settleAdvanceFinish } from "../../../dist/src/daemon/advance.js";
import { defaultCadence } from "../../../dist/src/daemon/advance.js";

const [logPath, policyFile, cwd, actionKey, exitCode, attempts, ready] = process.argv.slice(2);

writeFileSync(ready, "ready", "utf8");

const input = {
  logPath,
  cwd,
  policy: { file: policyFile },
  cadence: { ...defaultCadence(), base: "main" },
};
if (attempts !== "default") input.retryOnHeadMoved = Number(attempts);

const result = settleAdvanceFinish(input, {
  actionKey,
  exitCode: Number(exitCode),
});
process.stdout.write(JSON.stringify(result));
