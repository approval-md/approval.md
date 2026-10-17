/**
 * `git push` spellings against the real git (APRV-517).
 *
 * The classifier reads a `git push` argv through git 2.50's option grammar
 * (src/core/git-push-argv.ts). That grammar is a claim about somebody else's
 * parser, so this file asks the parser. Two halves:
 *
 * 1. **Every deleting spelling deletes.** Each spelling the APRV-648 refutation
 *    (finding S2) and this task name is run against a bare local remote, and
 *    the test asserts the remote branch is gone afterwards AND that the
 *    classifier answers it at least as strictly as `vcs.ref.delete`. A
 *    spelling git does not treat as a deletion (`-dn` is a dry run, `-od`
 *    sends a push option called `d`) is pinned as such, so the oracle is seen
 *    telling the two apart.
 *
 * 2. **A generated differential.** Argvs built from every long-option prefix
 *    and negation, every short bundle of the effectful letters, and a set of
 *    refspec shapes run against the same remote. For every argv the classifier
 *    ADMITS (anything but a refusal), the effect git had on the remote must be
 *    one the class covers: a removed branch needs `vcs.ref.delete` or
 *    stricter, a non-fast-forward update needs `vcs.history.rewrite`, a tag
 *    change needs `release.publish` or stricter, and an update of `main`
 *    needs `vcs.push.main` or stricter. The default run takes a fixed sample;
 *    `APPROVAL_DIFF_GIT_FULL=1` runs the whole corpus (about 6,000 pushes).
 *
 * The remote is a local bare repository under the system temp directory; no
 * network, no credentials, and a scrubbed environment (`HOME` is a scratch
 * directory and system configuration is off), so the operator's own git
 * configuration cannot change what a spelling does. The file skips when no
 * git binary is found.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { classifyCommand } from "../src/core/command-class.js";
import { GIT_PUSH_OPTIONS } from "../src/core/git-push-argv.js";

const work = mkdtempSync(join(tmpdir(), "approval-md-push-"));
after(() => rmSync(work, { recursive: true, force: true }));

const HOME = join(work, "home");
mkdirSync(HOME);
writeFileSync(
  join(HOME, ".gitconfig"),
  [
    "[user]",
    "\tname = Push Oracle",
    "\temail = oracle@example.invalid",
    "[init]",
    "\tdefaultBranch = main",
    "[advice]",
    "\tpushUpdateRejected = false",
    "",
  ].join("\n"),
);

const ENV: NodeJS.ProcessEnv = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  HOME,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: readonly string[], input?: string): Ran {
  const result = spawnSync("git", args, { cwd, env: ENV, encoding: "utf8", timeout: 20_000, input });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The same, without blocking: the differential runs several fixtures at once. */
function gitAsync(cwd: string, args: readonly string[], input?: string): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, env: ENV, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(input ?? "");
  });
}

function ok(cwd: string, args: readonly string[]): string {
  const ran = git(cwd, args);
  assert.equal(ran.status, 0, `git ${args.join(" ")}: ${ran.stderr}`);
  return ran.stdout.trim();
}

const GIT_VERSION = (() => {
  const ran = spawnSync("git", ["--version"], { env: ENV, encoding: "utf8" });
  return ran.status === 0 ? ran.stdout.trim() : null;
})();

// ---------------------------------------------------------------------------
// The fixture: a bare remote and a clone whose refs disagree with it
// ---------------------------------------------------------------------------

/**
 * Remote: `main` at c0, `lane` at r1 (diverged from the clone's `lane`),
 * `stale` (no local counterpart), tag `vold`. Clone: `main` at m1 (one commit
 * ahead, so pushing it is a fast-forward of the trunk), `lane` at l1 (not a
 * descendant of r1, so only a forced push moves it), HEAD on `lane`.
 */
interface Fixture {
  remote: string;
  clone: string;
  refs: Map<string, string>;
  localRefs: string;
  config: string;
}

