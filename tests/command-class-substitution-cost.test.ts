/**
 * APRV-518, review of the substitution fold, M1: a line built to make the
 * classifier slow. A hook that runs past its timeout lets the call proceed,
 * so the cost of reading a line must stay bounded whatever the line holds.
 *
 * The word matcher tried every window of a word's literal runs, each as an
 * expression of `.*` runs: one word of 130 `$(:)` and a literal took 74 s
 * through the hook. The glob matcher built one anchored expression per
 * pattern: `.`, 400 `*` and `x` took 14 s. A nested substitution was read
 * again at every level. Each is now a walk whose cost is the line's length
 * times a constant, or a bound judged the strict way.
 *
 * CPU time, not wall-clock time: this machine is shared. Each bound is about
 * ten times the slowest figure measured (0.7 s, a word of 10,000 brace
 * groups and outputs), and far under the 60 s a hook is given. Sizes run
 * smallest first, and once one line passes the bound the larger ones fail
 * at once, so a slow build fails in minutes, not after hours.
 * Hermetic: HOME is a fixture directory; git runs only to make a checkout,
 * and no line is run.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { classifyForHook } from "../src/cli/hook.js";
import { classifyCommand, globSegmentMatches } from "../src/core/command-class.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-subst-cost-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

const HOME = join(scratch, "home");
mkdirSync(HOME);
writeFileSync(join(HOME, ".gitconfig"), "[user]\n\tname = Cost Oracle\n\temail = oracle@example.invalid\n[init]\n\tdefaultBranch = main\n");
process.env["HOME"] = HOME;
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
delete process.env["GIT_CONFIG_GLOBAL"];
delete process.env["GIT_DIR"];
delete process.env["GIT_WORK_TREE"];
delete process.env["CDPATH"];

const GIT = spawnSync("git", ["--version"]).status === 0;
const skip = GIT ? false : "no git binary";

/** The most CPU seconds one classification may take here. */
const BOUND = 8;

/** CPU seconds (user and system) spent in `run`. */
function cpuSeconds(run: () => void): number {
  const start = process.cpuUsage();
  run();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1e6;
}

/** Every segment as `class rule`, pure; a refusal as `refused <code>`. */
function pure(command: string): string[] {
  const result = classifyCommand(command, []);
  return result.ok ? result.segments.map((segment) => `${segment.class} ${segment.rule}`) : [`refused ${result.code}`];
}

/**
 * Set once a line has passed {@link BOUND}: the build is slow, that test has
 * failed, and the larger lines after it fail at once rather than being timed
 * for hours.
 */
let overBound: string | null = null;

/** Fail at once when an earlier line already passed the bound. */
function notAlreadyOver(label: string): void {
  assert.equal(overBound, null, `${label}: not timed, an earlier line passed the bound (${String(overBound)})`);
}

/** Fail if `seconds` is over {@link BOUND}, and remember it. */
function withinBound(seconds: number, label: string): void {
  if (seconds >= BOUND) overBound = label;
  assert.ok(seconds < BOUND, `${label}: ${seconds.toFixed(2)} CPU s, bound ${String(BOUND)}`);
}

/** Classify `command` (pure) and fail if it took more than {@link BOUND} CPU seconds. */
function bounded(command: string, label: string): string[] {
  notAlreadyOver(label);
  let answer: string[] = [];
  const seconds = cpuSeconds(() => {
    answer = pure(command);
  });
  withinBound(seconds, label);
  return answer;
}

const DIR_WRITE = "vcs.history.rewrite git-dir-write";
const OUT = "$(:)";
const SIZES = [130, 1000, 10000];

test("cost: one word of n outputs then a literal, the review's shape, is bounded", () => {
  for (const n of SIZES) {
    bounded(`git push --force && echo x > ${OUT.repeat(n)}x`, `outputs then x, n=${String(n)}`);
    bounded(`git push --force && echo x > ${OUT.repeat(n)}.`, `outputs then ., n=${String(n)}`);
    bounded(`git push --force && echo x > x${OUT.repeat(n)}`, `x then outputs, n=${String(n)}`);
  }
});

