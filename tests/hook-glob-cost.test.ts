/**
 * The hook's passes over a glob of many `*` are bounded in CPU time
 * (B-HOOK-GLOB-LINEAR).
 *
 * `globRegex` compiled each glob component to an anchored regular expression,
 * and a run of `*` made the engine backtrack, at a cost that grows with
 * (stars + name length) choose (name length) for every name tested: `cat`
 * with 240 `*` and 12 `z` ran the credential pass past Claude Code's 60 s
 * hook timeout, and a hook stopped by its timeout lets the call through. This
 * file imports hook.ts alone, so it runs unchanged against the old matcher.
 *
 * Every credential file here is synthetic, in a scratch directory, and HOME
 * points into that directory.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";

import { classifyForHook, credentialReadLandings } from "../src/cli/hook.js";
import { runner, scaledBound } from "./cost-runner.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-glob-cost-")));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** CPU milliseconds (user and system) spent in `run`: a shared runner's wall clock is no bound. */
function cpuMs(run: () => void): number {
  const start = process.cpuUsage();
  run();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

/**
 * A line and its control run back to back, the order turning each round (as
 * #707's walked-once cases in guarded-names-fold-case and #709's spliced
 * words time theirs): the medians of the line's calls, of the control's and of
 * the pairs' ratios, in CPU ms. Once each first, untimed: the first call pays
 * for the compiler. A control of about 1 CPU ms is read as the mean of
 * `controlCalls` calls made back to back, so the pair's ratio is not one short
 * call's jitter.
 */
function pairedCost(controlRun: () => void, spentRun: () => void, rounds: number, controlCalls = 1): { spent: number; control: number; ratio: number } {
  controlRun();
  spentRun();
  const controlOnce = (): void => {
    for (let call = 0; call < controlCalls; call += 1) controlRun();
  };
  const spents: number[] = [];
  const controls: number[] = [];
  const ratios: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    let control: number;
    let spent: number;
    if (round % 2 === 0) {
      control = cpuMs(controlOnce) / controlCalls;
      spent = cpuMs(spentRun);
    } else {
      spent = cpuMs(spentRun);
      control = cpuMs(controlOnce) / controlCalls;
    }
    spents.push(spent);
    controls.push(control);
    ratios.push(spent / Math.max(control, 0.001));
  }
  const median = (values: number[]): number => {
    values.sort((left, right) => left - right);
    const middle = values.length >> 1;
    return values.length % 2 === 1 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
  };
  return { spent: median(spents), control: median(controls), ratio: median(ratios) };
}

/**
 * A line and its control read `rounds` times, the control first each round
 * (as #719's `held` reads its lines), and the least reading of each, in CPU
 * ms: the least of several calls is what the code costs, where one call also
 * holds the first call's compile and the runner's phase (#720's list).
 */
function leastCost(controlRun: () => void, spentRun: () => void, rounds: number): { spent: number; control: number; ratio: number; spents: number[]; controls: number[] } {
  const spents: number[] = [];
  const controls: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    controls.push(cpuMs(controlRun));
    spents.push(cpuMs(spentRun));
  }
  const spent = Math.min(...spents);
  const control = Math.min(...controls);
  return { spent, control, ratio: spent / Math.max(control, 0.001), spents, controls };
}

/** How many times {@link leastCost} reads each line and its control. */
const LEAST_ROUNDS = 5;

/**
 * Print one case's CPU time against its bound, pass or fail, so a green run's
 * log shows the margin (as #707's ratio cases print theirs).
 */
function report(t: TestContext, name: string, ms: number, bound: number): void {
  t.diagnostic(`cost: ${name}: ${ms.toFixed(1)} CPU ms of ${bound.toFixed(1)}`);
}

