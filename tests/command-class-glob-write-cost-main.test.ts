/**
 * MAIN's figure for #686's cost line `rsync_relative` (lead ruling L62090:
 * its bound is 1.5 x main's CI figure for the same input). Tests only, so in
 * this branch's CI run the code timed is main's, as #694 took its reference
 * for "many command words" (`command-class-substitution-cost.test.ts`).
 *
 * The same input and project as #686's `tests/command-class-glob-write-cost.test.ts`
 * (`rsync -aR s0/*\/./a* s1/*\/./a* …` to 7 KB), through main's hook path:
 * classifyForHook, timed in CPU seconds. Main has no listing step. It logs
 * `# cost-line: COST686 rsync_relative (main): <n.nn> CPU s` and asserts only
 * that the line classifies: the figure is what is read.
 *
 * Hermetic: HOME and the project are fixture directories holding made-up
 * files; no line is run.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { classifyForHook } from "../src/cli/hook.js";
import { cpuSeconds } from "./cost-runner.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-glob-write-cost-main-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

const HOME = join(scratch, "home");
mkdirSync(HOME);
process.env["HOME"] = HOME;
delete process.env["CDPATH"];

const PROJECT = join(scratch, "proj");
for (const [dir, file] of [[".claude", "settings.json"], [".github/workflows", "ci.yml"], ["src", "a.ts"], ["dist", "a.o"]] as const) {
  mkdirSync(join(PROJECT, dir), { recursive: true });
  writeFileSync(join(PROJECT, dir, file), "made-up\n");
}

/** `head`, then `format(i)` for i = 0, 1, ... while the line stays within `bytes`. */
function distinct(head: string, format: (index: string) => string, bytes: number): string {
  let line = head;
  for (let index = 0; ; index += 1) {
    const word = format(index.toString(16));
    if (Buffer.byteLength(line + word) > bytes) return line;
    line += word;
  }
}

test("cost reference (L62090): main's figure for rsync -aR with many distinct sources at 7 KB", () => {
  const command = distinct("rsync -aR", (index) => ` s${index}/*/./a*`, 7000);
  let classes: string[] = [];
  const seconds = cpuSeconds(() => {
    const result = classifyForHook(command, [], PROJECT, [], false, []).result;
    classes = result.ok ? result.classes : [`refused ${result.code}`];
  });
  console.log(`# cost-line: COST686 rsync_relative (main): ${seconds.toFixed(2)} CPU s (node ${process.version})`);
  assert.ok(classes.includes("network.call"), classes.join(","));
});
