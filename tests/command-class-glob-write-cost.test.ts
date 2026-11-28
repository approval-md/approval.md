/**
 * GLOB-WRITE (#686) cost, three lines with a bound each (lead ruling L62051,
 * review-b A686-FOLD6 S1 and S2). The lead accepted these lines at 2.2 to 4.3
 * times main at 320 KB, under the hook's 60 s, and asked that each be pinned
 * with its own bound: 1.5 times its CPU seconds on CI's runner (the L61975
 * form: a bound set from a measurement, not raised to pass a head).
 *
 * Review-b's shapes, at a size that keeps each run a few CPU seconds:
 * - distinct glob sources: `cp .c0*\/x.json .c1*\/x.json …`;
 * - rsync -aR with many distinct sources: `rsync -aR s0/*\/./a* s1/*\/./a* …`;
 * - rm of dot-names: `rm -rf ./*; ` repeated.
 * Each runs the hook's path: the listing of the directories its patterns glob
 * in, then classifyForHook, in a made-up project. Each logs one line in #694's
 * form (`tests/cost-runner.ts`, `command-class-substitution-cost.test.ts`),
 * `# cost-line: COST686 <name>: <n.nn> CPU s (bound <n.nn>; node <v>)`, so
 * CI's figure can be read again in any run.
 *
 * Since #719 each line is held by a ratio and not by its fixed bound (lead
 * FINDING L66327, as #718 did for hook-glob-cost). The fixed bound judged the
 * first, cold reading in the process, and that reading is not steady: on one
 * runner the same `rm` line read 4.58 CPU s cold and 1.91 on its third round,
 * and across runs of unchanged code it read 2.13 to 6.04 against a bound of
 * 5.79, which turned main red. Now each line is read {@link ROUNDS} times
 * beside a control, the same line at an eighth of its bytes, and the least
 * reading of each is taken: the line may cost at most {@link RATIO_BOUND}
 * times its control, and the control keeps a bound of its own
 * ({@link CONTROL_MOST}), so a change that slows both together still reds.
 * The old fixed bounds are printed beside each line, not asserted.
 *
 * CPU time, not wall-clock time: the machine is shared. Hermetic: HOME and
 * the project are fixture directories holding made-up files; no line is run.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { listGlobWriteDirsFor } from "../src/cli/glob-listing.js";
import { classifyForHook, WRITE_SCOPE_OFF } from "../src/cli/hook.js";
import { cpuSeconds, runner, scaledBound } from "./cost-runner.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-glob-write-cost-")));
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

// The old fixed bounds, printed beside each line and no longer asserted (see
// the header). Each was 1.5 x CI's figure for this line, read from the full gate's node
// 22 job, shard 2 (`# COST686 <name> cpu_s=` before 945bba1c, `# cost-line:
// COST686 <name>:` since), as #694 set "many command words". Lead ruling
// L62051 asked for "1.5 times its CPU seconds on CI's runner": for
// glob_sources and rm_dot_names that is THIS branch's figure (the
// reading the lead confirmed for all three lines in L62116), taken
// at 5cba746b, whose cost on these two lines 945bba1c leaves as it was
// (locally 0.69 and 0.95 CPU s at 5cba746b, 0.65 and 0.94 at 945bba1c).
// Run 45260235850 (#686 at 5cba746b), shard 2: 2.20 CPU s.
const BOUND_GLOB_SOURCES_S = 1.5 * 2.2;
// Run 45260235850 (#686 at 5cba746b), shard 2: 3.86 CPU s.
const BOUND_RM_DOT_NAMES_S = 1.5 * 3.86;
// rsync_relative: lead ruling L62116 (on L62090 and the ask L62115) accepts
// the line at 1.5 x its OWN figure on CI's runner: about 10 x main after the
// repeated walks went (1.5 x main is not reachable without changing what is
// judged; the PR body has the floor table). A regression still reds: the
// repeated walks took about 50 CPU s here.
// Run 45266363135 (#686 at 38d219e5), shard 2: 5.47 CPU s.
const BOUND_RSYNC_RELATIVE_S = 1.5 * 5.47;

/** `head`, then `format(i)` for i = 0, 1, ... while the line stays within `bytes`. */
function distinct(head: string, format: (index: string) => string, bytes: number): string {
  let line = head;
  for (let index = 0; ; index += 1) {
    const word = format(index.toString(16));
    if (Buffer.byteLength(line + word) > bytes) return line;
    line += word;
  }
}