/** A directory an agent might sit in: names as long as `auth.json`, and a synthetic gate home. */
function workspace(): { dir: string; home: string } {
  const dir = join(scratch, "ws");
  const home = join(scratch, "home");
  mkdirSync(join(dir, ".approval"), { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const name of [".env", ".env.local", "auth.json", "keys", "env", "README.md", "package-lock.json"]) {
    writeFileSync(join(dir, name), "x\n", "utf8");
  }
  writeFileSync(join(dir, ".approval", "env"), "SYNTHETIC=1\n", "utf8");
  mkdirSync(join(home, ".hermes", "plugins"), { recursive: true });
  for (const name of ["auth.json", "config.yaml", "shell-hooks-allowlist.json.lock"]) {
    writeFileSync(join(home, ".hermes", name), "x\n", "utf8");
  }
  return { dir, home };
}

// The first case is small so that the old matcher fails the bound in about a
// second rather than running for hours: the old cost per name was (stars +
// name length) choose (name length), so on a521a91d 12 `*` took 0.95 CPU s
// against `package-lock.json` alone, 40 took 31 CPU s in the credential pass
// from a directory holding `auth.json`, and from one holding only `env` and
// `keys` 160 took 4.9 CPU s and 240 took 35.7 CPU s.
const STAR_COUNTS = [12, 160, 240, 2000];

/** Test 2's six lines, by name: each takes the word of `*` (the line) or of plain `a` (its control). */
const STAR_SHAPES: ReadonlyArray<readonly [string, (word: string) => string]> = [
  ["cat", (word) => `cat ${word}`],
  ["cat ~/.hermes/", (word) => `cat ~/.hermes/${word}`],
  ["echo x > ~/.hermes/", (word) => `echo x > ~/.hermes/${word}`],
  ["echo x >", (word) => `echo x > ${word}`],
  ["cat */…/x", (word) => `cat */${word}/x`],
  ["echo x > ~/.hermes/*/", (word) => `echo x > ~/.hermes/*/${word}`],
];

/** Test 3's two long words, by name. */
const LONG_WORDS: ReadonlyArray<readonly [string, string]> = [
  ["20,000 [", "[".repeat(20_000)],
  ["*[5,000 z]X", `*[${"z".repeat(5_000)}]X`],
];

/**
 * The bound: 50 CPU ms for one word through the credential pass, 100 through
 * the whole classification. Measured at 0.4 to 4.7 CPU ms a word here (the
 * 2000-star word and the first, unwarmed call included), so each bound has a
 * margin of 10x or more for a slow runner and stays 600x under the hook's
 * 60 s timeout.
 */
const BOUND_MS = 50;

/**
 * The most the 2,000-character `[` lines may cost over their control, the
 * median of the pairs' ratios (test 3, {@link pairedCost}). Measured on a
 * laptop at 168a73c1, 5 runs on node 26 and 5 on node 20: 11.0 to 16.2 (both
 * lines); with the write pass run twice (the hand-back's mutant, 3 runs each)
 * 20.3 to 23.5.
 */
const RUN_RATIO_BOUND = 18;

test("cost: the credential pass over a long `*` run is bounded in CPU time", (t) => {
  const { dir, home } = workspace();
  const env = { HOME: home };
  for (const stars of STAR_COUNTS) {
    const word = `${"*".repeat(stars)}${"z".repeat(12)}`;
    let found: Array<{ segment: string; path: string }> = [];
    const ms = cpuMs(() => {
      found = credentialReadLandings(`cat ${word}`, dir, env);
    });
    assert.deepEqual(found, [], `${String(stars)} stars`);
    report(t, `cat with ${String(stars)} '*' and 12 'z' (credential pass)`, ms, BOUND_MS);
    assert.ok(ms < BOUND_MS, `cat with ${String(stars)} '*' and 12 'z': ${ms.toFixed(1)} CPU ms, bound ${String(BOUND_MS)}`);

    // The same run that does name a credential is still found at that scale.
    let named: Array<{ segment: string; path: string }> = [];
    const namedMs = cpuMs(() => {
      named = credentialReadLandings(`cat .approval/${"*".repeat(stars)}env`, dir, env);
    });
    assert.ok(
      named.some((entry) => entry.path === join(dir, ".approval", "env")),
      `${String(stars)} stars before env: ${JSON.stringify(named)}`,
    );
    report(t, `cat .approval/ with ${String(stars)} '*' before env (credential pass)`, namedMs, BOUND_MS);
    assert.ok(namedMs < BOUND_MS, `${String(stars)} stars before env: ${namedMs.toFixed(1)} CPU ms, bound ${String(BOUND_MS)}`);
  }
});

test("cost: the whole hook classification of a long `*` run is bounded in CPU time", (t) => {
  const { dir, home } = workspace();
  // classifyForHook reads HOME from the process: point it at the scratch home
  // for the call, so `~/.hermes/` lists synthetic names only.
  const savedHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    // 8 first: the `.git` reader of a write (`echo x > ~/.hermes/...`) took
    // 36.7 CPU s at 8 `*` on a521a91d.
    //
    // Each line is held by the RATIO rule ({@link STAR_RATIO_BOUND}), not by
    // the fixed 100 CPU ms of one call, which is printed beside it: CI read
    // these lines at up to 75.8 CPU ms of 100 with the code unchanged (#720's
    // list). The control is the same line with the run of `*` spelled as plain
    // `a`, which no reader backtracks on.
    const over: string[] = [];
    for (const stars of [8, ...STAR_COUNTS]) {
      const word = `${"*".repeat(stars)}${"z".repeat(12)}`;
      const plainWord = `${"a".repeat(stars)}${"z".repeat(12)}`;
      for (const [name, shape] of STAR_SHAPES) {
        const command = shape(word);
        const control = shape(plainWord);
        const { spent, control: controlMs, ratio } = leastCost(
          () => classifyForHook(control, [], dir, [], false, [dir]),
          () => classifyForHook(command, [], dir, [], false, [dir]),
          LEAST_ROUNDS,
        );
        const ciMs = STAR_CONTROL_CI_MS[name]!;
        const { controlBound, lineOver, controlOver } = heldBy(ratio, controlMs, ciMs, runner().factor, STAR_RATIO_BOUND, LEAST_CONTROL_MOST);
        const label = `${command.slice(0, 30)} (${String(stars)} stars): least ${spent.toFixed(1)} CPU ms, control ${controlMs.toFixed(1)}, ratio ${ratio.toFixed(2)} of ${String(STAR_RATIO_BOUND)}; the control's own bound ${controlBound.toFixed(1)}; the fixed ${String(BOUND_MS * 2)} ms is printed, not asserted`;
        t.diagnostic(`cost: ${label}`);
        if (lineOver) over.push(label);
        if (controlOver) over.push(`the control of ${label} (${String(LEAST_CONTROL_MOST)} x its CI ${ciMs.toFixed(1)}, ${runner().line})`);
      }
    }
    assert.deepEqual(over, [], `over the bound:\n${over.join("\n")}`);
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
  }
});

test("cost: a run of unclosed `[` and a class of many members, through the whole classification (codex on #682)", (t) => {
  const { dir, home } = workspace();
  // Two hundred names of 250 characters, beside the workspace's own, in the
  // directory and in the home: what a class is tested against, character by
  // character.
  for (let index = 0; index < 200; index += 1) {
    const name = `${String(index).padStart(3, "0")}${"a".repeat(247)}`;
    writeFileSync(join(dir, name), "x\n", "utf8");
    writeFileSync(join(home, ".hermes", name), "x\n", "utf8");
  }
  const savedHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    // On bfa73710: `echo x >` and 20,000 `[` took 2.8 CPU s (the `.git`
    // reader scanned from every `[` to the end; #680 now reads the run once),
    // and `cat` of `*[` + 5,000 `z` + `]X` took 160 CPU ms (each character
    // tested against every member, in this change's hook reader). At most about 14 CPU ms a call here, so the bound is 7x.
    // (50,000 members took 985 CPU ms through `cat` on bfa73710 and 31 here;
    // tests/hook-glob-match bounds that size directly.)
    // The 2,000-character run past the 1,024 bound matches every entry, so the
    // line writes all 207 out as one synthetic line and lands each: the cost
    // that read 131.4 CPU ms of 100 once on the merge queue (node 22, #682) and
    // 74.8 for the `~/.hermes/` line (draft #712). One call is not a reading:
    // on node 20 whichever call first makes a function hot pays for its
    // compile on a second thread (write-scope's guardedEntryOf, about 10 CPU ms
    // here, in the `~/.hermes/` call), and process.cpuUsage counts it. So each
    // is timed as #707's walked-once cases and #709's spliced words are: back
    // to back with a control, the order turning, 21 pairs ({@link pairedCost}).
    // The median call keeps the 100 ms bound, and the median ratio to the
    // control is bounded. The control is the same line with the run replaced
    // by a plain name of the same length: the same lexing and the same
    // per-character passes over a 2,000-character word, one landing, and no
    // match, so the ratio is what matching every entry costs (the listing, the
    // synthetic line, the landings) over what the word alone costs. Both lines
    // take the workspace's control: under `~/.hermes/` the control's own `~`
    // is resolved and judged as a synthetic line of its own in the write pass,
    // so a write pass that cost twice as much would cost the control twice as
    // much too, and the ratio would hide most of it (with the write pass run
    // twice, the ratio to its own control went from 9.2-11.2 to 13.2-16.0, and
    // to the workspace's from 11.5-13.6 to 16.7-23.8, one control call a
    // pair). The prefix costs the control about 0.3 CPU ms. The control is
    // read as the mean of 5 calls a pair. Measured: see {@link RUN_RATIO_BOUND}.
    for (const prefix of ["", "~/.hermes/"]) {
      const most = RUN_RATIO_BOUND;
      const command = `echo x > ${prefix}${"[".repeat(2_000)}`;
      const control = `echo x > ${"a".repeat(2_000)}`;
      const { spent, control: controlMs, ratio } = pairedCost(
        () => classifyForHook(control, [], dir, [], false, [dir]),
        () => classifyForHook(command, [], dir, [], false, [dir]),
        21,
        5,
      );
      // The median call's fixed 100 CPU ms is printed, not asserted (#720's
      // list: CI read 50.4 of it with the code unchanged); the control holds
      // a bound of its own instead ({@link RUN_CONTROL_CI_MS}).
      const ciMs = RUN_CONTROL_CI_MS[prefix]!;
      const { controlBound, controlOver } = heldBy(ratio, controlMs, ciMs, runner().factor, most, CONTROL_MOST);
      const label = `${command.slice(0, 30)} (2000 characters): median ${spent.toFixed(1)} CPU ms of ${(BOUND_MS * 2).toFixed(1)} (printed, not asserted), control ${controlMs.toFixed(1)}, ratio ${ratio.toFixed(2)} of ${most.toFixed(1)}; the control's own bound ${controlBound.toFixed(1)}`;
      t.diagnostic(`cost: ${label}`);
      assert.ok(ratio <= most, label);
      assert.ok(!controlOver, `the control of ${label} (${String(CONTROL_MOST)} x its CI ${ciMs.toFixed(1)}, ${runner().line})`);
    }
    // The 20,000-character run and the 5,004-character class, each held by
    // the RATIO rule ({@link LONG_RATIO_BOUND}) against the same line with a
    // plain name of the same length; the fixed 100 CPU ms of one call is
    // printed, not asserted (#720's list: CI read 62.7 of it).
    const over: string[] = [];
    for (const [wordName, word] of LONG_WORDS) {
      // A `cat` of a long `[` run is left out: its cost is the kernel refusing
      // a path that long (lstat through realpath, about 7 CPU ms a call,
      // the same before and after this change), not either glob reader.
      const reads: Array<[string, (each: string) => string]> = word.startsWith("*") ? [["cat", (each) => `cat ${each}`], ["cat ~/.hermes/", (each) => `cat ~/.hermes/${each}`]] : [];
      const shapes: Array<[string, (each: string) => string]> = [["echo x >", (each) => `echo x > ${each}`], ["echo x > ~/.hermes/", (each) => `echo x > ~/.hermes/${each}`], ...reads];
      for (const [shapeName, shape] of shapes) {
        const command = shape(word);
        const control = shape("a".repeat(word.length));
        const { spent, control: controlMs, ratio } = leastCost(
          () => classifyForHook(control, [], dir, [], false, [dir]),
          () => classifyForHook(command, [], dir, [], false, [dir]),
          LEAST_ROUNDS,
        );
        const name = `${shapeName} ${wordName}`;
        const ciMs = LONG_CONTROL_CI_MS[name]!;
        const { controlBound, lineOver, controlOver } = heldBy(ratio, controlMs, ciMs, runner().factor, LONG_RATIO_BOUND, LEAST_CONTROL_MOST);
        const label = `${command.slice(0, 30)} (${String(word.length)} characters): least ${spent.toFixed(1)} CPU ms, control ${controlMs.toFixed(1)}, ratio ${ratio.toFixed(2)} of ${String(LONG_RATIO_BOUND)}; the control's own bound ${controlBound.toFixed(1)}; the fixed ${String(BOUND_MS * 2)} ms is printed, not asserted`;
        t.diagnostic(`cost: ${label}`);
        if (lineOver) over.push(label);
        if (controlOver) over.push(`the control of ${label} (${String(LEAST_CONTROL_MOST)} x its CI ${ciMs.toFixed(1)}, ${runner().line})`);
      }
    }
    assert.deepEqual(over, [], `over the bound:\n${over.join("\n")}`);
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
  }
});

