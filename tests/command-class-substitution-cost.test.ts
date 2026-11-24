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
 * groups and outputs), and far under the 60 s a hook is given. The bound is
 * written for one kind of runner and stretched by how slow THIS runner is,
 * measured in this run (`tests/cost-runner.ts`): a slow runner is measured,
 * not guessed, and a failure names the factor it was given. Sizes run
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
import { cpuSeconds, MOST, runner, scaledBound } from "./cost-runner.js";

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

/**
 * The most CPU seconds one classification may take on the runner the bound
 * was set on. Every use goes through {@link scaledBound}, which stretches it
 * by this runner's measured factor.
 */
const BOUND = 8;

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

/**
 * The bound of ONE line, "many command words, n=400000", in CPU seconds, not
 * stretched by the runner's factor (lead, CLAIMS L61975; review of e30fab93).
 *
 * The calibration does not track this line: CI's node 22 runner reads it 4.4
 * to 4.9 times slower than a laptop does, and the calibration only 1.55
 * times, so the factor there is 1.00 while the line sits at the general
 * bound of 8 (8.28 CPU s in run 45219782548, a head whose cost equals
 * main's). So its bound is set from CI's own figure for main: 1.5 times the
 * CPU seconds main's code takes on that runner, measured in this PR's own
 * run (it changes tests only). A head 50% slower than main still fails.
 *
 * The figure: 7.35 CPU s, run 45231949630, the full gate's node 22 job, shard
 * 1 (`# cost-line:` in its log; the calibration took 0.419 CPU s in the same
 * process). One run, one measurement, taken cold as the test takes it. A
 * laptop reads the line in 1.4 to 1.9, so this bound is loose there: it is
 * CI that holds the line to it. The line logs its figure in every run.
 */
const MANY_COMMAND_WORDS_BOUND = 1.5 * 7.35;

/**
 * Fail if `seconds` is over the bound, and remember it. The bound is
 * {@link BOUND} as this runner stretches it, or `own` as written.
 */
function withinBound(seconds: number, label: string, own?: number): void {
  const bound = own ?? scaledBound(BOUND);
  if (seconds >= bound) overBound = label;
  const how = own === undefined ? `${String(BOUND)} x ${runner().line}` : "this line's own bound, set from main's figure on CI and not stretched";
  assert.ok(seconds < bound, `${label}: ${seconds.toFixed(2)} CPU s, bound ${bound.toFixed(2)} (${how})`);
}

/**
 * Classify `command` (pure) and fail if it took more than {@link BOUND} CPU
 * seconds, or more than `own` where the line has a bound of its own. A line
 * with its own bound logs what it took, so the figure the bound came from can
 * be read again in any run.
 */
function bounded(command: string, label: string, own?: number): string[] {
  notAlreadyOver(label);
  let answer: string[] = [];
  const seconds = cpuSeconds(() => {
    answer = pure(command);
  });
  if (own !== undefined) console.log(`# cost-line: ${label}: ${seconds.toFixed(2)} CPU s (bound ${own.toFixed(2)}; node ${process.version})`);
  withinBound(seconds, label, own);
  return answer;
}