/** The hook's CPU seconds for `command` in the project: its listings, then its classification. */
async function hookSeconds(command: string): Promise<{ seconds: number; classes: string[] }> {
  // The listing is the hook's own disk read, made before it classifies: timed
  // as CPU like the rest, not as the wait for the disk.
  const startListing = process.cpuUsage();
  const listings = await listGlobWriteDirsFor(command, [PROJECT]);
  const listed = process.cpuUsage(startListing);
  let classes: string[] = [];
  const classified = cpuSeconds(() => {
    const result = classifyForHook(command, [], PROJECT, [], false, [], false, WRITE_SCOPE_OFF, listings).result;
    classes = result.ok ? result.classes : [`refused ${result.code}`];
  });
  return { seconds: (listed.user + listed.system) / 1e6 + classified, classes };
}

/** How many times each line and its control are read; the least reading of each is judged. */
const ROUNDS = 3;

/** The control is the same line built to this fraction of the line's bytes. */
const CONTROL_DIVISOR = 8;

/**
 * The most a line may cost of its control. CI's readings (run 46127231866,
 * node 22, rounds two and three, the first being cold): 5.2 to 9.8 for the
 * three lines; a laptop read 8.0 to 10.3. Eight times the bytes at a linear
 * cost is 8; a walk repeated per source, the fault these lines exist to
 * catch, is quadratic and gives 64. The bound is about three times the
 * largest reading and under half of 64.
 */
const RATIO_BOUND = 30;

/**
 * Each control's least reading on CI's node 22 runner (run 46127231866, runner
 * factor 1.03), in CPU seconds. The control's own bound is
 * {@link CONTROL_MOST} times this, stretched by the runner's factor as the
 * other cost files stretch theirs ({@link scaledBound}).
 */
const CONTROL_CI_S: Readonly<Record<string, number>> = {
  glob_sources: 0.063,
  rsync_relative: 0.557,
  rm_dot_names: 0.219,
};

/**
 * The most a control may read of its CI figure, before the runner's factor.
 * Three, where hook-glob-cost has two: unchanged code read these lines, first
 * round, from 2.13 CPU s (node 22) to 6.04 (the node 20 floor on a slower
 * runner), 2.8 times apart, with the runner's factor at 1.13. The least of
 * three rounds is steadier than a first round, but how much steadier on that
 * slower floor runner is not measured yet, so the bound covers the whole span
 * (3 x 1.13 = 3.4). It is no looser than what it replaces: the fixed bounds
 * stood at three to four times these lines' warm cost.
 */
const CONTROL_MOST = 3;

/**
 * One line judged with its control: whether the line is over its ratio, and
 * whether the control is over its own bound (`runnerFactor` is
 * {@link runner}'s, passed in so the rule can be tested with figures).
 */
function judged(lineSeconds: number, controlSeconds: number, ciSeconds: number, runnerFactor: number): { ratio: number; controlBound: number; lineOver: boolean; controlOver: boolean } {
  const ratio = lineSeconds / controlSeconds;
  const controlBound = CONTROL_MOST * ciSeconds * runnerFactor;
  return { ratio, controlBound, lineOver: !(ratio < RATIO_BOUND), controlOver: !(controlSeconds < controlBound) };
}

/**
 * The line `build(bytes)` held by its ratio to `build(bytes / CONTROL_DIVISOR)`.
 * Each round reads the control, then the line; the least of each is judged.
 * `fixed` is the line's old bound: printed, not asserted.
 */
async function held(name: string, build: (bytes: number) => string, bytes: number, fixed: number): Promise<string[]> {
  let line = Number.POSITIVE_INFINITY;
  let control = Number.POSITIVE_INFINITY;
  let classes: string[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    control = Math.min(control, (await hookSeconds(build(Math.floor(bytes / CONTROL_DIVISOR)))).seconds);
    const full = await hookSeconds(build(bytes));
    line = Math.min(line, full.seconds);
    classes = full.classes;
  }
  const { ratio, controlBound, lineOver, controlOver } = judged(line, control, CONTROL_CI_S[name] as number, runner().factor);
  console.log(
    `# cost-line: COST686 ${name}: ${line.toFixed(2)} CPU s (the least of ${String(ROUNDS)}; control ${control.toFixed(3)}, ratio ${ratio.toFixed(2)} of ${String(RATIO_BOUND)}; ` +
      `the control's own bound ${controlBound.toFixed(3)}; the fixed ${fixed.toFixed(2)} is printed, not asserted; ${runner().line})`,
  );
  assert.ok(!lineOver, `${name}: ${line.toFixed(2)} CPU s is ${ratio.toFixed(2)} times its control (${control.toFixed(3)} at an eighth of the bytes), bound ${String(RATIO_BOUND)}; ${runner().line}`);
  assert.ok(
    !controlOver,
    `${name}'s control: ${control.toFixed(3)} CPU s, its own bound ${controlBound.toFixed(3)} (${String(CONTROL_MOST)} times CI's ${String(CONTROL_CI_S[name])}, by the runner's factor); ${runner().line}`,
  );
  return classes;
}