/**
 * Test 4's one 20,000-character line printed and not held to the 100 ms bound
 * until the argv-line split (the owed row of L63574): the single call of
 * `cp ~/.hermes/<run> out.txt`, 80.3 CPU ms on the merge queue's runner (run
 * 45745887200, node 22) and about 96 on node 20, the lead's by CLAIMS L63680.
 * Its cost is the copy's argv of every entry, judged in each name reading; it
 * returns to the assert with that split. The eight 2,000-character lines are
 * held another way: see {@link COPY_RATIO_BOUND}.
 *
 * Empty since #720: that line was printed only because one call against a
 * fixed 100 ms judged it. All eight 20,000-character lines are now held by the
 * RATIO rule ({@link COPY_20K_RATIO_BOUND}), that line's ratio to its plain
 * control included (it held, see the constant), so none is left printed only.
 * A line taken off the assert again is a ruling, and named here.
 */
const PRINT_ONLY: readonly string[] = [];

/**
 * The most a 2,000-character `cp` or `mv` line of test 4 may cost over its
 * control, the median of the pairs' ratios (lead ruling, CLAIMS L66128).
 *
 * Until that ruling six of these eight lines held a fixed 100 CPU ms (the two
 * plain `cp` lines were printed only, CLAIMS L63667). The full gate draws two
 * kinds of runner, and on the slower kind every line of this test reads 1.4
 * to 1.6 times dearer, its controls included: `mv README.md <run>` 118.1 CPU
 * ms beside a control of 8.1 on one attempt of a job, and 61.7 beside 4.3 on
 * the next attempt of the same job at the same commit (run 46095148223). A
 * fixed bound then fails for the runner: the merge queue went red on it twice
 * (46109998734, 46112543067). `tests/cost-runner.ts` does not see this
 * slowness: its calibration is string work and read 1.00 to 1.14 on those red
 * shards, while these lines also read two directories of 200 entries.
 *
 * A ratio to the control does not move with the runner: 11.7 to 37.0 across
 * ten full-gate runs on both kinds, 17 to 50 on main by test 4's own note. A
 * walk that has become quadratic is in the hundreds. The fixed 100 ms returns
 * with the argv-line split (owed: PRIORITIES), which brings these ratios
 * under test 3's {@link RUN_RATIO_BOUND}; until then it is printed beside
 * each line.
 */
const COPY_RATIO_BOUND = 60;

/**
 * Test 4's eight control lines on the faster kind of GitHub-hosted runner, in
 * CPU ms: for each, the largest median of six full-gate runs that drew one
 * (node 22: 45877300800, 46025999658, 46061144003, 46074304957 and the second
 * attempt of 46095148223; node 20: 45877300800's floor).
 *
 * A ratio alone would pass a change that slowed every `cp` line, the control
 * with the run. So each control holds a bound of its own:
 * {@link CONTROL_MOST} times its figure here, stretched by the runner's
 * factor as the other cost files stretch theirs ({@link scaledBound}). The
 * slower runners read 1.07 to 1.54 times these figures.
 */
const CONTROL_FAST_MS: Readonly<Record<string, number>> = {
  "cp, destination": 7.2,
  "cp, source": 3.6,
  "mv, destination": 5.4,
  "mv, source": 3.3,
  "~/.hermes/ cp, destination": 5.7,
  "~/.hermes/ cp, source": 3.3,
  "~/.hermes/ mv, destination": 5.4,
  "~/.hermes/ mv, source": 3.0,
};

/** The most a control may read of its CI figure, before the runner's factor. */
const CONTROL_MOST = 2;