function parseRefs(out: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of out.split("\n")) {
    const [ref, sha] = line.split(" ");
    if (ref !== undefined && sha !== undefined && ref !== "") refs.set(ref, sha);
  }
  return refs;
}

function refsOf(dir: string): Map<string, string> {
  return parseRefs(git(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]).stdout);
}

async function refsOfAsync(dir: string): Promise<Map<string, string>> {
  return parseRefs((await gitAsync(dir, ["for-each-ref", "--format=%(refname) %(objectname)"])).stdout);
}

function makeFixture(name: string): Fixture {
  const root = join(work, name);
  const remote = join(root, "remote.git");
  const clone = join(root, "clone");
  mkdirSync(root);
  ok(root, ["init", "-q", "--bare", remote]);
  ok(remote, ["config", "receive.advertisePushOptions", "true"]);
  // A bare remote refuses to delete the branch its HEAD names unless told
  // otherwise; GitHub's equivalent is the default-branch setting, which is
  // not what is under test. The client side of a trunk deletion is.
  ok(remote, ["config", "receive.denyDeleteCurrent", "ignore"]);
  ok(root, ["init", "-q", clone]);
  ok(clone, ["remote", "add", "origin", remote]);
  ok(clone, ["commit", "-q", "--allow-empty", "-m", "c0"]);
  ok(clone, ["push", "-q", "origin", "main"]);
  ok(clone, ["push", "-q", "origin", "main:refs/heads/stale"]);
  ok(clone, ["tag", "vold"]);
  ok(clone, ["push", "-q", "origin", "refs/tags/vold"]);
  ok(clone, ["tag", "-d", "vold"]);
  ok(clone, ["checkout", "-q", "-b", "remote-lane"]);
  ok(clone, ["commit", "-q", "--allow-empty", "-m", "r1"]);
  ok(clone, ["push", "-q", "origin", "remote-lane:refs/heads/lane"]);
  ok(clone, ["checkout", "-q", "main"]);
  ok(clone, ["branch", "-q", "-D", "remote-lane"]);
  ok(clone, ["commit", "-q", "--allow-empty", "-m", "m1"]);
  ok(clone, ["checkout", "-q", "-b", "lane", "HEAD~1"]);
  ok(clone, ["commit", "-q", "--allow-empty", "-m", "l1"]);
  ok(clone, ["fetch", "-q", "origin"]);
  ok(clone, ["branch", "-q", "-u", "origin/lane", "lane"]);
  const config = join(root, "clone.config");
  copyFileSync(join(clone, ".git", "config"), config);
  return {
    remote,
    clone,
    refs: refsOf(remote),
    // Symbolic refs (`refs/remotes/origin/HEAD`) are left alone: they follow their target.
    localRefs: git(clone, ["for-each-ref", "--format=%(if)%(symref)%(then)%(else)update %(refname) %(objectname)%(end)", "refs/remotes"])
      .stdout.split("\n")
      .filter((line) => line.trim() !== "")
      .join("\n")
      .concat("\n"),
    config,
  };
}

/** Put the remote's refs and the clone's configuration back as the fixture made them. */
async function restore(fixture: Fixture): Promise<void> {
  const now = await refsOfAsync(fixture.remote);
  const lines: string[] = [];
  for (const [ref, sha] of fixture.refs) lines.push(`update ${ref} ${sha}`);
  for (const ref of now.keys()) if (!fixture.refs.has(ref)) lines.push(`delete ${ref}`);
  const ran = await gitAsync(fixture.remote, ["update-ref", "--stdin"], `${lines.join("\n")}\n`);
  assert.equal(ran.status, 0, ran.stderr);
  copyFileSync(fixture.config, join(fixture.clone, ".git", "config"));
  const tracking = await gitAsync(fixture.clone, ["update-ref", "--stdin"], fixture.localRefs);
  assert.equal(tracking.status, 0, tracking.stderr);
}

interface Effect {
  removed: string[];
  forced: string[];
  trunk: boolean;
  tags: boolean;
}