test("cost: each line is held by its ratio to its control, and the control by its own bound (lead FINDING L66327)", () => {
  // `rm_dot_names` as CI read it on its second round (run 46127231866): 2.009 beside 0.219.
  assert.deepEqual(judged(2.009, 0.219, 0.219, 1), { ratio: 2.009 / 0.219, controlBound: CONTROL_MOST * 0.219, lineOver: false, controlOver: false });
  // The cold first reading that turned main red (6.04) beside a warm control still passes: it is the ratio that is judged.
  assert.equal(judged(6.04, 0.351, 0.219, 1).lineOver, false);
  // A walk repeated per source: eight times the bytes at a quadratic cost.
  assert.equal(judged(64 * 0.219, 0.219, 0.219, 1).lineOver, true);
  assert.equal(judged(RATIO_BOUND * 0.219, 0.219, 0.219, 1).lineOver, true);
  // A change that slows the line and its control together: the ratio holds, the control's own bound does not.
  assert.deepEqual(judged(4 * 2.009, 4 * 0.219, 0.219, 1), { ratio: (4 * 2.009) / (4 * 0.219), controlBound: CONTROL_MOST * 0.219, lineOver: false, controlOver: true });
  // A slower runner stretches the control's bound by its factor, and nothing else.
  assert.equal(judged(2.009, 2.5 * 0.219, 0.219, 1).controlOver, false);
  assert.equal(judged(2.009, 3.2 * 0.219, 0.219, 1).controlOver, true);
  assert.equal(judged(2.009, 3.2 * 0.219, 0.219, 1.14).controlOver, false);
  assert.equal(scaledBound(CONTROL_MOST * 0.219), CONTROL_MOST * 0.219 * runner().factor);
  assert.deepEqual(Object.keys(CONTROL_CI_S).sort(), ["glob_sources", "rm_dot_names", "rsync_relative"]);
  assert.equal(RATIO_BOUND, 30);
  assert.equal(CONTROL_MOST, 3);
  assert.equal(CONTROL_DIVISOR, 8);
});

test("cost (L62051): distinct glob sources, `cp .c0*/x.json .c1*/x.json …` at 10 KB", async () => {
  const classes = await held("glob_sources", (bytes) => distinct("cp", (index) => ` .c${index}*/x.json`, bytes), 10_000, BOUND_GLOB_SOURCES_S);
  assert.ok(classes.length > 0);
});

test("cost (L62090): rsync -aR with many distinct sources, `rsync -aR s0/*/./a* …` at 7 KB", async () => {
  // 7 KB, where the cost peaked (lead ruling L62090: "an input near 7 KB").
  // Each source's preserved landing is the last word's `<dest>/a*`: walked
  // again for every source it took about 50 CPU s here; it is judged once now,
  // and the cost grows with the length (no peak) up to the matcher's budget.
  const classes = await held("rsync_relative", (bytes) => distinct("rsync -aR", (index) => ` s${index}/*/./a*`, bytes), 7000, BOUND_RSYNC_RELATIVE_S);
  assert.ok(classes.includes("network.call"), classes.join(","));
});

test("cost (L62051): rm of dot-names, `rm -rf ./*; ` repeated to 10 KB", async () => {
  const classes = await held("rm_dot_names", (bytes) => "rm -rf ./*; ".repeat(Math.floor(bytes / "rm -rf ./*; ".length)), 10_000, BOUND_RM_DOT_NAMES_S);
  // The listing shows `.claude`: the organ directory's class, main's beside it.
  assert.ok(classes.includes("policy.core") && classes.includes("files.delete.out_of_scope"), classes.join(","));
});