/*
 * #720's list: every other line of this file that held one reading to a fixed
 * bound is held by the RATIO rule ({@link heldBy}): each line beside a control
 * read in the same test, the least of {@link LEAST_ROUNDS} readings of each
 * ({@link leastCost}), the line at most a ratio bound times its control, and
 * the control at most {@link LEAST_CONTROL_MOST} times its CI figure below,
 * stretched by the runner's factor. The fixed bounds these lines held are
 * printed beside each line, not asserted: one call read up to 75.8 (test 2),
 * 62.7 (test 3) and 89.1 (test 4) CPU ms of 100 on CI with the code
 * unchanged, and 141 on the line PRINT_ONLY kept off the assert.
 *
 * Each ratio bound is about three times the largest ratio CI read, and under
 * half of what the walk its test guards against reads. Each control figure is
 * the largest least reading of that control on CI. The figures are named with
 * their runs: 46140003817 (attempts 1 and 2, node 22, at e84e394a) and
 * 46137342920 (node 22, at 34d33e22). Each walk is compared with its control
 * on the same machine (a laptop), where both were measured.
 */

/**
 * The most a control of the lines below may read of its CI figure, before the
 * runner's factor. Three, where test 4's 2,000-character controls have
 * {@link CONTROL_MOST} two: these figures are from node 22 runs only (a pull
 * request's full gate has no node 20 floor), and the slower runner read test
 * 4's controls up to 1.54 times the faster one's.
 */
const LEAST_CONTROL_MOST = 3;

/**
 * Test 2: the most a line may cost over its control (the same line with the
 * run of `*` spelled as plain `a`). CI's largest: 5.63, `echo x >` with 160
 * `*` (46140003817 attempt 2; 5.25 in attempt 1); the rest 0.9 to 5.3. The
 * walk the test guards against, the old matcher's backtracking, took 0.95 CPU
 * s at 12 `*` in the credential pass and 36.7 at 8 `*` in the write pass on
 * a521a91d, against controls under 6 CPU ms on a laptop: hundreds to
 * thousands of times.
 */
const STAR_RATIO_BOUND = 17;

/** Test 2's controls by shape, CPU ms: the largest least reading over the five star counts (46140003817, attempts 1 and 2). */
const STAR_CONTROL_CI_MS: Readonly<Record<string, number>> = {
  cat: 4.2,
  "cat ~/.hermes/": 3.2,
  "echo x > ~/.hermes/": 6.2,
  "echo x >": 2.8,
  "cat */…/x": 2.5,
  "echo x > ~/.hermes/*/": 21.1,
};

/**
 * Test 3's 2,000-character control by prefix, CPU ms: its largest median (the
 * mean of 5 calls a pair) in five full-gate runs on both node versions
 * (46129727550, 46122809349, 46120820750, 46123343466, 46140003817 attempt
 * 1): 4.6 (46123343466, node 20) and 3.1 (46123343466, node 22). Held to
 * {@link CONTROL_MOST} times it: these figures include the slower runner.
 */
const RUN_CONTROL_CI_MS: Readonly<Record<string, number>> = {
  "": 4.6,
  "~/.hermes/": 3.1,
};

/**
 * Test 3's long words: the most a line may cost over its control (a plain
 * name of the same length). CI's largest: 6.42, `echo x > *[5,000 z]X`
 * (46140003817, attempt 1; attempt 2 read 5.11); the rest 1.2 to 2.3. The
 * walks the test guards against, on bfa73710 on a laptop: 20,000 `[` 2.8 CPU
 * s (each `[` scanned to the end) against a control of about 3 CPU ms there,
 * some 900 times; `cat *[5,000 z]X` 160 CPU ms (each character tested
 * against every member) against about 1.1, some 145 times. Nineteen is
 * under half of the smaller.
 */
const LONG_RATIO_BOUND = 19;

/** Test 3's long words' controls, CPU ms: the largest least reading (46140003817, attempts 1 and 2). */
const LONG_CONTROL_CI_MS: Readonly<Record<string, number>> = {
  "echo x > 20,000 [": 13.9,
  "echo x > ~/.hermes/ 20,000 [": 26.0,
  "echo x > *[5,000 z]X": 3.6,
  "echo x > ~/.hermes/ *[5,000 z]X": 8.5,
  "cat *[5,000 z]X": 4.8,
  "cat ~/.hermes/ *[5,000 z]X": 3.7,
};

/**
 * Test 4's 20,000-character lines: the most a line may cost over its control
 * (the same line with a plain name of 20,000 characters; the seat's choice).
 * CI's largest: 4.17, `mv <run> out.txt` (46137342920: least 47.1 beside
 * 11.3); the rest 0.7 to 3.1, `~/.hermes/ cp, source` (PRINT_ONLY's line)
 * 2.55; attempt 2 read 2.94 at most. The walk the test guards against, a run
 * of `[` scanned from every `[` (2.8 CPU s for 20,000 on bfa73710, a laptop),
 * is 230 to 350 times these controls on a laptop (8 to 12 CPU ms).
 */
const COPY_20K_RATIO_BOUND = 13;

/** Test 4's 20,000-character controls, CPU ms: the largest least reading (46137342920, and 46140003817 attempts 1 and 2). */
const COPY_20K_CONTROL_CI_MS: Readonly<Record<string, number>> = {
  "cp, destination": 38.7,
  "cp, source": 27.9,
  "mv, destination": 36.1,
  "mv, source": 14.7,
  "~/.hermes/ cp, destination": 52.0,
  "~/.hermes/ cp, source": 60.4,
  "~/.hermes/ mv, destination": 52.2,
  "~/.hermes/ mv, source": 51.2,
};

/**
 * One 2,000-character line of test 4 judged with its control: whether the
 * line is over its ratio to the control, and whether the control is over its
 * own bound (`runnerFactor` is {@link runner}'s, passed in so the rule can be
 * tested with figures).
 */
function judged(ratio: number, controlMs: number, fastMs: number, runnerFactor: number): { controlBound: number; lineOver: boolean; controlOver: boolean } {
  return heldBy(ratio, controlMs, fastMs, runnerFactor, COPY_RATIO_BOUND, CONTROL_MOST);
}

/**
 * The RATIO rule of #718 and #719, for any line of this file: the line is over
 * when its ratio to its control reaches `ratioBound`, and the control is over
 * when it reaches {@link CONTROL_MOST} times its CI figure `ciMs`, stretched by
 * the runner's factor (passed in so the rule can be tested with figures).
 */
function heldBy(ratio: number, controlMs: number, ciMs: number, runnerFactor: number, ratioBound: number, most: number): { controlBound: number; lineOver: boolean; controlOver: boolean } {
  const controlBound = most * ciMs * runnerFactor;
  return { controlBound, lineOver: !(ratio < ratioBound), controlOver: !(controlMs < controlBound) };
}