test("cost: one literal character between the outputs is bounded", () => {
  for (const n of SIZES) {
    bounded(`git push --force && echo x > ${`g${OUT}`.repeat(n)}`, `g between, n=${String(n)}`);
    bounded(`git push --force && echo x > .${`t${OUT}`.repeat(n)}x`, `t between, n=${String(n)}`);
  }
});

test("cost: glob characters between the outputs are bounded", () => {
  for (const n of SIZES) {
    for (const glob of ["*", "?", "[a]", "[", "**"]) {
      bounded(`git push --force && echo x > .${`${glob}${OUT}`.repeat(n)}x`, `${glob} between, n=${String(n)}`);
    }
  }
});

test("cost: braces between the outputs, and a word of many pieces, are bounded", () => {
  for (const n of SIZES) {
    bounded(`git push --force && echo x > x${`{a,b}${OUT}`.repeat(n)}`, `braces, n=${String(n)}`);
    bounded(`git push --force && echo x > .g${`{i,${OUT}}`.repeat(n)}t`, `outputs in braces, n=${String(n)}`);
    bounded(`git push --force && echo x > ${`x${OUT}/`.repeat(n)}f`, `pieces, n=${String(n)}`);
    bounded(`git push --force && echo ${` x${OUT}`.repeat(n)} > f`, `words, n=${String(n)}`);
  }
});

test("cost: the answers of the bounded walk are the old window reading's", () => {
  // `$(pwd)` classifies (a read); `$(:)` is refused, which would hide the answer.
  const READ_OUT = "$(pwd)";
  // Each is timed too, so a slow build fails here at once, not after hours.
  // Spellings across an output's edge still count, however many outputs.
  assert.deepEqual(bounded(`echo x >> ${READ_OUT.repeat(1000)}.g${READ_OUT}it/config`, "answer 1"), [DIR_WRITE]);
  assert.deepEqual(bounded(`echo x >> .g${READ_OUT.repeat(1000)}t/config`, "answer 2"), [DIR_WRITE]);
  assert.deepEqual(bounded(`echo x >> .${"*".repeat(500)}${READ_OUT}t/config`, "answer 3"), [DIR_WRITE]);
  // And ordinary words do not, however many outputs.
  assert.deepEqual(bounded(`echo x > out/${`${READ_OUT}-`.repeat(1000)}.txt`, "answer 4"), ["files.write.workspace redirect-write"]);
});

test("cost: a run of glob characters in a target is bounded", () => {
  // A pattern of a few runs against a long name: the one expression took
  // about a minute here (`*a` six times and `b` against 150 `a`).
  notAlreadyOver("*a runs against a long name");
  const seconds = cpuSeconds(() => {
    assert.equal(globSegmentMatches(`${"*a".repeat(6)}b`, "a".repeat(150)), false);
    assert.equal(globSegmentMatches(`${"*a".repeat(6)}`, "a".repeat(150)), true);
  });
  withinBound(seconds, "*a runs against a long name");
  for (const n of [400, 1000, 1024]) {
    bounded(`git push --force && echo x > .${"*".repeat(n)}x`, `* run, n=${String(n)}`);
    bounded(`git push --force && echo x > .${"*a".repeat(n / 2)}x`, `*a run, n=${String(n)}`);
    bounded(`git push --force && D=.${"*".repeat(n)}x; echo x > $D/f`, `* run in a value, n=${String(n)}`);
    bounded(`git push --force && echo x > "$(echo .${"*".repeat(n)}x)"`, `* run in a body, n=${String(n)}`);
  }
  for (const n of [1000, 10000, 100000]) {
    bounded(`git push --force && echo x > .${"[".repeat(n)}`, `unclosed [ run, n=${String(n)}`);
    bounded(`git push --force && echo x > ${OUT}${"[".repeat(n)}`, `unclosed [ after an output, n=${String(n)}`);
  }
});