async function push(fixture: Fixture, argv: readonly string[]): Promise<{ ran: Ran; effect: Effect }> {
  await restore(fixture);
  const ran = await gitAsync(fixture.clone, ["push", ...argv]);
  const after = await refsOfAsync(fixture.remote);
  const effect: Effect = { removed: [], forced: [], trunk: false, tags: false };
  for (const [ref, sha] of fixture.refs) {
    const now = after.get(ref);
    if (ref.startsWith("refs/tags/")) {
      if (now !== sha) effect.tags = true;
      continue;
    }
    if (now === undefined) {
      effect.removed.push(ref);
      continue;
    }
    if (now === sha) continue;
    if (ref === "refs/heads/main") effect.trunk = true;
    const ff = await gitAsync(fixture.remote, ["merge-base", "--is-ancestor", sha, now]);
    if (ff.status !== 0) effect.forced.push(ref);
  }
  for (const ref of after.keys()) {
    if (fixture.refs.has(ref)) continue;
    if (ref.startsWith("refs/tags/")) effect.tags = true;
    if (ref === "refs/heads/main") effect.trunk = true;
  }
  return { ran, effect };
}

// ---------------------------------------------------------------------------
// What the classifier says, as a rank: lower is stricter
// ---------------------------------------------------------------------------

const RANK: Record<string, number> = {
  "vcs.history.rewrite": 1,
  "release.publish": 2,
  "vcs.ref.delete": 3,
  "vcs.push.main": 4,
  "vcs.push.branch": 5,
};

/** 0 for a refusal; otherwise the class's place in the `git push` order. */
function rankOf(command: string): { rank: number; label: string } {
  const result = classifyCommand(command);
  if (!result.ok) return { rank: 0, label: `refused:${result.code}` };
  assert.equal(result.segments.length, 1, command);
  const segment = result.segments[0] as { class: string; rule: string };
  const rank = RANK[segment.class];
  assert.notEqual(rank, undefined, `${command} classified outside the push classes: ${segment.class}`);
  return { rank: rank as number, label: `${segment.class}/${segment.rule}` };
}

function needed(effect: Effect): number {
  if (effect.forced.length > 0) return RANK["vcs.history.rewrite"] as number;
  if (effect.tags) return RANK["release.publish"] as number;
  if (effect.removed.length > 0) return RANK["vcs.ref.delete"] as number;
  if (effect.trunk) return RANK["vcs.push.main"] as number;
  return RANK["vcs.push.branch"] as number;
}

/** Quote a word for the classifier's shell text; the corpus has no quotes in it. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./^~-]+$/u.test(word) ? word : `'${word}'`;
}

function commandOf(argv: readonly string[]): string {
  return ["git", "push", ...argv.map(shellWord)].join(" ");
}

// ---------------------------------------------------------------------------
// 1. Every deleting spelling deletes, and is classified as a deletion
// ---------------------------------------------------------------------------

/** argv after `push`, and the remote branch it removes. */
const DELETING: readonly (readonly [readonly string[], string])[] = [
  // The S2 four, against a branch and against the trunk.
  [["-ud", "origin", "lane"], "lane"],
  [["-du", "origin", "lane"], "lane"],
  [["--del", "origin", "lane"], "lane"],
  [["--de", "origin", "lane"], "lane"],
  [["-ud", "origin", "main"], "main"],
  [["--del", "origin", "main"], "main"],
  // Every other abbreviation of --delete, and the spelled-out forms.
  [["--dele", "origin", "lane"], "lane"],
  [["--delet", "origin", "lane"], "lane"],
  [["--delete", "origin", "lane"], "lane"],
  [["-d", "origin", "lane"], "lane"],
  [["origin", "--del", "lane"], "lane"],
  // Other bundles carrying d.
  [["-fd", "origin", "lane"], "lane"],
  [["-df", "origin", "lane"], "lane"],
  [["-qd", "origin", "lane"], "lane"],
  [["-dv", "origin", "lane"], "lane"],
  [["-4d", "origin", "lane"], "lane"],
  [["-duq", "origin", "lane"], "lane"],
  [["-dofoo", "origin", "lane"], "lane"],
  [["-do", "foo", "origin", "lane"], "lane"],
  [["-o", "foo", "-d", "origin", "lane"], "lane"],
  [["--repo", "origin", "--de", "origin", "lane"], "lane"],
  // Refspecs with an empty source.
  [["origin", ":lane"], "lane"],
  [["origin", "+:lane"], "lane"],
  [["origin", ":refs/heads/lane"], "lane"],
  [["origin", "+:refs/heads/lane"], "lane"],
  [["origin", "lane:lane", ":stale"], "stale"],
  // --prune and --mirror, and their abbreviations: `stale` has no local counterpart.
  [["--prune", "origin", "refs/heads/*:refs/heads/*"], "stale"],
  [["--pru", "origin", "refs/heads/*:refs/heads/*"], "stale"],
  [["--prun", "origin", "refs/heads/*:refs/heads/*"], "stale"],
  [["--prune", "--all", "origin"], "stale"],
  [["--prune", "--branches", "origin"], "stale"],
  [["--pru", "--al", "origin"], "stale"],
  [["--mirror", "origin"], "stale"],
  [["--mirr", "origin"], "stale"],
  [["--m", "origin"], "stale"],
  // After `--`, a refspec is a refspec.
  [["--", "origin", ":lane"], "lane"],
  [["--end-of-options", "origin", ":lane"], "lane"],
];