test("cost: this runner is measured before any bound is used, and the measurement is logged", (t) => {
  const { seconds, factor, line } = runner();
  // In the log of every run, so a red on a bound can be read against it.
  t.diagnostic(line);
  console.log(`# cost: ${line}`);
  assert.ok(seconds > 0);
  assert.ok(factor >= 1 && factor <= MOST, line);
  assert.equal(scaledBound(BOUND), BOUND * factor);
});

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
  // Lead ruling L62568: past eight unread parts a word could be any path, so
  // the spliced reading's strictest class rides beside the `.git` write.
  assert.deepEqual(bounded(`echo x >> ${READ_OUT.repeat(1000)}.g${READ_OUT}it/config`, "answer 1"), ["log.mutate redirect-protected", DIR_WRITE]);
  assert.deepEqual(bounded(`echo x >> .g${READ_OUT.repeat(1000)}t/config`, "answer 2"), ["log.mutate redirect-protected", DIR_WRITE]);
  // GLOB-WRITE (22 Nov 2026): an output beside a glob construct may hold a `/`
  // and name any directory, the approval log's among them.
  assert.deepEqual(bounded(`echo x >> .${"*".repeat(500)}${READ_OUT}t/config`, "answer 3"), ["log.mutate redirect-protected", "vcs.history.rewrite git-dir-write"]);
  // And ordinary words do not, however many outputs, up to the spliced
  // reading's bound (lead ruling L62568: past eight unread parts a word could
  // be any path, and asks with the strictest class; main's answer beside).
  assert.deepEqual(bounded(`echo x > out/${`${READ_OUT}-`.repeat(8)}.txt`, "answer 4"), ["files.write.workspace redirect-write"]);
  assert.deepEqual(bounded(`echo x > out/${`${READ_OUT}-`.repeat(1000)}.txt`, "answer 4, past the bound"), ["log.mutate redirect-protected", "files.write.workspace redirect-write"]);
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
  // The words end in `y`: `.*x` also matches `.codex`, a policy.core organ, and
  // a glob in a write target is judged by every guarded name it could match
  // (GLOB-WRITE, 22 Nov 2026), which would answer before the `.git` reader.
  assert.deepEqual(pure(`echo x > .${"*".repeat(1023)}y`), ["files.write.workspace redirect-write"]);
  assert.deepEqual(pure(`echo x > .${"*".repeat(1025)}y`), [DIR_WRITE]);
  assert.deepEqual(bounded(`echo x > .${"*".repeat(100000)}y`, "100,000 *"), [DIR_WRITE]);
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
  // `cat`, whose output the reader does not render: zsh's echo of an unknown
  // word counts at the first level (the sixth security review of #680's gate).
  const nest = (n: number): string => `echo x > "${"$(cat ".repeat(n)}x${")".repeat(n)}"`;
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

test("cost: review-b's shapes on b085cd91 (nested defaults, printf and echo bodies) are bounded", () => {
  const P = "git push --force && ";
  // Each took 64 to 174 CPU s through the hook on b085cd91; main took under 0.6.
  for (const n of [2000, 20000]) {
    bounded(`${P}echo x > ${"${a:-y$(pwd)".repeat(n)}x${"}".repeat(n)}`, `nested defaults with outputs, n=${String(n)}`);
  }
  for (const n of [25000, 250000]) {
    bounded(`${P}echo x > "$(printf %${"0".repeat(n)})"`, `printf % then zeros, n=${String(n)}`);
    bounded(`${P}echo x > "$(printf %.${"1".repeat(n)})"`, `printf %. then digits, n=${String(n)}`);
    bounded(`${P}echo x > "$(echo '${"${".repeat(n)}')"`, `echo of unclosed \${, n=${String(n)}`);
    bounded(`${P}echo x > "$(printf %s '${"${".repeat(n)}')"`, `printf %s of unclosed \${, n=${String(n)}`);
  }
  // codex on ef0531c0: a long spec and many words, the format read once per word.
  for (const n of [20000, 200000]) {
    bounded(`${P}echo x > "$(printf '%${"0".repeat(n)}.0s'${" a".repeat(n)})"`, `printf %0..0.0s of many words, n=${String(n)}`);
  }
  for (const n of [40000, 400000]) {
    bounded(`${P}echo x > "$(printf '%.0s'${" a".repeat(n)})"`, `printf %.0s of many words, n=${String(n)}`);
    bounded(`${P}echo x > "$(printf '%s'${" a".repeat(n)})"`, `printf %s of many words, n=${String(n)}`);
    bounded(`${P}echo x > "$(echo${" -n".repeat(n)} a)"`, `echo of many flags, n=${String(n)}`);
    bounded(`${P}echo x > "$(${"command ".repeat(n)}printf a)"`, `many command words, n=${String(n)}`, n === 400000 ? MANY_COMMAND_WORDS_BOUND : undefined);
  }
});