test("cost: past 1,024 glob characters one pattern segment is judged to name .git", () => {
  assert.equal(globSegmentMatches(`.${"*".repeat(1024)}x`, ".git"), false);
  assert.equal(globSegmentMatches(`.${"*".repeat(1025)}x`, ".git"), true);
  assert.deepEqual(pure(`echo x > .${"*".repeat(1023)}x`), ["files.write.workspace redirect-write"]);
  assert.deepEqual(pure(`echo x > .${"*".repeat(1025)}x`), [DIR_WRITE]);
  assert.deepEqual(bounded(`echo x > .${"*".repeat(100000)}x`, "100,000 *"), [DIR_WRITE]);
  // Under the bound the walk answers as the expression did.
  assert.equal(globSegmentMatches(`.${"*".repeat(1000)}t`, ".git"), true);
  assert.equal(globSegmentMatches(`.${"?*".repeat(500)}`, ".git"), false);
  assert.equal(globSegmentMatches(".[gG]*[!x]", ".git"), true);
});

test("cost: a word of many nested brace groups is bounded", () => {
  // Finding a group scanned from each `{` to its close: 25,000 nested groups
  // took 8 s through the hook, and the time grows as the square.
  for (const n of [25000, 60000]) {
    bounded(`git push --force && echo x > ${"{a".repeat(n)}${"}".repeat(n)}`, `nested groups, n=${String(n)}`);
    bounded(`git push --force && echo x > ${"${a:-".repeat(n)}x${"}".repeat(n)}`, `nested expansions, n=${String(n)}`);
  }
  // The answers are the scan's: a group with no comma is kept as text.
  assert.deepEqual(pure(`echo x > ${"{a".repeat(1000)}${"}".repeat(1000)}`), ["files.write.workspace redirect-write"]);
  assert.deepEqual(pure("echo x > out/{a,b}.txt"), ["files.write.workspace redirect-write"]);
  assert.deepEqual(pure("echo x > .g{i,}t/config"), [DIR_WRITE]);
});

test("cost: deep nesting is read once, and refused past 128 levels", () => {
  const nest = (n: number): string => `echo x > "${"$(echo ".repeat(n)}x${")".repeat(n)}"`;
  for (const n of [64, 128]) bounded(nest(n), `nesting ${String(n)}`);
  // Read to 64 levels; a deeper body counts as naming .git, the strict side.
  assert.deepEqual(pure(nest(64)), ["files.write.workspace redirect-write"]);
  assert.deepEqual(pure(nest(65)), [DIR_WRITE]);
  // Past 128 levels the line is refused, not run until the call stack ends.
  assert.deepEqual(pure(nest(128)), [DIR_WRITE]);
  assert.deepEqual(pure(nest(129)), ["refused opaque"]);
  for (const n of [1000, 10000]) assert.deepEqual(bounded(nest(n), `nesting ${String(n)}`), ["refused opaque"]);
  // Each level carrying a word of 1,024 brace alternatives: a body the
  // line's reading already went through is not read again by its own
  // classification (13 s at 64 levels when it was).
  const fat = `${"{a,b}".repeat(10)}x`;
  for (const n of [64, 100]) bounded(`echo x > "${`$(echo ${fat} `.repeat(n)}x${")".repeat(n)}"`, `nesting ${String(n)}, wide words`);
});

test("cost: through the hook, in a checkout, the same lines are bounded", { skip }, () => {
  const repo = join(scratch, "repo");
  mkdirSync(repo, { recursive: true });
  const ran = spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8", env: process.env });
  assert.equal(ran.status, 0, ran.stderr);
  // A long name the disk walk matches a pattern of many runs against.
  mkdirSync(join(repo, "a".repeat(150)));
  for (const [label, command] of [
    ["outputs then x", `git push --force && echo x > ${OUT.repeat(10000)}x`],
    ["g between", `git push --force && echo x > ${`g${OUT}`.repeat(10000)}`],
    ["* run", `git push --force && echo x > .${"*".repeat(1000)}x`],
    ["*a run against a long name on disk", `git push --force && echo x > ${"*a".repeat(6)}b/f`],
    ["nesting", `git push --force && echo x > "${"$(echo ".repeat(10000)}x${")".repeat(10000)}"`],
  ] as const) {
    notAlreadyOver(`hook, ${label}`);
    const seconds = cpuSeconds(() => {
      classifyForHook(command, [], repo);
    });
    withinBound(seconds, `hook, ${label}`);
  }
});
