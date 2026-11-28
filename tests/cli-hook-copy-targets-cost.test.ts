/**
 * The write pass's cost on a copy with many `-t` (#695's follow-up, brief
 * COST-695). Since #695 the hook judges where a copy, move or link lands: each
 * `<dir>/<source name>` in every target directory. Each `-t` after the first
 * is one more directory every source is judged in, and the other `-t` values
 * count as sources too, so the landings grew as directories times names: a
 * plain `cp notes.txt -t d0 s0/x -t d1 s1/x …` of 8 KB judged about 460,000
 * of them and reached the hook's 15 s deadline (before #695 the line took
 * about 2 s through the real hook, the 1 s approval wait included).
 *
 * The pass now reads each source's names once per segment and judges at most
 * INTO_EXTRA_LANDINGS_CAP landings in the directories after the first; past
 * that the segment is guarded as unreadable. GNU cp, mv and ln refuse a second
 * `-t` outright (macOS cp has no `-t`), so the cap only changes the answer for
 * a line those programs refuse.
 *
 * Each line runs the hook's entry (`classifyForHook`, both name readings) in a
 * made-up project and logs `# cost-line: COST695 <name>: <n.nn> CPU s (bound
 * <n.nn>; node <v>)`. Each bound is about three times a local measurement of
 * the fixed pass on an M-series laptop (runner factor 1) and far below main
 * 606df106's figure, stretched by the runner's factor only
 * (`tests/cost-runner.ts`). The plain line's figure is mostly the classifier's
 * own reading of the line (about 1.2 of its 2 CPU s, the same before #695);
 * the write pass is about 0.4 of it. CPU time, not wall-clock time.
 * Hermetic: HOME and the project are fixture directories; no line is run.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { classifyForHook, WRITE_SCOPE_OFF } from "../src/cli/hook.js";
import { cpuSeconds, runner, scaledBound } from "./cost-runner.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-copy-targets-cost-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

const HOME = join(scratch, "home");
mkdirSync(join(HOME, ".hermes"), { recursive: true });
writeFileSync(join(HOME, ".hermes", ".env"), "MADE_UP=1\n");
process.env["HOME"] = HOME;
delete process.env["CDPATH"];

const PROJECT = join(scratch, "proj");
mkdirSync(join(PROJECT, ".approval", "keys"), { recursive: true });
writeFileSync(join(PROJECT, "notes.txt"), "made-up\n");

// Locally (node 26, factor 1): plain 1.95 to 2.0 CPU s with this fix, 23.4 on
// main 606df106 and 1.65 before #695 (main 03931ea2); credential 0.70 with
// this fix, 6.66 on main 606df106 and 0.18 before #695.
const BOUND_PLAIN_S = 6;
const BOUND_CREDENTIAL_S = 2.5;

const GUARDED = "files.write.guarded";

/** `head`, then `unit(i)` for i = 0, 1, ... while the line stays within `bytes`. */
function filled(head: string, unit: (index: number) => string, bytes: number): string {
  let line = head;
  for (let index = 0; ; index += 1) {
    const word = unit(index);
    if (Buffer.byteLength(line + word) > bytes) return line;
    line += word;
  }
}

function classesOf(command: string): string[] {
  const result = classifyForHook(command, [], PROJECT, [], false, [], false, WRITE_SCOPE_OFF).result;
  return result.ok ? result.classes : [`refused ${result.code}`];
}

