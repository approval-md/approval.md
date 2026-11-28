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
 * made-up project and logs `# cost-line: COST695 <name>: ...`. Since #720 each
 * line is held by the RATIO rule ({@link RULES}), not by its fixed bound (about
 * three times a laptop's figure, stretched by the runner's factor), which is
 * printed: one cold call read 2.95 of 6 and 0.82 of 2.5 CPU s on CI with the
 * code unchanged. The plain line's figure is mostly the classifier's
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
import { cpuSeconds, heldLine, ratioJudged, type RatioRule, scaledBound } from "./cost-runner.js";

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

/**
 * The control is the same line built to this fraction of the line's bytes
 * (the seat's ruling on #720's list: the largest fraction for which both
 * conditions of the RATIO rule hold on CI's figures). At an eighth, CI read the
 * plain line at up to 12.7 times its control, so R would be 38, and main
 * 606df106's walk (the landings #695 removed) reads 39.8 there on a laptop:
 * not under half. At a sixteenth: 24.1 on CI, R 73, the walk 119 (half
 * 59.5): not either. At a thirty-second: 41.1 and 20.4 on CI (plain,
 * credential), R 124 and 62, the walk 333 and 315.6 (halves 166 and 158).
 */
const CONTROL_DIVISOR = 32;

/** How many times each line and its control are read; the least reading of each is judged. */
const ROUNDS = 3;

/**
 * Each line's RATIO rule (#720's list), CPU s: the most it may cost of its
 * control, its control's figure on CI, and the most the control may read of
 * it before the runner's factor. R is three times the largest ratio CI read
 * at a thirty-second (41.07 and 20.42, run 46145131980 attempt 1, node 22;
 * attempt 2 read 29.28 and 19.19); each control figure is its largest least
 * reading in attempts 1 and 2 (0.049 and 0.018, both attempt 2).
 */
const RULES: Readonly<Record<string, RatioRule>> = {
  many_targets_plain: { ratioBound: 124, controlCi: 0.049, most: 3 },
  many_targets_credential: { ratioBound: 62, controlCi: 0.018, most: 3 },
};

/**
 * The line `build(8192)` held by its ratio to `build(8192 / CONTROL_DIVISOR)`
 * (#720's list, as #719 holds COST686). Each round reads the control, then
 * the line; the least of each is judged. `written` is the line's old fixed
 * bound: printed, stretched as it was, and not asserted. The classifier
 * keeps no answer keyed on these words between calls (no glob, no `$`, and
 * the hook's disk memo lives for one call), so each round reads the same line.
 */
function pinned(name: string, build: (bytes: number) => string, written: number): string[] {
  const command = build(8192);
  const control = build(8192 / CONTROL_DIVISOR);
  assert.ok(Buffer.byteLength(command) <= 8192 && Buffer.byteLength(command) > 8000);
  let classes: string[] = [];
  const lines: number[] = [];
  const controls: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    controls.push(cpuSeconds(() => classesOf(control)));
    lines.push(
      cpuSeconds(() => {
        classes = classesOf(command);
      }),
    );
  }
  const least = Math.min(...lines);
  const leastControl = Math.min(...controls);
  const reading = { calls: lines, controls, least, leastControl, ratio: least / Math.max(leastControl, 1e-6) };
  const { text, over } = heldLine("COST695", name, reading, RULES[name]!, `${scaledBound(written).toFixed(2)} CPU s`);
  console.log(`${text.slice(0, -1)}; control at a ${String(CONTROL_DIVISOR)}th of the bytes, ${String(Buffer.byteLength(control))}; node ${process.version})`);
  assert.deepEqual(over, [], `${name}: ${over.join("; ")}`);
  return classes;
}

test("cost: each COST695 line's rule is set, and the control's bound follows the runner (#720's list)", () => {
  assert.deepEqual(Object.keys(RULES).sort(), ["many_targets_credential", "many_targets_plain"]);
  for (const rule of Object.values(RULES)) {
    assert.ok(rule.ratioBound > 0 && rule.controlCi > 0);
    assert.equal(rule.most, 3);
    // A line at its ratio bound reds; a control at `most` times its figure reds, unless the runner is slower.
    assert.equal(ratioJudged(rule.ratioBound, rule.controlCi, rule, 1).lineOver, true);
    assert.equal(ratioJudged(1, 3 * rule.controlCi, rule, 1).controlOver, true);
    assert.equal(ratioJudged(1, 3 * rule.controlCi, rule, 1.2).controlOver, false);
  }
});

test("cost: `cp notes.txt -t d0 s0/x -t d1 s1/x …` at 8 KB is judged within the bound, and guarded", () => {
  const classes = pinned("many_targets_plain", (bytes) => filled("cp notes.txt", (i) => ` -t d${String(i)} s${String(i)}/x`, bytes), BOUND_PLAIN_S);
  assert.ok(classes.includes("files.write.workspace") && classes.includes(GUARDED), classes.join(","));
});

test("cost: `cp ~/.hermes/.env -t .approval/keys0 s0/env …` at 8 KB is judged within the bound", () => {
  const classes = pinned("many_targets_credential", (bytes) => filled("cp ~/.hermes/.env", (i) => ` -t .approval/keys${String(i)} s${String(i)}/env`, bytes), BOUND_CREDENTIAL_S);
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