/**
 * Classify `line` and a control of the same length that skips the reader
 * under test, and fail if the line costs more than CONTROL_FACTOR times the
 * control plus a second. Main's own passes over a long brace word cost
 * seconds at 1 MB, about four times more on a CI runner than here, so a fixed
 * bound cannot tell this code's cost from main's; the control can.
 */
const CONTROL_FACTOR = 8;
function nearControl(line: string, control: string, label: string): void {
  notAlreadyOver(label);
  const base = cpuSeconds(() => {
    pure(control);
  });
  const seconds = cpuSeconds(() => {
    pure(line);
  });
  const ok = seconds < CONTROL_FACTOR * base + scaledBound(1);
  if (!ok) overBound = label;
  assert.ok(ok, `${label}: ${seconds.toFixed(2)} CPU s, the control ${base.toFixed(2)}, factor ${String(CONTROL_FACTOR)}`);
}

test("cost: review-b's M2 on 2f4100fc, brace groups beside outputs to 1 MB, is bounded", () => {
  const P = "git push --force && ";
  const unit = "{a,b}$(pwd)";
  // The control: each output spelled as text of the same length, so no word
  // holds an output; for brace groups alone, the same groups outside the
  // default word, so main's own brace pass still runs on them.
  const noOutputs = (line: string): string => line.replaceAll("$(pwd)", "pwdpwd");
  // 39 CPU s through the hook at 1 MB on 2f4100fc (main 4.4); at 2 MB node
  // died. Here about 1 to 4 times the control; with the bound at 1,024, 15 to 34.
  bounded(`${P}echo x > ${unit.repeat(9000)}`, "brace groups and outputs, one word, 100 KB");
  const n = 90000;
  const word = `${P}echo x > ${unit.repeat(n)}`;
  nearControl(word, noOutputs(word), "brace groups and outputs, one word, 1 MB");
  // A default word's control is a literal wrapper of the same length, so it
  // skips the default-word reader as well as the outputs (codex on 03eaaae6).
  const literalWrap = (body: string): string => `${P}echo x > zzzzz${noOutputs(body)}z`;
  const inDefault = `${P}echo x > \${a:-${unit.repeat(n)}}`;
  nearControl(inDefault, literalWrap(unit.repeat(n)), "the same in a default word, 1 MB");
  const groups = `${P}echo x > \${a:-${"{a,b}".repeat(200000)}}`;
  nearControl(groups, `${P}echo x > zzzzz${"{a,b}".repeat(200000)}z`, "brace groups in a default word, 1 MB");
  // codex on 1d42d749: groups of one alternative add steps but no words
  // (96 CPU s at 220 KB before the step bound; main 2.5).
  bounded(`${P}echo x > ${"{a..a}$(pwd)".repeat(2000)}`, "one-alternative ranges beside outputs, n=2000");
  const ranges = `${P}echo x > ${"{a..a}$(pwd)".repeat(20000)}`;
  nearControl(ranges, noOutputs(ranges), "one-alternative ranges beside outputs, n=20000");
  const rangesInDefault = `${P}echo x > \${a:-${"{1..1}$(pwd)".repeat(10000)}}`;
  nearControl(rangesInDefault, literalWrap("{1..1}$(pwd)".repeat(10000)), "the same in a default word, n=10000");
  // review-b's M3 on 689d4f88: a printed glob was read by the unbounded
  // reader. Spelled with escapes, so main's own body check skips it: 0.11 CPU s
  // at 20,000 groups, 19 unbounded.
  for (const n of [5000, 20000]) {
    bounded(`${P}echo x > "$(printf '${"\\x7ba..a\\x7d".repeat(n)}*')"`, `a printed glob of one-alternative groups, n=${String(n)}`);
  }
  // (Build-6 round two, L62568: the output may hold a `/`, so the word may
  // also be `.g…/hooks/…t/config`; that class rides beside the `.git` one.)
  assert.deepEqual(pure("echo x >> .g{i..i}$(pwd)t/config"), ["policy.core redirect-protected", DIR_WRITE]);
  // The step bound: 63 groups of one alternative finish, 64 count; in a word
  // an outputs' join reads, and in a word a default rewrites (bash 3.2 reads
  // `${a:-out}/{a..a}{a..a}.log` as `out/aa.log`).
  assert.deepEqual(pure(`echo x > \${a:-out}/${"{a..a}".repeat(63)}.log`), ["files.write.workspace redirect-write"]);
  assert.deepEqual(pure(`echo x > \${a:-out}/${"{a..a}".repeat(64)}.log`), [DIR_WRITE]);
  assert.deepEqual(pure(`echo x > out/${"{a..a}".repeat(63)}$(pwd).log`), ["files.write.workspace redirect-write"]);
  assert.deepEqual(pure(`echo x > out/${"{a..a}".repeat(64)}$(pwd).log`), [DIR_WRITE]);
  // Under the bound the expansion answers as before; past 16 alternatives, the strict side.
  assert.deepEqual(pure("echo x >> .g{i,}$(pwd)t/config"), ["policy.core redirect-protected", DIR_WRITE]);
  assert.deepEqual(pure(`echo x > out/${"{a,b}".repeat(4)}$(pwd).log`), ["files.write.workspace redirect-write"]);
  assert.deepEqual(pure(`echo x > out/${"{a,b}".repeat(5)}$(pwd).log`), [DIR_WRITE]);
});