function pinned(name: string, command: string, written: number, control: string, smaller: readonly string[] = []): string[] {
  assert.ok(Buffer.byteLength(command) <= 8192 && Buffer.byteLength(command) > 8000);
  const bound = scaledBound(written);
  let classes: string[] = [];
  const seconds = cpuSeconds(() => {
    classes = classesOf(command);
  });
  console.log(`# cost-line: COST695 ${name}: ${seconds.toFixed(2)} CPU s (bound ${bound.toFixed(2)}; node ${process.version}; ${runner().line})`);
  // Measuring only (#720's list, COST695R): after the reading above, three
  // rounds of the same line at an eighth of its bytes and then the line, as
  // #719 reads its lines, the least of each printed. Nothing here is asserted.
  const lines: number[] = [];
  const controls: number[] = [];
  for (let round = 0; round < 3; round += 1) {
    controls.push(cpuSeconds(() => classesOf(control)));
    lines.push(cpuSeconds(() => classesOf(command)));
  }
  const least = Math.min(...lines);
  const leastControl = Math.min(...controls);
  console.log(
    `# cost-measure: COST695R ${name}: first ${seconds.toFixed(2)}, calls ${lines.map((x) => x.toFixed(2)).join(" ")}, least ${least.toFixed(2)} CPU s; ` +
      `an eighth (${String(Buffer.byteLength(control))} bytes) ${controls.map((x) => x.toFixed(3)).join(" ")}, least ${leastControl.toFixed(3)}; ratio ${(least / leastControl).toFixed(2)}; ${runner().line}`,
  );
  // Measuring only (#720's list, step 3): the same line at a sixteenth and a
  // thirty-second of its bytes, three readings each, the least printed: a
  // smaller control parts the fixed line from the walk #695 removed further.
  for (const each of smaller) {
    const readings = [1, 2, 3].map(() => cpuSeconds(() => classesOf(each)));
    const leastEach = Math.min(...readings);
    console.log(`# cost-measure: COST695S ${name}: ${String(Buffer.byteLength(each))} bytes ${readings.map((x) => x.toFixed(3)).join(" ")}, least ${leastEach.toFixed(3)}; ratio of the line's least ${(least / leastEach).toFixed(2)}`);
  }
  assert.ok(seconds < bound, `${name}: ${seconds.toFixed(2)} CPU s, bound ${bound.toFixed(2)} (${runner().line})`);
  return classes;
}

test("cost: `cp notes.txt -t d0 s0/x -t d1 s1/x …` at 8 KB is judged within the bound, and guarded", () => {
  const unit = (i: number): string => ` -t d${String(i)} s${String(i)}/x`;
  const classes = pinned("many_targets_plain", filled("cp notes.txt", unit, 8192), BOUND_PLAIN_S, filled("cp notes.txt", unit, 8192 / 8), [filled("cp notes.txt", unit, 8192 / 16), filled("cp notes.txt", unit, 8192 / 32)]);
  assert.ok(classes.includes("files.write.workspace") && classes.includes(GUARDED), classes.join(","));
});

test("cost: `cp ~/.hermes/.env -t .approval/keys0 s0/env …` at 8 KB is judged within the bound", () => {
  const unit = (i: number): string => ` -t .approval/keys${String(i)} s${String(i)}/env`;
  const classes = pinned("many_targets_credential", filled("cp ~/.hermes/.env", unit, 8192), BOUND_CREDENTIAL_S, filled("cp ~/.hermes/.env", unit, 8192 / 8), [filled("cp ~/.hermes/.env", unit, 8192 / 16), filled("cp ~/.hermes/.env", unit, 8192 / 32)]);
  assert.ok(classes.includes("policy.core") && classes.includes("account.credential") && classes.includes(GUARDED), classes.join(","));
});

test("a few target directories are still judged each with every source; past the cap the segment is guarded", () => {
  // Two `-t`: each source in each directory, the other `-t` value included
  // (`cp -t . -t a .git` lands `./.git`), as before.
  assert.ok(!classesOf("cp -t a -t b notes.txt").includes(GUARDED));
  assert.ok(classesOf("cp -t a -t . .git").includes(GUARDED));
  assert.ok(classesOf("cp -t a -t b .git").includes(GUARDED), "a/.git");
  // A further directory's landing past the first is still read (the guarded
  // name is the last source in the last directory, within the cap).
  assert.ok(classesOf("cp notes.txt -t d0 -t d1 -t d2 -t d3 .claude").includes(GUARDED));
  // Past the cap: guarded, whatever each landing would have been.
  const many = filled("cp notes.txt", (i) => ` -t d${String(i)} s${String(i)}/x`, 1024);
  assert.ok(classesOf(many).includes(GUARDED), many.slice(0, 80));
  const result = classifyForHook(many, [], PROJECT, [], false, [], false, WRITE_SCOPE_OFF);
  assert.ok(result.notes.some((note) => note.includes("target directories, each with every source")), result.notes.join("\n"));
});