test("cost: a 2,000-character copy or move is held by its ratio to its control, and the control by its own bound (CLAIMS L66128)", () => {
  // `mv README.md <run>` as two attempts of one job read it (run 46095148223):
  // 61.7 beside 4.3 on the faster runner, 118.1 beside 8.1 on the slower. Both pass.
  assert.deepEqual(judged(14.36, 4.3, 5.4, 1), { controlBound: 10.8, lineOver: false, controlOver: false });
  assert.deepEqual(judged(15.16, 8.1, 5.4, 1), { controlBound: 10.8, lineOver: false, controlOver: false });
  // A line at or past sixty times its control is red, on any runner.
  assert.equal(judged(59.99, 4.3, 5.4, 1).lineOver, false);
  assert.equal(judged(60, 4.3, 5.4, 1).lineOver, true);
  assert.equal(judged(240, 8.1, 5.4, 1).lineOver, true);
  // A control at twice its figure is red itself, whatever its line's ratio:
  // a change that slowed every `cp` line keeps the ratio and fails here.
  assert.deepEqual(judged(15, 10.8, 5.4, 1), { controlBound: 10.8, lineOver: false, controlOver: true });
  assert.equal(judged(15, 10.7, 5.4, 1).controlOver, false);
  // The runner's factor stretches the control's bound and nothing else.
  assert.deepEqual(judged(60, 10.8, 5.4, 1.5), { controlBound: CONTROL_MOST * 5.4 * 1.5, lineOver: true, controlOver: false });
  // Each of the eight lines has its control's figure, and the factor used is the shared runner's.
  const shapes = ["cp, destination", "cp, source", "mv, destination", "mv, source"];
  assert.deepEqual(Object.keys(CONTROL_FAST_MS).sort(), [...shapes, ...shapes.map((shape) => `~/.hermes/ ${shape}`)].sort());
  for (const fast of Object.values(CONTROL_FAST_MS)) assert.ok(fast > 0);
  assert.equal(scaledBound(CONTROL_MOST * 5.4), CONTROL_MOST * 5.4 * runner().factor);
});

test("cost: the lines that held a fixed bound are held by their ratio and their control by its own bound (#720's list)", () => {
  for (const [ratioBound, figures, most] of [
    [STAR_RATIO_BOUND, STAR_CONTROL_CI_MS, LEAST_CONTROL_MOST],
    [RUN_RATIO_BOUND, RUN_CONTROL_CI_MS, CONTROL_MOST],
    [LONG_RATIO_BOUND, LONG_CONTROL_CI_MS, LEAST_CONTROL_MOST],
    [COPY_20K_RATIO_BOUND, COPY_20K_CONTROL_CI_MS, LEAST_CONTROL_MOST],
  ] as const) {
    for (const ciMs of Object.values(figures)) {
      assert.ok(ciMs > 0);
      // A line under its ratio beside a control at its CI figure passes.
      assert.deepEqual(heldBy(ratioBound - 0.01, ciMs, ciMs, 1, ratioBound, most), { controlBound: most * ciMs, lineOver: false, controlOver: false });
      // At the ratio bound the line is red, on any runner.
      assert.equal(heldBy(ratioBound, ciMs, ciMs, 1, ratioBound, most).lineOver, true);
      assert.equal(heldBy(ratioBound, ciMs, ciMs, 4, ratioBound, most).lineOver, true);
      // A change that slows the line and its control together keeps the ratio
      // and reds on the control: at `most` times its figure.
      assert.deepEqual(heldBy(1, most * ciMs, ciMs, 1, ratioBound, most), { controlBound: most * ciMs, lineOver: false, controlOver: true });
      // The runner's factor stretches the control's bound and nothing else.
      assert.equal(heldBy(1, most * ciMs, ciMs, 1.5, ratioBound, most).controlOver, false);
    }
  }
  // Each table names every line it holds.
  assert.deepEqual(Object.keys(STAR_CONTROL_CI_MS).sort(), STAR_SHAPES.map(([name]) => name).sort());
  assert.deepEqual(Object.keys(RUN_CONTROL_CI_MS).sort(), ["", "~/.hermes/"]);
  assert.deepEqual(Object.keys(LONG_CONTROL_CI_MS).sort(), [
    "cat *[5,000 z]X",
    "cat ~/.hermes/ *[5,000 z]X",
    "echo x > *[5,000 z]X",
    "echo x > 20,000 [",
    "echo x > ~/.hermes/ *[5,000 z]X",
    "echo x > ~/.hermes/ 20,000 [",
  ]);
  assert.deepEqual(Object.keys(COPY_20K_CONTROL_CI_MS).sort(), Object.keys(CONTROL_FAST_MS).sort());
  assert.equal(LEAST_ROUNDS, 5);
  assert.equal(LEAST_CONTROL_MOST, 3);
  assert.equal(STAR_RATIO_BOUND, 17);
  assert.equal(LONG_RATIO_BOUND, 19);
  assert.equal(COPY_20K_RATIO_BOUND, 13);
});