test("cost: the bounded readers answer as before under their bounds", () => {
  // Read to 32 levels of `${`; a deeper word counts as naming .git.
  const nest = (n: number, inner: string): string => `echo x > ${"${a:-".repeat(n)}${inner}${"}".repeat(n)}/f`;
  assert.deepEqual(pure(nest(32, "out")), ["files.write.workspace redirect-write"]);
  assert.deepEqual(pure(nest(32, ".git")), [DIR_WRITE]);
  // Past the depth the GLOB-WRITE reading of a write target's `${…}` defaults
  // (22 Nov 2026) fails closed too, to the stricter `log.mutate`.
  assert.deepEqual(pure(nest(33, "out")), ["log.mutate redirect-protected", "vcs.history.rewrite git-dir-write"]);
  // An unclosed `${` set aside is put back as text: what it prints still counts.
  // (Build-6 round two, L62542: printf's word is read as a file it may name,
  // as main reads `printf %s .approval/env`, and its `$` as unread parts, so
  // `a${${${ .git` may be `a…/.approval/env`: a substitution that reads a
  // credential is refused, which is stricter than the `.git` reading.)
  assert.deepEqual(pure(`echo x > "$(printf '%s' 'a${"${".repeat(3)} .git')"`), ["refused opaque"]);
  assert.deepEqual(pure(`echo x > "$(printf '%s' 'a\${b} c')"`), ["files.write.workspace redirect-write"]);
  // A 0 after the % is a flag, a width after it pads: neither prints .git.
  assert.deepEqual(pure(`echo x > "$(printf '%05s' a)"`), ["files.write.workspace redirect-write"]);
  assert.deepEqual(pure(`echo x > "$(printf '%05.4s' .gitfoo)/config"`), [DIR_WRITE]);
  // echo's flags are read by index and still decode.
  assert.deepEqual(pure(`echo x > "$(echo -n -e '\\x2egit')/config"`), [DIR_WRITE]);
  assert.deepEqual(pure(`echo x > "$(echo -n -e 'out')/config"`), ["files.write.workspace redirect-write"]);
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
    ["nested defaults with outputs", `git push --force && echo x > ${"${a:-y$(pwd)".repeat(20000)}x${"}".repeat(20000)}`],
    ["printf % then zeros", `git push --force && echo x > "$(printf %${"0".repeat(250000)})"`],
    ["echo of unclosed ${", `git push --force && echo x > "$(echo '${"${".repeat(250000)}')"`],
    // 1,000 groups: past about 3,000 the hook's own credential pass (main's
    // globRegex) throws building its expression, before this reader is timed.
    ["a printed glob of one-alternative groups", `git push --force && echo x > "$(printf '${"\\x7ba..a\\x7d".repeat(1000)}*')"`],
    ["one-alternative ranges beside outputs", `git push --force && echo x > ${"{a..a}$(pwd)".repeat(2000)}`],
    ["brace groups and outputs, 100 KB", `git push --force && echo x > ${"{a,b}$(pwd)".repeat(9000)}`],
    ["printf %0..0.0s of many words",`git push --force && echo x > "$(printf '%${"0".repeat(20000)}.0s'${" a".repeat(20000)})"`],
  ] as const) {
    notAlreadyOver(`hook, ${label}`);
    const seconds = cpuSeconds(() => {
      classifyForHook(command, [], repo);
    });
    withinBound(seconds, `hook, ${label}`);
  }
});