/** Spellings that LOOK like deletions and are not; the classifier may still be stricter. */
const NOT_DELETING: readonly (readonly string[])[] = [
  ["-dn", "origin", "lane"],
  ["-nd", "origin", "lane"],
  ["--del", "--dry-run", "origin", "lane"],
  ["-od", "origin", "main"],
  ["--no-delete", "origin", "main"],
  ["--prune", "origin", "main"],
];

const fixture = GIT_VERSION === null ? null : makeFixture("spellings");

for (const [argv, branch] of DELETING) {
  const command = commandOf(argv);
  test(`deletes on ${GIT_VERSION ?? "no git"}: ${command}`, async (t) => {
    if (fixture === null) return t.skip("no git binary found");
    const { ran, effect } = await push(fixture, argv);
    assert.ok(
      effect.removed.includes(`refs/heads/${branch}`),
      `${command} should remove ${branch}; removed ${JSON.stringify(effect.removed)} (exit ${ran.status}): ${ran.stderr}`,
    );
    const { rank, label } = rankOf(command);
    assert.ok(rank <= (RANK["vcs.ref.delete"] as number), `${command} removed ${branch} but classified ${label}`);
  });
}

for (const argv of NOT_DELETING) {
  const command = commandOf(argv);
  test(`does not delete: ${command}`, async (t) => {
    if (fixture === null) return t.skip("no git binary found");
    const { effect } = await push(fixture, argv);
    assert.deepEqual(effect.removed, [], `${command} removed ${JSON.stringify(effect.removed)}`);
  });
}

test("the S2 spellings are vcs.ref.delete with the ref bound, not a plain push", () => {
  for (const [argv, branch] of [
    [["-ud", "origin", "lane"], "lane"],
    [["-du", "origin", "lane"], "lane"],
    [["--del", "origin", "lane"], "lane"],
    [["--de", "origin", "lane"], "lane"],
    [["-ud", "origin", "main"], "main"],
    [["--del", "origin", "main"], "main"],
  ] as const) {
    const result = classifyCommand(commandOf(argv));
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.deepEqual(
      result.segments.map((segment) => [segment.class, segment.rule, segment.path]),
      [["vcs.ref.delete", "git-ref-delete", branch]],
      commandOf(argv),
    );
  }
});

// ---------------------------------------------------------------------------
// 2. The generated differential
// ---------------------------------------------------------------------------

/** Every prefix of `name`, shortest first. */
function prefixes(name: string): string[] {
  return Array.from({ length: name.length }, (_, at) => name.slice(0, at + 1));
}