test("cost: cp and mv with a run of unclosed `[` as an operand, through the whole classification (PRIORITIES:331)", (t) => {
  const { dir, home } = workspace();
  // Test 3's fixture: two hundred names of 250 characters beside the
  // workspace's own, in the directory and in the home.
  for (let index = 0; index < 200; index += 1) {
    const name = `${String(index).padStart(3, "0")}${"a".repeat(247)}`;
    writeFileSync(join(dir, name), "x\n", "utf8");
    writeFileSync(join(home, ".hermes", name), "x\n", "utf8");
  }
  const savedHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    // Test 3's run of 2,000 `[`, as a copy's or a move's destination and as
    // its source: past 1,024 glob characters it matches every entry, so the
    // argv is written out with every entry and judged as a synthetic line in
    // each name reading, every entry is landed as a write (a copy or move
    // writes a tree), and a copy's source is read, so the credential pass
    // lands every entry too. build-1 measured 148 and 127 CPU ms on node 20
    // at #682's head, one call each, over the 100 test 3 holds `echo x >` to.
    // One call is not a reading (test 3), so each is timed as test 3 times its
    // lines: 21 pairs against the same line with the run replaced by a plain
    // name of the same length (the workspace's), the median call under 100
    // CPU ms. On 170229db, a laptop at load 9: medians of 21 to 65 CPU ms
    // (node 20: 34 to 65) and first calls up to 108 (node 20, `cp` to the
    // run).
    //
    // Not test 3's ratio bound yet (lead ruling, CLAIMS L63574): the copy's
    // or move's argv of every entry is one synthetic line, judged again in
    // each name reading (three for these lines), where `echo x >`'s plain
    // names are judged once for the call (test 3's split, which does not
    // carry over to an argv: there a name's place decides what it is). So
    // these lines read 17 to 50 times their control on main, against test 3's
    // 18, and hold {@link COPY_RATIO_BOUND} in its place; the fixed 100 ms is
    // printed with each line and returns with the argv-line split (owed:
    // PRIORITIES, the argv-line split).
    const run = "[".repeat(2_000);
    const plain = "a".repeat(2_000);
    /** Each line over its bound, named with its figures, asserted at the end. */
    const over: string[] = [];
    /** The 20,000-character lines held to their ratio and their control's bound: every one but a PRINT_ONLY name. */
    let ratioHeld20k = 0;
    /** The 2,000-character lines held to their ratio and their control's bound: all eight. */
    let ratioHeld = 0;
    const lines: Array<[string, (word: string) => string]> = [
      ["cp, destination", (word) => `cp README.md ${word}`],
      ["cp, source", (word) => `cp ${word} out.txt`],
      ["mv, destination", (word) => `mv README.md ${word}`],
      ["mv, source", (word) => `mv ${word} out.txt`],
    ];
    const named = (shape: string, prefix: string): string => `${prefix === "" ? "" : `${prefix} `}${shape}`;
    const printOnly = (shape: string, prefix: string, length: number): boolean => PRINT_ONLY.includes(`${named(shape, prefix)} ${String(length)}`);
    t.diagnostic(`cost: ${runner().line}`);
    const PRINTED = "(printed, not asserted until the argv-line split: PRIORITIES)";
    for (const prefix of ["", "~/.hermes/"]) {
      for (const [shape, line] of lines) {
        const command = line(`${prefix}${run}`);
        const control = line(plain);
        const { spent, control: controlMs, ratio } = pairedCost(
          () => classifyForHook(control, [], dir, [], false, [dir]),
          () => classifyForHook(command, [], dir, [], false, [dir]),
          21,
          5,
        );
        const fastMs = CONTROL_FAST_MS[named(shape, prefix)]!;
        const { controlBound, lineOver, controlOver } = judged(ratio, controlMs, fastMs, runner().factor);
        const label = `${command.slice(0, 30)} (2000 characters): median ${spent.toFixed(1)} CPU ms of ${(BOUND_MS * 2).toFixed(1)}, control ${controlMs.toFixed(1)}, ratio ${ratio.toFixed(2)} of ${String(COPY_RATIO_BOUND)}; the control's own bound ${controlBound.toFixed(1)}; the ${String(BOUND_MS * 2)} ms is printed, not asserted until the argv-line split: PRIORITIES`;
        t.diagnostic(`cost: ${label}`);
        ratioHeld += 1;
        if (lineOver) over.push(label);
        // The control's own bound: it is the classifier too, and a change
        // that slowed the plain line and the run together keeps the ratio.
        if (controlOver) over.push(`the control of ${command.slice(0, 30)} (2000 characters): median ${controlMs.toFixed(1)} CPU ms, its own bound ${controlBound.toFixed(1)} (${String(CONTROL_MOST)} x its ${fastMs.toFixed(1)} on the faster runner, ${runner().line})`);
      }
    }
    // Test 3's 20,000-character run: past the longest path the kernel opens,
    // so each landing is guarded unread. Each line is held by the RATIO rule
    // ({@link COPY_20K_RATIO_BOUND}) against the same line with a plain name of
    // 20,000 characters (the 2,000-character control is too small to be a
    // steady divisor); the fixed 100 CPU ms of one call is printed, not
    // asserted (#720's list: CI read 89.1 of it, and 141 on the line PRINT_ONLY
    // held, with the code unchanged).
    for (const prefix of ["", "~/.hermes/"]) {
      for (const [shape, line] of lines) {
        const command = line(`${prefix}${"[".repeat(20_000)}`);
        const control = line(`${prefix}${"a".repeat(20_000)}`);
        const { spent, control: controlMs, ratio } = leastCost(
          () => classifyForHook(control, [], dir, [], false, [dir]),
          () => classifyForHook(command, [], dir, [], false, [dir]),
          LEAST_ROUNDS,
        );
        const name = named(shape, prefix);
        const ciMs = COPY_20K_CONTROL_CI_MS[name]!;
        const { controlBound, lineOver, controlOver } = heldBy(ratio, controlMs, ciMs, runner().factor, COPY_20K_RATIO_BOUND, LEAST_CONTROL_MOST);
        const label = `${command.slice(0, 30)} (20000 characters): least ${spent.toFixed(1)} CPU ms, control ${controlMs.toFixed(1)}, ratio ${ratio.toFixed(2)} of ${String(COPY_20K_RATIO_BOUND)}; the control's own bound ${controlBound.toFixed(1)}; the fixed ${String(BOUND_MS * 2)} ms is printed, not asserted`;
        if (printOnly(shape, prefix, 20_000)) {
          t.diagnostic(`cost: ${label} ${PRINTED}`);
          continue;
        }
        t.diagnostic(`cost: ${label}`);
        ratioHeld20k += 1;
        if (lineOver) over.push(label);
        if (controlOver) over.push(`the control of ${label} (${String(LEAST_CONTROL_MOST)} x its CI ${ciMs.toFixed(1)}, ${runner().line})`);
      }
    }
    // Every line is measured and printed before any is held to its bound, so
    // one run (a CI shard) reads them all.
    assert.deepEqual(over, [], `over the bound:\n${over.join("\n")}`);
    // All eight 2,000-character lines hold their ratio, and every
    // 20,000-character line but a PRINT_ONLY name holds its own.
    assert.equal(ratioHeld, 8);
    assert.equal(ratioHeld20k, 8 - PRINT_ONLY.length);
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
  }
});

test("cost: test 4 prints no line only: the 20,000-character line the lead ruled off the assert (CLAIMS L63680) is held by its ratio (#720); the 2,000-character lines hold a ratio (L66128)", () => {
  // The list cannot grow unseen: a line taken off the assert is a ruling. The
  // one CLAIMS L63680 took off (`~/.hermes/ cp, source`, 20,000 characters)
  // holds COPY_20K_RATIO_BOUND now, as all eight do; the two plain `cp` lines
  // of 2,000 characters that CLAIMS L63667 had here hold COPY_RATIO_BOUND.
  assert.deepEqual([...PRINT_ONLY], []);
  assert.equal(COPY_RATIO_BOUND, 60);
  assert.equal(CONTROL_MOST, 2);
});

