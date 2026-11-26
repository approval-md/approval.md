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
    for (const stars of [8, ...STAR_COUNTS]) {
      const word = `${"*".repeat(stars)}${"z".repeat(12)}`;
      for (const command of [
        `cat ${word}`,
        `cat ~/.hermes/${word}`,
        `echo x > ~/.hermes/${word}`,
        `echo x > ${word}`,
        `cat */${word}/x`,
        `echo x > ~/.hermes/*/${word}`,
      ]) {
        const ms = cpuMs(() => {
          classifyForHook(command, [], dir, [], false, [dir]);
        });
        report(t, `${command.slice(0, 30)} (${String(stars)} stars)`, ms, BOUND_MS * 2);
        assert.ok(ms < BOUND_MS * 2, `${command.slice(0, 30)} (${String(stars)} stars): ${ms.toFixed(1)} CPU ms, bound ${String(BOUND_MS * 2)}`);
      }
    }
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
      const label = `${command.slice(0, 30)} (2000 characters): median ${spent.toFixed(1)} CPU ms of ${(BOUND_MS * 2).toFixed(1)}, control ${controlMs.toFixed(1)}, ratio ${ratio.toFixed(2)} of ${most.toFixed(1)}`;
      t.diagnostic(`cost: ${label}`);
      assert.ok(spent < BOUND_MS * 2, label);
      assert.ok(ratio <= most, label);
    }
    const words = ["[".repeat(20_000), `*[${"z".repeat(5_000)}]X`];
    for (const word of words) {
      // A `cat` of a long `[` run is left out: its cost is the kernel refusing
      // a path that long (lstat through realpath, about 7 CPU ms a call,
      // the same before and after this change), not either glob reader.
      const reads = word.startsWith("*") ? [`cat ${word}`, `cat ~/.hermes/${word}`] : [];
      for (const command of [`echo x > ${word}`, `echo x > ~/.hermes/${word}`, ...reads]) {
        const ms = cpuMs(() => {
          classifyForHook(command, [], dir, [], false, [dir]);
        });
        report(t, `${command.slice(0, 30)} (${String(word.length)} characters)`, ms, BOUND_MS * 2);
        assert.ok(ms < BOUND_MS * 2, `${command.slice(0, 30)} (${String(word.length)} characters): ${ms.toFixed(1)} CPU ms, bound ${String(BOUND_MS * 2)}`);
      }
    }
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
  }
});

/**
 * Test 4's lines printed and not held to the 100 ms bound until the argv-line
 * split (the owed row of L63574), each by its shape, its prefix and the run's
 * length. Two are the lead's ruling, CLAIMS L63667: `cp <run> out.txt` and
 * `cp README.md <run>` at 2,000 characters, 87.5 and 79.9 on the merge
 * queue's runner (run 45745887200, node 22, every median under 100). The
 * third, the single call of `cp ~/.hermes/<run> out.txt` at 20,000
 * characters (80.3 there), is the lead's by the same reasoning, CLAIMS
 * L63680. Node 20 reads about 1.2 times node 22 and the queue has a node-20
 * floor, so on it each would stand at or past the bound (about 105, 96 and
 * 96). The cost of all three is the copy's argv of every entry, judged in
 * each name reading; each returns to the assert with that split. Every other
 * line keeps its bound: test 4 counts the thirteen it asserts, and test 5
 * holds this list to these three.
 */
const PRINT_ONLY: readonly string[] = ["cp, source 2000", "cp, destination 2000", "~/.hermes/ cp, source 20000"];

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
    // No ratio bound yet (lead ruling, CLAIMS L63574): the copy's or move's
    // argv of every entry is one synthetic line, judged again in each name
    // reading (three for these lines), where `echo x >`'s plain names are
    // judged once for the call (test 3's split, which does not carry over to
    // an argv: there a name's place decides what it is). So these lines read
    // 17 to 50 times their control on main, against test 3's 18. The ratio is
    // printed with each line, and the bound returns with the argv-line split
    // (owed: PRIORITIES, the argv-line split).
    const run = "[".repeat(2_000);
    const plain = "a".repeat(2_000);
    /** Each line over its bound, named with its figures, asserted at the end. */
    const over: string[] = [];
    /** The lines held to their bound: every line but the three PRINT_ONLY names. */
    let asserted = 0;
    const lines: Array<[string, (word: string) => string]> = [
      ["cp, destination", (word) => `cp README.md ${word}`],
      ["cp, source", (word) => `cp ${word} out.txt`],
      ["mv, destination", (word) => `mv README.md ${word}`],
      ["mv, source", (word) => `mv ${word} out.txt`],
    ];
    const printOnly = (shape: string, prefix: string, length: number): boolean => PRINT_ONLY.includes(`${prefix === "" ? "" : `${prefix} `}${shape} ${String(length)}`);
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
        const held = !printOnly(shape, prefix, 2_000);
        const label = `${command.slice(0, 30)} (2000 characters): median ${spent.toFixed(1)} CPU ms of ${(BOUND_MS * 2).toFixed(1)}, control ${controlMs.toFixed(1)}, ratio ${ratio.toFixed(2)} (no ratio bound: PRIORITIES argv-line split)${held ? "" : ` ${PRINTED}`}`;
        t.diagnostic(`cost: ${label}`);
        if (held) asserted += 1;
        if (held && !(spent < BOUND_MS * 2)) over.push(label);
      }
    }
    // Test 3's 20,000-character run, one call each: past the longest path the
    // kernel opens, so each landing is guarded unread.
    for (const prefix of ["", "~/.hermes/"]) {
      for (const [shape, line] of lines) {
        const command = line(`${prefix}${"[".repeat(20_000)}`);
        const ms = cpuMs(() => {
          classifyForHook(command, [], dir, [], false, [dir]);
        });
        const held = !printOnly(shape, prefix, 20_000);
        if (held) asserted += 1;
        if (held) report(t, `${command.slice(0, 30)} (20000 characters)`, ms, BOUND_MS * 2);
        else t.diagnostic(`cost: ${command.slice(0, 30)} (20000 characters): ${ms.toFixed(1)} CPU ms ${PRINTED}`);
        if (held && !(ms < BOUND_MS * 2)) over.push(`${command.slice(0, 30)} (20000 characters): ${ms.toFixed(1)} CPU ms, bound ${String(BOUND_MS * 2)}`);
      }
    }
    // Every line is measured and printed before any is held to its bound, so
    // one run (a CI shard) reads them all.
    assert.deepEqual(over, [], `over the bound:\n${over.join("\n")}`);
    // Each PRINT_ONLY name took exactly one of the sixteen lines off the assert.
    assert.equal(asserted, 13);
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
  }
});

test("cost: test 4 prints only the three lines the lead ruled off the assert, two by CLAIMS L63667 and one by L63680", () => {
  // The list cannot grow unseen: a line taken off the assert is a ruling, and
  // each of these returns to it with the argv-line split.
  assert.deepEqual([...PRINT_ONLY], ["cp, source 2000", "cp, destination 2000", "~/.hermes/ cp, source 20000"]);
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