/** The option spellings: every long prefix, positive and negated, and short bundles. */
function optionSpellings(): string[][] {
  const spellings = new Set<string>();
  for (const option of GIT_PUSH_OPTIONS) {
    const long = option.long.startsWith("no-") ? option.long.slice(3) : option.long;
    for (const prefix of prefixes(long)) {
      spellings.add(`--${prefix}`);
      if (option.noneg !== true) spellings.add(`--no-${prefix}`);
    }
    if (option.long.startsWith("no-")) for (const prefix of prefixes(option.long)) spellings.add(`--${prefix}`);
  }
  for (const word of ["--n", "--no", "--no-", "--force-with-lease=lane", "--force-with-lease=lane:main", "--signed=no", "--recurse-submodules=no", "--recurse-submodules=check", "--de=1", "--help", "-h"]) {
    spellings.add(word);
  }
  const letters = ["d", "f", "u", "n", "q", "v", "o", "4", "6", "x"];
  for (const a of letters) {
    spellings.add(`-${a}`);
    for (const b of letters) {
      spellings.add(`-${a}${b}`);
      if (["d", "f", "u", "n", "o"].includes(a) && ["d", "f", "u", "n", "o"].includes(b)) {
        for (const c of ["d", "f", "u", "n", "o"]) spellings.add(`-${a}${b}${c}`);
      }
    }
  }
  return [...spellings].map((word) => [word]);
}

/** Refspec shapes after the remote. */
const TAILS: readonly (readonly string[])[] = [
  ["origin", "lane"],
  ["origin", "main"],
  ["origin", ":lane"],
  ["origin", "+lane"],
  ["origin"],
  [],
];

function corpus(): string[][] {
  const argvs: string[][] = [];
  for (const option of optionSpellings()) {
    for (const tail of TAILS) {
      argvs.push([...option, ...tail]);
      if (tail.length > 0) argvs.push([...tail, ...option]);
    }
  }
  // Pairs that interact: a value-taking option in front of a deleting one.
  for (const first of [["-o", "x"], ["--repo", "origin"], ["--push-option=x"], ["-ox"], ["-n"], ["--no-delete"]]) {
    for (const second of [["-d"], ["--de"], ["-ud"], ["--prune"], ["-f"], ["--m"]]) {
      argvs.push([...first, ...second, "origin", "lane"]);
      argvs.push(["origin", ...first, ...second, "lane"]);
    }
  }
  return argvs;
}

/** Fixtures the differential runs side by side; each takes every Nth argv. */
const LANES = 8;

test("generated differential: every admitted argv is classified at least as strictly as its effect", async (t) => {
  if (GIT_VERSION === null) return t.skip("no git binary found");
  const all = corpus();
  const full = process.env["APPROVAL_DIFF_GIT_FULL"] === "1";
  // A fixed stride, so the default run is the same sample every time.
  const sample = full ? all : all.filter((_, at) => at % 96 === 0);
  const failures: string[] = [];
  let admitted = 0;
  let effectful = 0;
  const lanes = Array.from({ length: LANES }, (_, lane) => makeFixture(`differential-${lane}`));
  await Promise.all(
    lanes.map(async (lane, index) => {
      for (let at = index; at < sample.length; at += LANES) {
        const argv = sample[at] as string[];
        const command = commandOf(argv);
        const { rank, label } = rankOf(command);
        if (rank === 0) continue;
        admitted += 1;
        const { ran, effect } = await push(lane, argv);
        const need = needed(effect);
        if (need < (RANK["vcs.push.branch"] as number)) effectful += 1;
        if (rank > need) {
          failures.push(`${command}: classified ${label}, git (exit ${ran.status}) ${JSON.stringify(effect)}`);
        }
      }
    }),
  );
  t.diagnostic(
    `${GIT_VERSION}: ${sample.length} of ${all.length} argvs, ${admitted} admitted and run, ${effectful} with a non-branch effect`,
  );
  assert.deepEqual(failures.sort(), []);
  assert.ok(effectful > 0, "the oracle saw no deletion, force or trunk update at all");
});