test("a guarded name after or among unclosed `[` still takes its class: the entries a long run is judged to match keep theirs (build-5, the unclosed-`[` cost line)", () => {
  // Past 1,024 glob characters a pattern segment is judged to match every
  // name (the strict side), so the write pass lands, and writes out as a
  // synthetic line, every entry of the directory: the cost the test above
  // bounds. Its disk reads are kept for the call and shared by the readings
  // and passes; each entry must still answer as it does written by name.
  const dir = join(scratch, "unclosed");
  const home = join(scratch, "unclosed-home");
  for (const each of [".approval", ".git/hooks", ".claude", "sub/.approval", "plain"]) mkdirSync(join(dir, each), { recursive: true });
  for (const each of ["APPROVAL.md", ".approval/env", ".git/config", ".git/HEAD", ".claude/settings.json", "sub/.approval/env", "README.md", "plain/a.txt"]) {
    writeFileSync(join(dir, each), "x\n", "utf8");
  }
  symlinkSync(join(dir, ".git"), join(dir, "lnk"));
  symlinkSync(join(dir, ".git", "hooks"), join(dir, "hk"));
  for (let index = 0; index < 40; index += 1) writeFileSync(join(dir, `${String(index).padStart(3, "0")}${"a".repeat(247)}`), "x\n", "utf8");
  mkdirSync(join(home, ".hermes"), { recursive: true });
  for (const name of ["auth.json", "config.yaml"]) writeFileSync(join(home, ".hermes", name), "x\n", "utf8");
  const savedHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    const classesOf = (command: string): string[] => {
      const { result } = classifyForHook(command, [], dir, [], false, [dir]);
      assert.ok(result.ok, command.slice(0, 40));
      return [...new Set(result.classes)].sort();
    };
    const run = "[".repeat(2_000);
    // Each entry written by name, through the same passes.
    assert.deepEqual(classesOf("echo x > APPROVAL.md"), ["policy.core"]);
    assert.deepEqual(classesOf("echo x > .approval"), ["log.mutate", "policy.core"]);
    assert.deepEqual(classesOf("echo x > lnk/config"), ["files.write.guarded", "files.write.workspace", "vcs.history.rewrite"]);
    assert.deepEqual(classesOf("echo x > hk/pre-commit"), ["files.write.guarded", "files.write.workspace", "vcs.history.rewrite"]);
    // A few unclosed `[` read as text, as the shells read them: the name with
    // them in it, not the guarded one.
    assert.deepEqual(classesOf("echo x > [[[APPROVAL.md"), ["files.write.workspace"]);
    assert.deepEqual(classesOf("echo x > .git/[config"), ["vcs.history.rewrite"]);
    // The long run: every entry, so every entry's class.
    for (const command of [`echo x > ${run}`, `echo x > ${"[".repeat(1_100)}APPROVAL.md`, `cp README.md ${run}`, `tee ${run} < README.md`]) {
      assert.deepEqual(classesOf(command), ["files.write.guarded", "log.mutate", "policy.core", "vcs.history.rewrite"], command.slice(0, 40));
    }
    // Under a link into `.git` (the git-directory pass's walk) and into its
    // hooks (the guarded list), from the walks the call keeps.
    assert.deepEqual(classesOf(`echo x > lnk/${run}`), ["files.write.guarded", "vcs.history.rewrite"]);
    assert.deepEqual(classesOf(`echo x > hk/${run}`), ["files.write.guarded", "vcs.history.rewrite"]);
    assert.deepEqual(classesOf(`echo x > plain/${run}`), ["vcs.history.rewrite"]);
    // A long run ending in a guarded name: the entry that holds it.
    assert.deepEqual(classesOf(`echo x > ${run}/.approval/env`), ["files.write.guarded", "policy.core", "vcs.history.rewrite"]);
    assert.deepEqual(classesOf(`echo x > sub/${run}/env`), ["policy.core", "vcs.history.rewrite"]);
    assert.deepEqual(classesOf(`echo x > ~/.hermes/${run}`), ["policy.core", "vcs.history.rewrite"]);
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
  }
});

test("a guarded name among many plain ones under an unclosed `[` run keeps its true class: the plain names are judged as a line of their own (build-5, the unclosed-`[` cost line)", () => {
  // Twenty plain names (each ends in a plain lower-case name) beside every
  // guarded entry, in each directory: enough for the pattern pass to judge
  // the plain matches first, apart from the rest, and the rest alone when the
  // plain ones earn nothing. `notes-plain` is plain and routed by the policy
  // below, so with that policy the plain line earns a class and the whole
  // line is judged as before. Each answer is the one 90cfcc10 (every match
  // in one line, in every reading) gives on this fixture, segment for segment.
  const dir = join(scratch, "plain-split");
  const home = join(scratch, "plain-split-home");
  const plain = Array.from({ length: 20 }, (_, index) => `p${String(index).padStart(3, "0")}${"q".repeat(60)}`);
  for (const each of [".approval", ".git/hooks", ".claude/agents", ".github/workflows", "sub"]) mkdirSync(join(dir, each), { recursive: true });
  for (const each of ["APPROVAL.md", "SPEC.md", "README.md", ".approval/env", ".git/config", ".git/HEAD", ".claude/settings.json", ".claude/agents/a.md", ".github/workflows/ci.yml", "notes-plain"]) {
    writeFileSync(join(dir, each), "x\n", "utf8");
  }
  for (const at of ["", ".approval", ".git", ".claude", ".claude/agents", ".github/workflows", "sub"]) for (const name of plain) writeFileSync(join(dir, at, name), "x\n", "utf8");
  symlinkSync(join(dir, ".git"), join(dir, "gd"));
  mkdirSync(join(home, ".hermes"), { recursive: true });
  for (const name of ["auth.json", "config.yaml", ...plain]) writeFileSync(join(home, ".hermes", name), "x\n", "utf8");
  const routed = [
    { path: ".github/workflows/", class: "policy.edit.ci" },
    { path: ".claude/agents/", class: "policy.edit.agents" },
    { path: "SPEC.md", class: "policy.edit.spec" },
    { path: "notes-plain", class: "policy.edit.spec" },
  ];
  // `notes-plain` routed to a class no other entry earns (above, SPEC.md
  // earns `policy.edit.spec` again): only the plain names' own line carries it.
  const notesOnly = [{ path: "notes-plain", class: "policy.edit.notes" }];
  const savedHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    const run = "[".repeat(2_000);
    const answer = (command: string, paths: readonly { path: string; class: string }[]): string => {
      const { result } = classifyForHook(command, paths, dir, [], false, [dir]);
      assert.ok(result.ok, command.slice(0, 40));
      return result.segments.map((segment) => `${segment.class}/${segment.rule}`).join(" ; ");
    };
    // The fixture sits under the system's temporary directory, a scratch root,
    // so only a git directory's entries are on the write pass's guarded list.
    const guarded = "vcs.history.rewrite/git-dir-write";
    const resolved = (...classes: string[]): string => classes.map((cls) => ` ; ${cls}/write-resolved-landing`).join("");
    const cases: Array<[string, readonly { path: string; class: string }[], string]> = [
      // APPROVAL.md, SPEC.md (policy.edit) and `.approval` (log.mutate) among the plain names.
      [`echo x > ${run}`, [], `${guarded}${resolved("policy.core", "policy.edit", "log.mutate")}`],
      [`echo x >> ${"[".repeat(1_100)}APPROVAL.md`, [], `${guarded}${resolved("policy.core", "policy.edit", "log.mutate")}`],
      // tee's own pass judges each match it writes: the list's class beside the line's.
      [`tee ${run} < README.md`, [], `${guarded} ; files.write.guarded/write-guarded${resolved("policy.core", "policy.edit", "log.mutate")}`],
      // `notes-plain` is routed: the plain names earn a class, and every match is judged together.
      [`echo x > ${run}`, routed, `${guarded}${resolved("policy.core", "policy.edit", "policy.edit.spec", "log.mutate", "policy.edit.agents", "policy.edit.ci")}`],
      // The plain names alone earn `policy.edit.notes`: a plain line that earns a
      // class is not set aside for the other names' line (build-1's S3 on 3f70feb7).
      [`echo x > ${run}`, notesOnly, `${guarded}${resolved("policy.core", "policy.edit", "policy.edit.notes", "log.mutate")}`],
      // .approval/env, .git/config (also through a link), .claude/settings.json, .github/workflows/ci.yml.
      [`echo x > .approval/${run}`, [], `policy.core/redirect-protected ; ${guarded}`],
      // A git directory's entries are on the guarded list wherever it is.
      [`echo x > .git/${run}`, [], `${guarded} ; files.write.guarded/write-guarded`],
      [`echo x > gd/${run}`, [], `${guarded} ; files.write.guarded/write-guarded`],
      [`echo x > .claude/${run}`, [], `${guarded}${resolved("policy.core")}`],
      [`echo x > .claude/${run}`, routed, `${guarded}${resolved("policy.core", "policy.edit.agents")}`],
      [`echo x > .claude/agents/${run}`, routed, `policy.edit.agents/redirect-protected ; ${guarded}`],
      [`echo x > .github/workflows/${run}`, [], `policy.edit/redirect-protected ; ${guarded}`],
      [`echo x > .github/workflows/${run}`, routed, `policy.edit.ci/redirect-protected ; ${guarded}`],
      [`echo x > ~/.hermes/${run}`, [], `${guarded}${resolved("policy.core")}`],
      // Plain names alone: nothing beside the run's own classes.
      [`echo x > sub/${run}`, [], guarded],
      [`echo x > p0*`, [], "files.write.workspace/redirect-write"],
    ];
    for (const [command, paths, expected] of cases) {
      assert.equal(answer(command, paths), expected, `${command.slice(0, 40)} (${paths.length === 0 ? "no routes" : "routed"})`);
    }
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
  }
});