test("cost: the gate follow-up's readers (zsh forms, printf modifiers and words) are bounded", () => {
  const P = "git push --force && ";
  // Each is a walk of the line: under 0.2 CPU s at the largest size here.
  for (const n of [2000, 20000]) {
    bounded(`${P}f=x; echo x > "${"$f:z".repeat(n)}"`, `unbraced zsh forms that are no modifier, n=${String(n)}`);
    bounded(`${P}echo x > "${"$OUT[@]".repeat(n)}"`, `unbraced whole-array forms, n=${String(n)}`);
    bounded(`${P}echo x > "${"${a[@]}".repeat(n)}"`, `braced whole-array forms, n=${String(n)}`);
    bounded(`${P}echo x > "$(printf %.4s${" \"$V\"".repeat(n)})"`, `a cut of many quoted words, n=${String(n)}`);
    bounded(`${P}echo x > "$(printf %s${" $V".repeat(n)})"`, `many words that may split, n=${String(n)}`);
    bounded(`${P}echo x > "$(printf %.4${"l".repeat(n * 10)}s .gitfoo)"`, `a run of length modifiers, n=${String(n)}`);
    bounded(`${P}echo x > "$(printf %${"0".repeat(n * 10)}${"l".repeat(n * 10)}.)"`, `zeros then length modifiers and no conversion, n=${String(n)}`);
    // Codex's SOURCE HOLD on 101630f2: four readings of path-named printers,
    // a stray `%` beside many `%%`, and many `\c`.
    bounded(`${P}echo x > "$(${"/usr/bin/printf x; ".repeat(n)}printf it)"`, `many printers named by path, n=${String(n)}`);
    bounded(`${P}echo x > "$(printf '${"%%".repeat(n * 10)}%')"`, `many %% then a stray %, n=${String(n)}`);
    bounded(`${P}echo x > "$(printf %b${" '\\cX'".repeat(n)})"`, `many words with \\c, n=${String(n)}`);
    // review-b's read of #683: many `printf -v` segments, and printers by other paths.
    bounded(`${P}${"printf -v d %s x; ".repeat(n)}echo x > "$d"`, `many printf -v segments, n=${String(n)}`);
    bounded(`${P}echo x > "$(${"/usr/bin//printf x; ".repeat(n)}printf it)"`, `many printers by other paths, n=${String(n)}`);
  }
  assert.deepEqual(pure(`echo x > "$(printf %.4${"l".repeat(1000)}s .gitfoo)/config"`), [DIR_WRITE]);
});