test("a copy into a pattern still finds a checkout among its matches: only a listed FILE is read as holding no `.git` (PRIORITIES:331)", () => {
  // The write pass answers `lstat(<entry>/.git)` (a tree written at a
  // checkout can lay down hooks) from the listing where the entry is a
  // regular file, which holds no names (ENOTDIR). A directory, or a link,
  // is still asked: `co` is a checkout (a `.git` folder) and `wt` a linked
  // worktree (a `.git` file), each beside plain files the pattern matches.
  const dir = join(scratch, "checkout-among");
  const home = join(scratch, "checkout-among-home");
  mkdirSync(join(dir, "co", ".git"), { recursive: true });
  mkdirSync(join(dir, "wt"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(dir, "wt", ".git"), "gitdir: /nowhere\n", "utf8");
  for (const name of ["README.md", "cfile", "wfile", "plain.txt"]) writeFileSync(join(dir, name), "x\n", "utf8");
  const savedHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    const reaches = (command: string): string[] => {
      const { result, notes } = classifyForHook(command, [], dir, [], false, [dir]);
      assert.ok(result.ok, command.slice(0, 40));
      assert.ok(result.classes.includes("files.write.guarded"), `${command.slice(0, 40)}: ${JSON.stringify(result.classes)}`);
      return notes
        .filter((note) => note.includes("can reach"))
        .map((note) => /a tree written at (\S+) can reach/u.exec(note)?.[1] ?? note)
        .map((path) => path.slice(dir.length + 1))
        .sort();
    };
    // Each command's first checkout found, in the listing's order.
    for (const command of [`cp README.md ${"[".repeat(2_000)}`, `mv README.md ${"[".repeat(2_000)}`, "cp -R README.md c*"]) {
      assert.deepEqual(reaches(command), ["co"], command.slice(0, 40));
    }
    assert.deepEqual(reaches("cp -R README.md w*"), ["wt"]);
    // The plain files beside them are no checkout.
    const { result } = classifyForHook("cp -R README.md p*", [], dir, [], false, [dir]);
    assert.ok(result.ok);
    assert.ok(!result.classes.includes("files.write.guarded"), JSON.stringify(result.classes));
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
  }
});

test("a plain name that earns a class beside names that are not plain keeps its class under an unclosed `[` run (build-1's S3 on 3f70feb7)", () => {
  // A gate directory as it is: its `log` (plain, `log.mutate`) and `env`
  // (plain), twenty plain names, and one name that is not plain (`.Lock`). The
  // plain names' line earns `log.mutate`, which the other names' line does
  // not: the whole line is judged, and `log.mutate` stays.
  const dir = join(scratch, "log-split");
  const home = join(scratch, "log-split-home");
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  mkdirSync(join(home, ".hermes"), { recursive: true });
  const plain = Array.from({ length: 20 }, (_, index) => `p${String(index).padStart(3, "0")}${"q".repeat(60)}`);
  for (const each of [".approval/log/events.jsonl", ".approval/env", ".approval/.Lock", ...plain.map((name) => `.approval/${name}`)]) {
    writeFileSync(join(dir, each), "x\n", "utf8");
  }
  const savedHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    const answer = (command: string): string => {
      const { result } = classifyForHook(command, [], dir, [], false, [dir]);
      assert.ok(result.ok, command.slice(0, 40));
      return result.segments.map((segment) => `${segment.class}/${segment.rule}`).join(" ; ");
    };
    // Each entry written by name.
    assert.equal(answer("echo x > .approval/log"), "log.mutate/redirect-protected");
    assert.equal(answer("echo x > .approval/env"), "policy.core/redirect-protected");
    assert.equal(answer("echo x > .approval/.Lock"), "policy.core/redirect-protected");
    // The long run: the word's own class, the git-directory pass's, and `log`'s.
    const expected = "policy.core/redirect-protected ; vcs.history.rewrite/git-dir-write ; log.mutate/write-resolved-landing";
    assert.equal(answer(`echo x > .approval/${"[".repeat(2_000)}`), expected);
    assert.equal(answer(`echo x >> .approval/${"[".repeat(1_100)}env`), expected);
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
  }
});

/** `count` characters drawn from letters and digits with a fixed seed: a class of few distinct members, written long. */
function classMembers(count: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let state = 7;
  let text = "";
  for (let index = 0; index < count; index += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    text += alphabet[state % alphabet.length] as string;
  }
  return text;
}

test("cost: a big class after a directory pattern over 250 directories is compiled once (review-b's M1 on 8c91e702)", (t) => {
  const { dir, home } = workspace();
  // 250 directories under dd/ (one mkdir an agent may run on its own), so the
  // first component lists 250 bases and the class is tested in each.
  for (let index = 0; index < 250; index += 1) mkdirSync(join(dir, "dd", `d${String(index)}`), { recursive: true });
  writeFileSync(join(dir, "dd", "d1", "fileX"), "x\n", "utf8");
  const savedHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    // On 8c91e702 the class was compiled (and its members sorted) once per
    // base: through the real hook 14.3 CPU s at 125 KB and 28.4 at 250 KB,
    // past 120 s at 500 KB and 1 MB (load 14 to 20). Each size is held to the
    // same word in one directory, run first (the control: one compile, and
    // every other pass the hook makes over a word that long, about 135 CPU ms
    // at 1 MB here), so the bound follows the runner's speed: the fan-out may
    // cost 3x the control plus BOUND_MS. Here it costs about 1.1x; on
    // 8c91e702 the 20,000-member case, first so that build fails in about
    // 2 CPU s, cost about 50x.
    for (const members of [20_000, 500_000, 1_000_000 - 13]) {
      const written = classMembers(members);
      const control = cpuMs(() => {
        classifyForHook(`cat *[${written}]X`, [], dir, [], false, [dir]);
      });
      const command = `cat dd/*/*[${written}]X`;
      assert.equal(command.length, members + 13);
      const ms = cpuMs(() => {
        classifyForHook(command, [], dir, [], false, [dir]);
      });
      const bound = 3 * control + BOUND_MS;
      report(t, `${String(members)} members over 250 directories (control ${control.toFixed(1)})`, ms, bound);
      assert.ok(
        ms < bound,
        `${String(members)} members over 250 directories: ${ms.toFixed(1)} CPU ms, bound ${bound.toFixed(1)} (control ${control.toFixed(1)})`,
      );
    }
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
  }
});
