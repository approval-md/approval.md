/**
 * The history-rewrite split in the hook (amended SPEC.md §7, APRV-433; it
 * replaces APRV-108's downgrade).
 *
 * The refinement is impure by design: it asks git about the checkout the hook
 * runs in. So every case here builds a REAL repository, with a bare origin, and
 * runs the real compiled CLI inside it. No git output is stubbed: a stub would
 * be a second opinion about what `git for-each-ref` prints, which is exactly
 * the fact under test. Rebases that leave a rebase in progress are real too,
 * and run only inside these throwaway repositories under the test scratch.
 *
 * `hook classify --json` is the probe for the classification table (spec
 * section 7.1), because it runs the same refinement in the same directory and
 * writes nothing. The hook's own verdicts, and what the log gains, are the
 * evidence cases (section 7.3) at the bottom.
 *
 * Git is isolated from the machine's own configuration (`GIT_CONFIG_GLOBAL`
 * names an empty file, `GIT_CONFIG_NOSYSTEM=1`), because a `pull.rebase` or a
 * hooks path in someone's `~/.gitconfig` would change what a bare `git pull`
 * is.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyCommand } from "../src/core/command-class.js";
import { register, request } from "../src/core/gate.js";
import { refineHistoryRewrite } from "../src/cli/history-rewrite.js";
import { classifyForHook } from "../src/cli/hook.js";

/** dist/tests/cli-hook-rewrite.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-hook-rewrite-")));
let counter = 0;
const EMPTY_GITCONFIG = join(scratch, "gitconfig-empty");
writeFileSync(EMPTY_GITCONFIG, "", "utf8");

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// The in-process probes below run the hook's own `classifyForHook`, whose git
// children inherit THIS process's environment (through `childEnvironment`).
// `node --test` runs each file in its own process, so isolating it here
// touches no other suite.
process.env["GIT_CONFIG_GLOBAL"] = EMPTY_GITCONFIG;
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
delete process.env["GIT_DIR"];
delete process.env["GIT_WORK_TREE"];

/** The environment every git and CLI child of this file runs under. */
function isolatedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
  delete env["APPROVAL_HUMAN"];
  delete env["GIT_DIR"];
  delete env["GIT_WORK_TREE"];
  return env;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input = "", extra: Record<string, string> = {}): Run {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: isolatedEnv(extra),
    input,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function policyText(lines: readonly string[]): string {
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    '  approval_ttl: "1h"',
    "  on_expiry: reject",
    "classes:",
    "  read.*:",
    "    autonomy: autonomous",
    "  files.write.workspace:",
    "    autonomy: autonomous",
    "  vcs.commit.branch:",
    "    autonomy: autonomous",
    "  vcs.push.branch:",
    "    autonomy: autonomous",
    "  vcs.push.main:",
    "    autonomy: supervised",
    ...lines,
    "```",
    "",
  ].join("\n");
}

/** This repository's lines as of 801684f9: no own line of the split. */
const THIS_REPO = policyText(["  vcs.history.rewrite:", "    autonomy: human-only"]);
/** P3: line 50 plus `.local: autonomous`. */
const LOCAL_AUTONOMOUS = policyText([
  "  vcs.history.rewrite:",
  "    autonomy: human-only",
  "  vcs.history.rewrite.local:",
  "    autonomy: autonomous",
]);
/** The three lines the spec proposes for this repository. */
const PROPOSED = policyText([
  "  vcs.history.rewrite:",
  "    autonomy: human-only",
  "  vcs.history.rewrite.shared:",
  "    autonomy: human-only",
  "  vcs.history.rewrite.local:",
  "    autonomy: autonomous",
]);
/** E2: a shared rewrite needs a human's grant. */
const SHARED_MANUAL = policyText([
  "  vcs.history.rewrite:",
  "    autonomy: human-only",
  "  vcs.history.rewrite.shared:",
  "    autonomy: manual",
  "  vcs.history.rewrite.local:",
  "    autonomy: manual",
]);
/** E5: both members autonomous, so the verdict names whichever member was derived. */
const BOTH_AUTONOMOUS = policyText([
  "  vcs.history.rewrite.*:",
  "    autonomy: autonomous",
  "  vcs.history.rewrite.shared:",
  "    autonomy: autonomous",
]);

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: isolatedEnv() });
  assert.equal(result.error, undefined, `git ${args.join(" ")}: ${String(result.error)}`);
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A git command expected to stop (a conflicting rebase). */
function gitMayFail(cwd: string, ...args: string[]): number {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: isolatedEnv() });
  assert.equal(result.error, undefined, `git ${args.join(" ")}: ${String(result.error)}`);
  return result.status ?? -1;
}

function nextDir(prefix: string): string {
  counter += 1;
  const dir = join(scratch, `${prefix}-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A repository on `main` with one commit, a bare origin, and `main` pushed with
 * its upstream set. `refs/remotes/origin/HEAD` is NOT set (a push does not set
 * it), so `main` and `master` are the only default branches unless a case says
 * otherwise. The policy file sits in the work tree, untracked.
 */
function newRepo(policy = THIS_REPO, mainCommits = 1): string {
  const dir = nextDir("repo");
  writeFileSync(join(dir, "APPROVAL.md"), policy, "utf8");
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  for (let index = 1; index <= mainCommits; index += 1) commit(dir, `m${String(index)}`);
  const remote = nextDir("origin");
  git(remote, "init", "--quiet", "--bare");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "--quiet", "--set-upstream", "origin", "main");
  return dir;
}

/** One commit that adds `<name>.txt`; returns its id. */
function commit(dir: string, name: string, content = `${name}\n`, file = `${name}.txt`): string {
  writeFileSync(join(dir, file), content, "utf8");
  git(dir, "add", file);
  git(dir, "commit", "--quiet", "-m", name);
  return git(dir, "rev-parse", "HEAD");
}

/** A new branch with NO upstream, whatever it starts from. */
function branch(dir: string, name: string, from = "HEAD"): void {
  git(dir, "checkout", "--quiet", "--no-track", "-b", name, from);
}

function pushUpstream(dir: string, name: string): void {
  git(dir, "push", "--quiet", "--set-upstream", "origin", name);
}

interface Evidence {
  reach: string;
  basis: string;
  ref: string | null;
  old_tip: string | null;
  base: string | null;
  lost: number | null;
  lost_shared: number | null;
  witness: string | null;
  legacy_class: string;
}

interface Probe {
  class: string;
  rule: string;
  history_rewrite?: Evidence;
}

interface Classified {
  ok: boolean;
  code?: string;
  segments?: Probe[];
  classes?: string[];
}

/**
 * What the hook's classification makes of `command` in `dir`: in process, the
 * same `classifyForHook` that `hook classify` and `hook claude-code` both call
 * (E5 below checks the CLI against the verdict end to end). In process because
 * a CLI spawn per probe made this file cost minutes.
 */
function classifyAll(dir: string, command: string): Classified {
  return JSON.parse(JSON.stringify(classifyForHook(command, [], dir).result)) as Classified;
}

/** The same question through the real `hook classify --json` CLI. */
function classifyCli(dir: string, command: string): Classified {
  const run = runCli(["hook", "classify", "--json", "--", command], dir);
  assert.equal(run.code, 0, run.stderr);
  return JSON.parse(run.stdout) as Classified;
}

function probe(dir: string, command: string, index = 0): Probe {
  const parsed = classifyAll(dir, command);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  const segment = parsed.segments?.[index];
  assert.ok(segment !== undefined, `segment ${String(index)} of ${command}`);
  return segment;
}

const LOCAL = "vcs.history.rewrite.local";
const SHARED = "vcs.history.rewrite.shared";
const BARE = "vcs.history.rewrite";
const BRANCH = "vcs.commit.branch";

/** Assert a refined segment's member, basis and pre-split class; returns its evidence. */
function assertMember(
  dir: string,
  command: string,
  member: "local" | "shared",
  basis: string,
  legacy: string,
  index = 0,
): Evidence {
  const segment = probe(dir, command, index);
  assert.notEqual(segment.class, BARE, "no hook-path segment leaves the refinement as the bare class");
  assert.equal(segment.class, member === "local" ? LOCAL : SHARED, `${command}: ${JSON.stringify(segment)}`);
  const evidence = segment.history_rewrite;
  assert.ok(evidence !== undefined, `${command} carries history_rewrite`);
  assert.equal(evidence.reach, member, command);
  assert.equal(evidence.basis, basis, `${command}: ${JSON.stringify(evidence)}`);
  assert.equal(evidence.legacy_class, legacy, `${command}: legacy ${JSON.stringify(evidence)}`);
  return evidence;
}

/**
 * Assert the classifier refuses the line before any judge sees it (APRV-521:
 * an assignment off its closed list in front of git is `unclassified`).
 */
function assertUnclassified(dir: string, command: string): void {
  const parsed = classifyAll(dir, command);
  assert.equal(parsed.ok, false, `${command}: ${JSON.stringify(parsed)}`);
  assert.equal(parsed.code, "unclassified", `${command}: ${JSON.stringify(parsed)}`);
}

/** Assert a segment is outside the family and carries no evidence. */
function assertUnrefined(dir: string, command: string, cls: string, index = 0): void {
  const segment = probe(dir, command, index);
  assert.equal(segment.class, cls, `${command}: ${JSON.stringify(segment)}`);
  assert.equal(segment.history_rewrite, undefined, command);
}

// ---------------------------------------------------------------------------
// 7.1 Classification: commit --amend (cases 1 to 6)
// ---------------------------------------------------------------------------

test("cases 1-4: an amend is local exactly when HEAD is on no shared ref", () => {
  const dir = newRepo();
  branch(dir, "lane");
  commit(dir, "l1");
  // 1: no upstream, HEAD on no shared ref.
  const one = assertMember(dir, "git commit --amend --no-edit", "local", "range-unpublished", BRANCH);
  assert.equal(one.ref, "refs/heads/lane");
  assert.equal(one.lost, 1);
  assert.equal(one.lost_shared, 0);
  assert.equal(one.witness, null);
  assert.match(one.old_tip ?? "", /^[0-9a-f]{40}$/u);

  // 3: lane at origin/lane.
  pushUpstream(dir, "lane");
  const three = assertMember(dir, "git commit --amend", "shared", "shared-commit", BARE);
  assert.equal(three.witness, "refs/remotes/origin/lane");
  assert.equal(three.lost_shared, 1);

  // 2: one commit ahead of origin/lane (the Q3 reading: an unpushed HEAD stays local).
  commit(dir, "l2");
  assertMember(dir, "git commit --amend", "local", "range-unpublished", BRANCH);

  // 4: no upstream, no new commits: HEAD is origin/main. A tightening against
  // APRV-108, which downgraded it.
  branch(dir, "fresh", "origin/main");
  const four = assertMember(dir, "git commit --amend", "shared", "shared-commit", BRANCH);
  // Either remote-tracking ref holds the commit; a remote copy is preferred over refs/heads/main.
  assert.match(four.witness ?? "", /^refs\/remotes\/origin\/(?:main|lane)$/u);
});

test("cases 5-6: an amend on a default branch is shared, by name and by origin/HEAD", () => {
  const dir = newRepo();
  commit(dir, "m2");
  // 5: main, HEAD unpushed.
  assertMember(dir, "git commit --amend", "shared", "default-branch", BARE);
  // 6: develop, with refs/remotes/origin/HEAD naming it.
  branch(dir, "develop");
  pushUpstream(dir, "develop");
  git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
  commit(dir, "d1");
  assertMember(dir, "git commit --amend", "shared", "default-branch", BARE);
});

// ---------------------------------------------------------------------------
// reset --hard (cases 7 to 11, 32)
// ---------------------------------------------------------------------------

test("cases 7-11: reset --hard is judged on the commits it removes", () => {
  const dir = newRepo();
  branch(dir, "lane");
  commit(dir, "l1");
  commit(dir, "l2");
  commit(dir, "l3");
  // 7: no upstream, three local commits.
  const seven = assertMember(dir, "git reset --hard origin/main", "local", "range-unpublished", BRANCH);
  assert.equal(seven.lost, 3);
  // 11: a target the text cannot read.
  assertMember(dir, 'git reset --hard "$REV"', "shared", "unreadable-target", BRANCH);

  pushUpstream(dir, "lane");
  // 10: fully pushed, nothing removed.
  assertMember(dir, "git reset --hard", "local", "no-commits-lost", BARE);
  commit(dir, "l4");
  commit(dir, "l5");
  // 8: two unpushed on top of the upstream (newly opened). Quoted: an
  // unquoted `~` is not `LexWord.exact`, so `HEAD~2` bare is shared (APRV-648 S1).
  assertMember(dir, "git reset --hard 'HEAD~2'", "local", "range-unpublished", BARE);
  assertMember(dir, "git reset --hard HEAD~2", "shared", "unreadable-target", BARE);
  // 9: the third is pushed.
  const nine = assertMember(dir, "git reset --hard 'HEAD~3'", "shared", "shared-commit", BARE);
  assert.equal(nine.lost, 3);
  assert.equal(nine.lost_shared, 1);
  assert.equal(nine.witness, "refs/remotes/origin/lane");
});

test("case 32: a lost range over the cap is shared, range-too-large", () => {
  const dir = newRepo();
  branch(dir, "lane");
  // 1001 commits in one fast-import process rather than 1001 spawns.
  const lines: string[] = [];
  for (let index = 1; index <= 1001; index += 1) {
    lines.push("commit refs/heads/lane", `committer T <t@example.com> ${String(1_700_000_000 + index)} +0000`, "data 1", "c");
    if (index === 1) lines.push("from refs/heads/main^0");
    lines.push("");
  }
  const imported = spawnSync("git", ["fast-import", "--quiet", "--force"], {
    cwd: dir,
    encoding: "utf8",
    env: isolatedEnv(),
    input: `${lines.join("\n")}\n`,
  });
  assert.equal(imported.status, 0, imported.stderr);
  git(dir, "reset", "--quiet", "--hard", "refs/heads/lane");
  const evidence = assertMember(dir, "git reset --hard origin/main", "shared", "range-too-large", BRANCH);
  assert.equal(evidence.lost, null);
});

// ---------------------------------------------------------------------------
// rebase (cases 12 to 21, 30, 31, 33)
// ---------------------------------------------------------------------------

test("cases 12-14: a plain rebase is local exactly when its range is unpublished", () => {
  const dir = newRepo();
  branch(dir, "lane");
  commit(dir, "l1");
  // 12: no upstream, branched from origin/main.
  assertMember(dir, "git rebase origin/main", "local", "range-unpublished", BRANCH);
  // 19: --autosquash without -i opens no editor.
  assertMember(dir, "git rebase --autosquash origin/main", "local", "range-unpublished", BRANCH);
  // 13: pushed: the pushed restack stays human-only, use a merge.
  pushUpstream(dir, "lane");
  assertMember(dir, "git rebase origin/main", "shared", "shared-commit", BARE);

  // 14: two unpushed, and origin/lane moved on (someone else's fast-forward).
  const published = git(dir, "rev-parse", "HEAD");
  commit(dir, "l2");
  commit(dir, "l3");
  git(dir, "branch", "other", published);
  git(dir, "checkout", "--quiet", "other");
  commit(dir, "o1");
  git(dir, "push", "--quiet", "origin", "other:lane");
  git(dir, "checkout", "--quiet", "lane");
  git(dir, "fetch", "--quiet", "origin");
  const fourteen = assertMember(dir, "git rebase origin/lane", "local", "range-unpublished", BARE);
  assert.equal(fourteen.lost, 2);
});

test("cases 15-16 (APRV-648 fix round 3): --onto takes a value, so it is shared, option-unvetted", () => {
  // Before fix round 3 case 15 was local (the union base of C4). The closed
  // rule shares every option that takes a value, --onto included, rather than
  // model it.
  const dir = newRepo(THIS_REPO, 7);
  branch(dir, "base");
  commit(dir, "b1");
  branch(dir, "lane");
  commit(dir, "l1");
  assertMember(dir, "git rebase --onto origin/main base lane", "shared", "option-unvetted", BRANCH);
  assertMember(dir, "git rebase --onto=origin/main base lane", "shared", "option-unvetted", BRANCH);
  git(dir, "checkout", "--quiet", "-B", "lane", "origin/main~3");
  assertMember(dir, "git rebase --onto origin/main origin/main~5 lane", "shared", "option-unvetted", BRANCH);
});

test("cases 17-21: interactive and command-running rebases are always shared", () => {
  const dir = newRepo();
  branch(dir, "lane");
  commit(dir, "l1");
  assertMember(dir, "git rebase -i origin/main", "shared", "interactive", BRANCH);
  // APRV-521: GIT_SEQUENCE_EDITOR is off the closed assignment list, so the
  // classifier refuses the line before the split is asked.
  assertUnclassified(dir, "GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash origin/main");
  assertMember(dir, 'git rebase --exec "npm test" origin/main', "shared", "runs-commands", BRANCH);
  assertMember(dir, "git rebase -s custom origin/main", "shared", "runs-commands", BRANCH);
  // A built-in strategy is still a value-taking option (fix round 3).
  assertMember(dir, "git rebase -s ort origin/main", "shared", "option-unvetted", BRANCH);
  assertMember(dir, "git rebase origin/main", "local", "range-unpublished", BRANCH);
});

test("cases 30, 31, 33: detached, gone upstream, and no repository are shared", () => {
  const dir = newRepo();
  branch(dir, "lane");
  commit(dir, "l1");
  // 31: pushed, then deleted on the remote and pruned.
  pushUpstream(dir, "lane");
  git(dir, "push", "--quiet", "origin", "--delete", "lane");
  git(dir, "fetch", "--quiet", "--prune", "origin");
  assertMember(dir, "git rebase origin/main", "shared", "upstream-gone", BARE);
  // 30: detached HEAD, no rebase state.
  git(dir, "checkout", "--quiet", "--detach", "HEAD");
  assertMember(dir, "git rebase main", "shared", "detached-head", BARE);
  // 33: not a repository.
  const bare = nextDir("not-a-repo");
  writeFileSync(join(bare, "APPROVAL.md"), THIS_REPO, "utf8");
  assertMember(bare, "git rebase main", "shared", "git-unavailable", BARE);
  assertMember(bare, "git commit --amend", "shared", "git-unavailable", BARE);
});

// ---------------------------------------------------------------------------
// A rebase in progress (cases 22 to 29): Lane B's case
// ---------------------------------------------------------------------------

/**
 * Leave a real rebase stopped on a conflict: `lane` changes `a.txt` one way and
 * `main` the other way, and `git rebase main` stops on the first pick with the
 * second still in the todo. `pushed` publishes `lane` first.
 */
function stoppedRebase(pushed: boolean, policy = THIS_REPO): string {
  const dir = newRepo(policy);
  commit(dir, "a", "base\n", "a.txt");
  git(dir, "push", "--quiet", "origin", "main");
  branch(dir, "lane");
  commit(dir, "l1", "lane\n", "a.txt");
  commit(dir, "l2");
  if (pushed) pushUpstream(dir, "lane");
  git(dir, "checkout", "--quiet", "main");
  commit(dir, "m2", "main\n", "a.txt");
  git(dir, "checkout", "--quiet", "lane");
  assert.notEqual(gitMayFail(dir, "rebase", "main"), 0, "the rebase stops on the conflict");
  assert.ok(existsSync(join(dir, ".git", "rebase-merge", "git-rebase-todo")));
  return dir;
}

// APRV-648 fix round 2, a deliberate departure from the D-6 spec text: a step
// that resumes a rebase in progress acts on state files under the git
// directory, which anything that can write the checkout can forge, and the
// check reads none of them. So `--continue`, `--skip`, `--abort` and `--quit`
// are shared, `unreadable-target`, on a real stop as much as on a forged one.
const RESUME_STEPS = ["git rebase --continue", "git rebase --skip", "git rebase --abort", "git rebase --quit"] as const;

/** Every resume step is shared and reads nothing from the rebase state. */
function assertResumeShared(dir: string, legacy: string): void {
  for (const command of RESUME_STEPS) {
    const evidence = assertMember(dir, command, "shared", "unreadable-target", legacy);
    assert.equal(evidence.ref, null, `${command}: no ref is read from the rebase state`);
    assert.equal(evidence.lost, null, `${command}: nothing is counted from the rebase state`);
  }
}

test("cases 22-29 (APRV-648 round 2): every resume step is shared, on a real stop pushed or not, and with no rebase in progress", () => {
  const unpushed = stoppedRebase(false);
  assertResumeShared(unpushed, BARE);
  assertResumeShared(stoppedRebase(true), BARE);
  // Lane B's add-then-continue: the earlier segment is allowed, the resume is not.
  assertMember(unpushed, "git add a.txt && git rebase --continue", "shared", "unreadable-target", BARE, 1);
  assertMember(unpushed, "git rebase --continue -q", "shared", "unreadable-target", BARE);
  // A todo carrying a command outside any vetted set.
  const exec = stoppedRebase(false);
  appendFileSync(join(exec, ".git", "rebase-merge", "git-rebase-todo"), "exec echo hi\n", "utf8");
  assertResumeShared(exec, BARE);
  // 29: no rebase in progress at all (HEAD on main).
  assertResumeShared(newRepo(), BARE);
  // An earlier segment that moves the cwd still names its own basis.
  assertMember(unpushed, "cd . && git rebase --abort", "shared", "compound-state", BARE, 1);
});

// ---------------------------------------------------------------------------
// Push side (cases 34 to 37)
// ---------------------------------------------------------------------------

test("cases 34-37: every push-side rewrite is shared, a forced refspec in config included", () => {
  const dir = newRepo();
  branch(dir, "lane");
  commit(dir, "l1");
  assertMember(dir, "git push --force-with-lease origin lane", "shared", "push-side", BARE);
  assertMember(dir, "git push origin +lane", "shared", "push-side", BARE);
  assertMember(dir, "git push --force origin :lane", "shared", "push-side", BARE);
  // The control: a bare push with ordinary configuration is not refined.
  assertUnrefined(dir, "git push", "vcs.push.main");
  // 37: a forced refspec the text cannot show.
  git(dir, "config", "remote.origin.push", "+refs/heads/*:refs/heads/*");
  const promoted = probe(dir, "git push");
  assert.equal(promoted.class, SHARED);
  assert.equal(promoted.rule, "git-push-implicit");
  assert.equal(promoted.history_rewrite?.basis, "push-side");
  assert.equal(promoted.history_rewrite?.legacy_class, "vcs.push.main");
  git(dir, "config", "--unset", "remote.origin.push");
  git(dir, "config", "remote.origin.mirror", "true");
  assertMember(dir, "git push origin", "shared", "push-side", "vcs.push.main");
});

test("case 38: filter-branch and filter-repo are shared, whole-history", () => {
  const dir = newRepo();
  branch(dir, "lane");
  assertMember(dir, "git filter-branch --tree-filter 'rm x' HEAD", "shared", "whole-history", BRANCH);
  assertMember(dir, "git filter-repo --path x", "shared", "whole-history", BRANCH);
});

// ---------------------------------------------------------------------------
// pull (cases 39 to 41, 44)
// ---------------------------------------------------------------------------

test("cases 39-41, 44: a rebasing pull joins the family; configuration counts; --no-rebase wins", () => {
  const dir = newRepo();
  branch(dir, "lane");
  commit(dir, "l1");
  pushUpstream(dir, "lane");
  commit(dir, "l2");
  // 39: the pure class moved, the legacy class is the old one.
  const thirtyNine = assertMember(dir, "git pull --rebase", "local", "range-unpublished", BRANCH);
  assert.equal(thirtyNine.lost, 1);
  assert.equal(probe(dir, "git pull --rebase").rule, "git-pull-rebase");
  // 41.
  assertMember(dir, "git pull --rebase=interactive", "shared", "interactive", BRANCH);
  // Control: a bare pull with no rebase configuration stays a merge.
  assertUnrefined(dir, "git pull", BRANCH);
  // 40: pull.rebase=true promotes a bare pull.
  git(dir, "config", "pull.rebase", "true");
  const forty = assertMember(dir, "git pull", "local", "range-unpublished", BRANCH);
  assert.equal(forty.lost, 1);
  assert.equal(probe(dir, "git pull").rule, "git-write");
  // 44: --no-rebase beats the configuration.
  assertUnrefined(dir, "git pull --no-rebase origin main", BRANCH);
  // A branch-level setting beats pull.rebase.
  git(dir, "config", "branch.lane.rebase", "false");
  assertUnrefined(dir, "git pull", BRANCH);
  git(dir, "config", "branch.lane.rebase", "interactive");
  assertMember(dir, "git pull", "shared", "interactive", BRANCH);
});

// ---------------------------------------------------------------------------
// Outside the family, and the cross-cutting MUSTs (cases 42, 43, 45 to 50)
// ---------------------------------------------------------------------------

/** Every git child of the CLI, through GIT_TRACE, as text. */
function traced(dir: string, command: string): string {
  const trace = join(nextDir("trace"), "trace.log");
  process.env["GIT_TRACE"] = trace;
  try {
    classifyForHook(command, [], dir);
  } finally {
    delete process.env["GIT_TRACE"];
  }
  return existsSync(trace) ? readFileSync(trace, "utf8") : "";
}

/** The refinement's own first query, C1. */
const C1_QUERY = /rev-parse --symbolic-full-name HEAD --absolute-git-dir/u;

test("cases 42-44: the restack by merge, and a stacked merge then push, run no rewrite check", () => {
  const dir = newRepo();
  branch(dir, "lane");
  commit(dir, "l1");
  pushUpstream(dir, "lane");
  git(dir, "config", "pull.rebase", "true");
  assertUnrefined(dir, "git merge origin/main", BRANCH);
  const forty3 = classifyAll(dir, "git merge nonav/base-pr && git push origin lane");
  assert.deepEqual(forty3.classes, [BRANCH, "vcs.push.branch"]);
  for (const command of [
    "git merge origin/main",
    "git merge nonav/base-pr && git push origin lane",
    "git pull --no-rebase origin main",
  ]) {
    const trace = traced(dir, command);
    assert.doesNotMatch(trace, C1_QUERY, `${command} ran the rewrite check`);
    assert.doesNotMatch(trace, /config --get-regexp/u, `${command} read rewrite configuration`);
  }
  // The control: a refined command does run it, so the absence above means something.
  assert.match(traced(dir, "git commit --amend"), C1_QUERY);
});

test("cases 45-48: a global option, an env assignment or an earlier state change makes the segment shared", () => {
  const dir = newRepo();
  branch(dir, "lane");
  commit(dir, "l1");
  // 45: answered from this checkout before (APRV-108's gap). Since APRV-520
  // (#651) a value-taking global leaves the command unclassified, which the
  // hook refuses; a zero-value global outside the inert list is shared.
  const forty5 = classifyAll(dir, "git --git-dir=../x/.git reset --hard");
  assert.equal(forty5.ok, false);
  assert.equal(forty5.code, "unclassified");
  assertMember(dir, "git --bare reset --hard", "shared", "global-option", BRANCH);
  // Inert global options change nothing.
  assertMember(dir, "git --no-pager commit --amend", "local", "range-unpublished", BRANCH);
  // 46: unchanged, the classifier refuses it.
  const forty6 = classifyAll(dir, "git -C ../x rebase main");
  assert.equal(forty6.ok, false);
  // 47.
  assertMember(dir, "cd ../x && git reset --hard HEAD~1", "shared", "compound-state", BRANCH, 1);
  // 48: the push is not refined; the amend after it is shared.
  assertUnrefined(dir, "git push origin lane && git commit --amend", "vcs.push.branch", 0);
  assertMember(dir, "git push origin lane && git commit --amend", "shared", "compound-state", BRANCH, 1);
  // A promoted spelling with an ordinary assignment reads the same configuration.
  assertUnrefined(dir, "PAGER=cat git push", "vcs.push.main");
  // APRV-517: any `GIT_*` assignment in front of `git push` steers which
  // configuration the push reads, so the text classifier answers the rewrite
  // class (`git-push-unreadable`) before this step runs, and every push-side
  // rewrite is shared. Stricter than the `vcs.push.main` APRV-433 had here.
  const prompt = assertMember(dir, "GIT_TERMINAL_PROMPT=0 git push", "shared", "push-side", "vcs.history.rewrite");
  assert.equal(probe(dir, "GIT_TERMINAL_PROMPT=0 git push", 0).rule, "git-push-unreadable");
  assert.equal(prompt.ref, null);
});

test("cases 49-50: the phase-two spellings stay outside the family, pinned so the change is visible", () => {
  const dir = newRepo();
  branch(dir, "lane");
  commit(dir, "l1");
  assertUnrefined(dir, "git reset --soft HEAD~1", BRANCH);
  assertUnrefined(dir, "git branch -f lane main", BRANCH);
  assertUnrefined(dir, "git switch -C lane main", BRANCH);
  assertUnrefined(dir, "git reflog expire --expire=now --all", "read.shell");
});

test("the check budget: a budget spent before any query is shared, check-timeout", () => {
  const dir = newRepo();
  branch(dir, "lane");
  commit(dir, "l1");
  const classified = classifyCommand("git commit --amend");
  const spent = refineHistoryRewrite(classified, dir, { env: { ...isolatedEnv() } as Record<string, string>, budgetMs: 0 });
  assert.equal(spent.result.ok, true);
  const segment = spent.result.ok ? spent.result.segments[0] : undefined;
  assert.equal(segment?.class, SHARED);
  assert.equal(segment?.history_rewrite?.basis, "check-timeout");
  // A clock that runs out between queries fails the same way.
  let calls = 0;
  const late = refineHistoryRewrite(classified, dir, {
    env: { ...isolatedEnv() } as Record<string, string>,
    now: () => (calls++ < 2 ? 0 : 10_000),
  });
  const lateSegment = late.result.ok ? late.result.segments[0] : undefined;
  assert.equal(lateSegment?.class, SHARED);
  assert.equal(lateSegment?.history_rewrite?.basis, "check-timeout");
  // The control: the default budget answers local.
  const normal = refineHistoryRewrite(classified, dir, { env: { ...isolatedEnv() } as Record<string, string> });
  assert.equal(normal.result.ok ? normal.result.segments[0]?.class : null, LOCAL);
});

// ---------------------------------------------------------------------------
// Adversarial cases (APRV-433 build). Each one is a way to make a rewrite
// look local that the closed lists exist to refuse, or a spelling git accepts
// that the text classifier used to read as something milder.
// ---------------------------------------------------------------------------

test("adversarial: a detached HEAD is shared for amend and reset --hard too", () => {
  const dir = newRepo();
  branch(dir, "lane");
  commit(dir, "l1");
  git(dir, "checkout", "--quiet", "--detach", "HEAD");
  assertMember(dir, "git commit --amend --no-edit", "shared", "detached-head", BARE);
  assertMember(dir, "git reset --hard 'HEAD~1'", "shared", "detached-head", BARE);
});

test("adversarial: no upstream configured, a rebase or a rebasing pull that names no base is shared", () => {
  const dir = newRepo();
  branch(dir, "lane");
  commit(dir, "l1");
  // git itself refuses both; the check does not guess a base for them.
  assertMember(dir, "git rebase", "shared", "unreadable-target", BRANCH);
  assertMember(dir, "git pull --rebase", "shared", "unreadable-target", BRANCH);
});

test("adversarial: an upstream deleted locally, or configured and never fetched, is shared", () => {
  const dir = newRepo();
  branch(dir, "lane");
  commit(dir, "l1");
  pushUpstream(dir, "lane");
  commit(dir, "l2");
  // The remote-tracking ref removed by hand, with the upstream still configured.
  git(dir, "update-ref", "-d", "refs/remotes/origin/lane");
  assertMember(dir, "git commit --amend", "shared", "upstream-gone", BARE);
  assertMember(dir, "git reset --hard 'HEAD~1'", "shared", "upstream-gone", BARE);
  // An upstream configured by hand that was never fetched reads as gone too.
  branch(dir, "fresh");
  commit(dir, "f1");
  git(dir, "config", "branch.fresh.remote", "origin");
  git(dir, "config", "branch.fresh.merge", "refs/heads/never-fetched");
  assertMember(dir, "git commit --amend", "shared", "upstream-gone", BARE);
});

test("adversarial: a branch NAMED like .local gets nothing from its name; reachability decides", () => {
  const dir = newRepo();
  branch(dir, "lane.local");
  commit(dir, "l1");
  pushUpstream(dir, "lane.local");
  const pushed = assertMember(dir, "git commit --amend", "shared", "shared-commit", BARE);
  assert.equal(pushed.witness, "refs/remotes/origin/lane.local");
  assertMember(dir, "git reset --hard 'HEAD~1'", "shared", "shared-commit", BARE);
  // The same name with nothing published is local, exactly as any name is.
  branch(dir, "wip.local");
  commit(dir, "w1");
  assertMember(dir, "git commit --amend", "local", "range-unpublished", BRANCH);
  // A branch literally named after the member is just a branch.
  branch(dir, "vcs.history.rewrite.local", "origin/main");
  assertMember(dir, "git commit --amend", "shared", "shared-commit", BRANCH);
});

test("adversarial: a local upstream (remote = .) and a pull-request ref both make a commit shared", () => {
  const dir = newRepo();
  branch(dir, "lane");
  commit(dir, "l1");
  // Another branch tracks lane locally, so lane's tip is someone's upstream.
  git(dir, "branch", "--quiet", "--track", "follower", "lane");
  const tracked = assertMember(dir, "git commit --amend", "shared", "shared-commit", BRANCH);
  assert.equal(tracked.witness, "refs/heads/lane");
  git(dir, "branch", "--quiet", "-D", "follower");
  assertMember(dir, "git commit --amend", "local", "range-unpublished", BRANCH);
  // A fetched pull-request ref holds the commit.
  git(dir, "update-ref", "refs/pull/7/head", "HEAD");
  const pr = assertMember(dir, "git commit --amend", "shared", "shared-commit", BRANCH);
  assert.equal(pr.witness, "refs/pull/7/head");
});

test("adversarial: every push-side spelling is shared: + refspecs, --force-with-lease forms, bundles, abbreviations", () => {
  const dir = newRepo();
  branch(dir, "lane");
  commit(dir, "l1");
  pushUpstream(dir, "lane");
  for (const command of [
    "git push origin +HEAD:lane",
    "git push origin +refs/heads/lane:refs/heads/lane",
    "git push origin main +lane",
    "git push --force-with-lease origin lane",
    `git push --force-with-lease=lane:${git(dir, "rev-parse", "HEAD")} origin lane`,
    "git push --force-if-includes --force-with-lease origin lane",
    "git push --force-w origin lane",
    // push -f to a shared branch, in every spelling git accepts.
    "git push -f origin lane",
    "git push -fu origin lane",
    "git push -uf origin lane",
    "git push --force origin lane",
    "git push --m origin",
  ]) {
    assertMember(dir, command, "shared", "push-side", BARE);
  }
  // `-o` takes the rest of its bundle as a value: `-ofu` is a push option.
  assertUnrefined(dir, "git push -ofu origin lane", "vcs.push.branch");
});

test("adversarial: rebase options outside the closed list are shared, abbreviations included", () => {
  const dir = newRepo();
  branch(dir, "lane");
  commit(dir, "l1");
  // `rebase -i` on an unshared branch stays shared (case 17), and so do the
  // abbreviations git accepts for it and for --exec.
  assertMember(dir, "git rebase -i origin/main", "shared", "interactive", BRANCH);
  assertMember(dir, "git rebase --inter origin/main", "shared", "option-unvetted", BRANCH);
  assertMember(dir, "git rebase --exe make origin/main", "shared", "option-unvetted", BRANCH);
  assertMember(dir, "git rebase --ont origin/main base", "shared", "option-unvetted", BRANCH);
  assertMember(dir, "git rebase -qv origin/main", "shared", "option-unvetted", BRANCH);
  // --update-refs moves other branches; so does rebase.updateRefs.
  assertMember(dir, "git rebase --update-refs origin/main", "shared", "updates-other-refs", BRANCH);
  git(dir, "config", "rebase.updateRefs", "true");
  assertMember(dir, "git rebase origin/main", "shared", "updates-other-refs", BRANCH);
  assertMember(dir, "git pull --rebase origin main", "shared", "updates-other-refs", BRANCH);
  assertMember(dir, "git rebase --no-update-refs origin/main", "local", "range-unpublished", BRANCH);
  git(dir, "config", "--unset", "rebase.updateRefs");
  // rebase.rebaseMerges makes a plain rebase a --rebase-merges one.
  git(dir, "config", "rebase.rebaseMerges", "true");
  assertMember(dir, "git rebase origin/main", "shared", "interactive", BRANCH);
  assertMember(dir, "git rebase --no-rebase-merges origin/main", "local", "range-unpublished", BRANCH);
  git(dir, "config", "--unset", "rebase.rebaseMerges");
  // The vetted zero-value spellings stay local; a value-taking option does
  // not, attached or separate (APRV-648 fix round 3).
  assertMember(dir, "git rebase -q --autostash origin/main lane", "local", "range-unpublished", BRANCH);
  assertMember(dir, "git rebase -q --autostash --onto origin/main origin/main lane", "shared", "option-unvetted", BRANCH);
  assertMember(dir, "git rebase -Xtheirs -s ort origin/main", "shared", "option-unvetted", BRANCH);
  assertMember(dir, "git rebase -C4 origin/main", "shared", "option-unvetted", BRANCH);
  assertMember(dir, "git rebase -Skey origin/main", "shared", "option-unvetted", BRANCH);
  // A rebasing pull with a strategy git does not ship runs it; =merges is shared.
  assertMember(dir, "git pull --rebase -s custom origin main", "shared", "runs-commands", BRANCH);
  assertMember(dir, "git pull --rebase=merges origin main", "shared", "interactive", BRANCH);
});

test("adversarial: reset --hard and commit --amend in the abbreviations git accepts are rewrites", () => {
  const dir = newRepo();
  branch(dir, "lane");
  commit(dir, "l1");
  commit(dir, "l2");
  // The classifier reads them as rewrites; the judge's closed list takes
  // exact spellings only, so an abbreviation is shared (fix round 3).
  assertMember(dir, "git reset --h origin/main", "shared", "option-unvetted", BRANCH);
  assertMember(dir, "git commit --am --no-edit", "shared", "option-unvetted", BRANCH);
  assertMember(dir, "git reset --hard origin/main", "local", "range-unpublished", BRANCH);
  assertMember(dir, "git commit --amend --no-edit", "local", "range-unpublished", BRANCH);
  // commit --amend on a pushed branch, either spelling.
  pushUpstream(dir, "lane");
  assertMember(dir, "git commit --amend --no-edit", "shared", "shared-commit", BARE);
  assertMember(dir, "git commit --am --no-edit", "shared", "option-unvetted", BARE);
  assertMember(dir, "git reset --ha HEAD~1", "shared", "option-unvetted", BARE);
  assertMember(dir, "git reset --hard 'HEAD~1'", "shared", "shared-commit", BARE);
});

test("adversarial: only a closed list of earlier segments and assignments leaves a rewrite judgeable", () => {
  // The allowed: index-only git, and assignments that only silence a prompt,
  // shown on an amend of an unpushed branch, which stays local.
  const lane = newRepo();
  branch(lane, "lane");
  commit(lane, "l1");
  writeFileSync(join(lane, "a.txt"), "staged\n", "utf8");
  assertMember(lane, "git add a.txt && git commit --amend --no-edit", "local", "range-unpublished", BRANCH, 1);
  assertMember(lane, "git status && git add -A 2>/dev/null && git commit --amend --no-edit", "local", "range-unpublished", BRANCH, 2);
  assertMember(lane, "GIT_EDITOR=true git commit --amend", "local", "range-unpublished", BRANCH);
  // An editor of the caller's choosing never reaches the split (APRV-521).
  assertUnclassified(lane, "GIT_EDITOR=vim git commit --amend");
  // On a stopped rebase the same allowed prefixes reach the resume rule, which is shared.
  const dir = stoppedRebase(false);
  assertMember(dir, "git add a.txt && git rebase --continue", "shared", "unreadable-target", BARE, 1);
  assertMember(dir, "GIT_EDITOR=true git rebase --continue", "shared", "unreadable-target", BARE);
  // An editor that is a program of the caller's choosing is not silenced:
  // the classifier refuses it before the split is asked (APRV-521).
  assertUnclassified(dir, "GIT_EDITOR=vim git rebase --continue");
  // A write into the git directory before the check's state is used.
  assertMember(
    dir,
    "echo 'exec rm -rf x' >> .git/rebase-merge/git-rebase-todo && git rebase --continue",
    "shared",
    "compound-state",
    BARE,
    1,
  );
  assertMember(dir, "git add a.txt > .git/rebase-merge/onto && git rebase --continue", "shared", "compound-state", BARE, 1);
  assertMember(dir, "git add $(cat list) && git rebase --continue", "shared", "compound-state", BARE, 1);
  assertMember(dir, "true && git rebase --continue", "shared", "compound-state", BARE, 1);
  // A pipe or a background job runs the next segment while git reads.
  assertMember(dir, "git rebase --continue | tee .git/rebase-merge/git-rebase-todo", "shared", "compound-state", BARE, 0);
  assertMember(dir, "git rebase --continue & git status", "shared", "compound-state", BARE, 0);
  // Without the command line the refinement cannot show the segments run in order.
  const classified = classifyCommand("git add a.txt && git rebase --continue");
  const blind = refineHistoryRewrite(classified, dir, { env: { ...isolatedEnv() } as Record<string, string> });
  assert.equal(blind.result.ok ? blind.result.segments[1]?.history_rewrite?.basis : null, "compound-state");
});

test("adversarial: a rebase state written by hand cannot make any resume step a quiet rewrite", () => {
  // A forged head-name and orig-head that would make --abort a hard reset of main.
  const forged = newRepo();
  commit(forged, "m2");
  git(forged, "push", "--quiet", "origin", "main");
  branch(forged, "lane");
  const state = join(forged, ".git", "rebase-merge");
  mkdirSync(state, { recursive: true });
  const mainParent = git(forged, "rev-parse", "main~1");
  writeFileSync(join(state, "head-name"), "refs/heads/main\n", "utf8");
  writeFileSync(join(state, "orig-head"), `${mainParent}\n`, "utf8");
  writeFileSync(join(state, "onto"), `${mainParent}\n`, "utf8");
  // The pre-split class is APRV-108's downgrade (HEAD is on `lane`, which has
  // no upstream): a policy with no own line still answers what it answered
  // before, and adopting the split is what closes this.
  assertResumeShared(forged, BRANCH);
  for (const headName of ["refs/tags/v1\n", "detached HEAD\n"]) {
    writeFileSync(join(state, "head-name"), headName, "utf8");
    assertResumeShared(forged, BRANCH);
  }

  // A forged onto, a strategy git does not ship, refs queued by --update-refs.
  const pushed = stoppedRebase(true);
  const origHead = readFileSync(join(pushed, ".git", "rebase-merge", "orig-head"), "utf8");
  writeFileSync(join(pushed, ".git", "rebase-merge", "onto"), origHead, "utf8");
  assertResumeShared(pushed, BARE);
  const strategy = stoppedRebase(false);
  writeFileSync(join(strategy, ".git", "rebase-merge", "strategy"), "evil\n", "utf8");
  assertResumeShared(strategy, BARE);
  const queued = stoppedRebase(false);
  writeFileSync(join(queued, ".git", "rebase-merge", "update-refs"), "refs/heads/main\n", "utf8");
  assertResumeShared(queued, BARE);
  assertMember(queued, "git rebase --abort -q", "shared", "unreadable-target", BARE);
});

/**
 * APRV-648 M1 case 1: `main` with three pushed commits, HEAD ON `main`, and a
 * hand-written `rebase-merge` whose head-name is git's `detached HEAD` and
 * whose orig-head is `main~2`. git reads that head-name as "no branch" and
 * hard-resets whatever HEAD points at, so `--abort` moves `main` back by two
 * pushed commits.
 */
function forgedDetachedAbort(policy = THIS_REPO): { dir: string; c1: string } {
  const dir = newRepo(policy, 3);
  const c1 = git(dir, "rev-parse", "main~2");
  const state = join(dir, ".git", "rebase-merge");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "head-name"), "detached HEAD\n", "utf8");
  writeFileSync(join(state, "orig-head"), `${c1}\n`, "utf8");
  writeFileSync(join(state, "onto"), `${c1}\n`, "utf8");
  writeFileSync(join(state, "interactive"), "", "utf8");
  return { dir, c1 };
}

/**
 * APRV-648 M1 case 2: a pushed `lane` with HEAD on it, a harmless
 * `rebase-merge` (head-name lane, orig-head the lane tip: nothing lost) beside
 * a `rebase-apply` naming `main` with orig-head `main~2`. git reads
 * `rebase-apply` first.
 */
function forgedBothDirs(policy = THIS_REPO): { dir: string; c1: string; lane: string } {
  const dir = newRepo(policy, 3);
  const c1 = git(dir, "rev-parse", "main~2");
  branch(dir, "lane");
  const lane = commit(dir, "l1");
  pushUpstream(dir, "lane");
  const merge = join(dir, ".git", "rebase-merge");
  const apply = join(dir, ".git", "rebase-apply");
  mkdirSync(merge, { recursive: true });
  mkdirSync(apply, { recursive: true });
  writeFileSync(join(merge, "head-name"), "refs/heads/lane\n", "utf8");
  writeFileSync(join(merge, "orig-head"), `${lane}\n`, "utf8");
  writeFileSync(join(merge, "onto"), `${lane}\n`, "utf8");
  writeFileSync(join(merge, "interactive"), "", "utf8");
  writeFileSync(join(apply, "head-name"), "refs/heads/main\n", "utf8");
  writeFileSync(join(apply, "orig-head"), `${c1}\n`, "utf8");
  writeFileSync(join(apply, "onto"), `${c1}\n`, "utf8");
  writeFileSync(join(apply, "rebasing"), "", "utf8");
  return { dir, c1, lane };
}

/**
 * APRV-648 S1: `lane` (unpushed) cut from `main~2`, HEAD detached there, a
 * clean `rebase-merge` for lane with an empty todo, and a `rebase-apply`
 * naming `main` beside it. git would resume the apply backend on `main`.
 */
function forgedBothDirsContinue(policy = THIS_REPO): string {
  const dir = newRepo(policy, 3);
  const c1 = git(dir, "rev-parse", "main~2");
  branch(dir, "lane", c1);
  const lane = commit(dir, "l1");
  git(dir, "checkout", "--quiet", "--detach", c1);
  const merge = join(dir, ".git", "rebase-merge");
  const apply = join(dir, ".git", "rebase-apply");
  mkdirSync(merge, { recursive: true });
  mkdirSync(apply, { recursive: true });
  writeFileSync(join(merge, "head-name"), "refs/heads/lane\n", "utf8");
  writeFileSync(join(merge, "orig-head"), `${lane}\n`, "utf8");
  writeFileSync(join(merge, "onto"), `${c1}\n`, "utf8");
  writeFileSync(join(merge, "interactive"), "", "utf8");
  writeFileSync(join(merge, "git-rebase-todo"), "", "utf8");
  writeFileSync(join(apply, "head-name"), "refs/heads/main\n", "utf8");
  writeFileSync(join(apply, "orig-head"), `${c1}\n`, "utf8");
  writeFileSync(join(apply, "onto"), `${c1}\n`, "utf8");
  writeFileSync(join(apply, "rebasing"), "", "utf8");
  writeFileSync(join(apply, "next"), "1\n", "utf8");
  writeFileSync(join(apply, "last"), "1\n", "utf8");
  return dir;
}

test("APRV-648 M1: --abort with head-name `detached HEAD` while HEAD is on main is shared, and git really resets main", () => {
  const { dir, c1 } = forgedDetachedAbort();
  assertResumeShared(dir, BARE);
  // The CLI answers the same.
  assert.equal(classifyCli(dir, "git rebase --abort").segments?.[0]?.class, SHARED);
  // What the verdict guards against: git hard-resets main by two pushed commits.
  assert.equal(gitMayFail(dir, "rebase", "--abort"), 0);
  assert.equal(git(dir, "rev-parse", "main"), c1, "git reset the branch HEAD was on");

  // The same state with HEAD really detached is git's own shape, and still
  // shared since round 2: the check no longer tells the two apart.
  const detached = forgedDetachedAbort();
  git(detached.dir, "checkout", "--quiet", "--detach", "main");
  assertResumeShared(detached.dir, BARE);
});

test("APRV-648 M1: with both rebase-apply and rebase-merge present, every resume step is shared; git acts on rebase-apply", () => {
  const { dir, c1, lane } = forgedBothDirs();
  assertResumeShared(dir, BARE);
  assert.equal(classifyCli(dir, "git rebase --abort").segments?.[0]?.class, SHARED);
  // git 2.50 reads rebase-apply first: main loses two pushed commits, lane is
  // untouched, and the rebase-merge decoy is left behind.
  assert.equal(gitMayFail(dir, "rebase", "--abort"), 0);
  assert.equal(git(dir, "rev-parse", "main"), c1, "git acted on rebase-apply");
  assert.equal(git(dir, "rev-parse", "lane"), lane);
  assert.ok(existsSync(join(dir, ".git", "rebase-merge")), "rebase-merge was not the directory git read");
  assert.ok(!existsSync(join(dir, ".git", "rebase-apply")));
});

test("APRV-648 M1: a lone rebase-apply, a state path that is not a directory, and an attached HEAD are all shared", () => {
  const apply = newRepo(THIS_REPO, 3);
  const c1 = git(apply, "rev-parse", "main~2");
  git(apply, "checkout", "--quiet", "--detach", "main");
  const applyDir = join(apply, ".git", "rebase-apply");
  mkdirSync(applyDir, { recursive: true });
  writeFileSync(join(applyDir, "head-name"), "refs/heads/main\n", "utf8");
  writeFileSync(join(applyDir, "orig-head"), `${c1}\n`, "utf8");
  writeFileSync(join(applyDir, "onto"), `${c1}\n`, "utf8");
  writeFileSync(join(applyDir, "rebasing"), "", "utf8");
  assertResumeShared(apply, BARE);

  const file = newRepo();
  writeFileSync(join(file, ".git", "rebase-merge"), "x\n", "utf8");
  assertResumeShared(file, BARE);

  const attached = stoppedRebase(false);
  git(attached, "symbolic-ref", "HEAD", "refs/heads/main");
  assertResumeShared(attached, BARE);
});

test("APRV-648 S1: --continue and --skip are shared with both state directories present", () => {
  const both = forgedBothDirsContinue();
  assertResumeShared(both, BARE);
  assert.equal(classifyCli(both, "git rebase --continue").segments?.[0]?.class, SHARED);
});

test("APRV-648 round 2: a real apply-backend stop is shared for every resume step too", () => {
  const dir = newRepo();
  commit(dir, "a", "base\n", "a.txt");
  git(dir, "push", "--quiet", "origin", "main");
  branch(dir, "lane");
  commit(dir, "l1", "lane\n", "a.txt");
  commit(dir, "l2");
  git(dir, "checkout", "--quiet", "main");
  commit(dir, "m2", "main\n", "a.txt");
  git(dir, "checkout", "--quiet", "lane");
  assert.notEqual(gitMayFail(dir, "rebase", "--apply", "main"), 0, "the apply rebase stops on the conflict");
  assert.ok(existsSync(join(dir, ".git", "rebase-apply")));
  assert.ok(!existsSync(join(dir, ".git", "rebase-merge")));
  assertResumeShared(dir, BARE);
});

/**
 * APRV-648 M-A: `main` with three pushed commits, HEAD detached at its tip, a
 * branch whose NAME is `main~2`'s id plus 24 more hex digits pointing at
 * main's tip, and a forged `rebase-merge` naming `main` whose orig-head is
 * that 64-character name. In a SHA-1 repository rev-list reads the name as
 * that branch (nothing lost), while git's abort parses only the first 40
 * characters and hard-resets main to `main~2`.
 */
function forgedLongOrigHead(policy = THIS_REPO): { dir: string; c1: string } {
  const dir = newRepo(policy, 3);
  const c1 = git(dir, "rev-parse", "main~2");
  const longName = `${c1}${"abcdef".repeat(4)}`;
  git(dir, "branch", longName, "main");
  git(dir, "checkout", "--quiet", "--detach", "main");
  const state = join(dir, ".git", "rebase-merge");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "head-name"), "refs/heads/main\n", "utf8");
  writeFileSync(join(state, "orig-head"), `${longName}\n`, "utf8");
  writeFileSync(join(state, "onto"), `${c1}\n`, "utf8");
  writeFileSync(join(state, "interactive"), "", "utf8");
  return { dir, c1 };
}

/**
 * APRV-648 M-B: a pushed `lane` whose tip H is HEAD (detached), and a forged
 * `rebase-merge` for lane with orig-head H. `amend`: an `amend` file naming H,
 * a message, an author script and a staged change, so the resume amends H.
 * `fixup`: a todo whose first line is a fixup, with a `done` file, so the
 * resume folds a commit into H. Either way git moves lane to a rewrite of H,
 * and lane no longer holds the pushed H.
 */
function forgedAmendingResume(kind: "amend" | "fixup", policy = THIS_REPO): { dir: string; h: string } {
  const dir = newRepo(policy);
  branch(dir, "side");
  const side = commit(dir, "s1");
  git(dir, "checkout", "--quiet", "main");
  branch(dir, "lane");
  const h = commit(dir, "l1");
  pushUpstream(dir, "lane");
  git(dir, "checkout", "--quiet", "--detach", h);
  const state = join(dir, ".git", "rebase-merge");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "head-name"), "refs/heads/lane\n", "utf8");
  writeFileSync(join(state, "orig-head"), `${h}\n`, "utf8");
  writeFileSync(join(state, "onto"), `${h}\n`, "utf8");
  writeFileSync(join(state, "interactive"), "", "utf8");
  if (kind === "amend") {
    writeFileSync(join(state, "git-rebase-todo"), `pick ${side}\n`, "utf8");
    writeFileSync(join(state, "amend"), `${h}\n`, "utf8");
    writeFileSync(join(state, "message"), "amended\n", "utf8");
    writeFileSync(
      join(state, "author-script"),
      "GIT_AUTHOR_NAME='Test'\nGIT_AUTHOR_EMAIL='test@example.com'\nGIT_AUTHOR_DATE='@1700000000 +0000'\n",
      "utf8",
    );
    writeFileSync(join(dir, "l1.txt"), "l1\nchanged\n", "utf8");
    git(dir, "add", "l1.txt");
  } else {
    writeFileSync(join(state, "git-rebase-todo"), `fixup ${side}\n`, "utf8");
    writeFileSync(join(state, "done"), "", "utf8");
  }
  return { dir, h };
}

/**
 * A stopped-rebase shape whose `refs-to-delete` lists `refs/heads/main`: git
 * deletes every ref listed there when it removes the merge state, which
 * `--quit` and `--abort` both do (sequencer.c `sequencer_remove_state`).
 */
function forgedRefsToDelete(policy = THIS_REPO): string {
  const dir = newRepo(policy, 2);
  const tip = git(dir, "rev-parse", "main");
  git(dir, "checkout", "--quiet", "--detach", "main");
  const state = join(dir, ".git", "rebase-merge");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "head-name"), "detached HEAD\n", "utf8");
  writeFileSync(join(state, "orig-head"), `${tip}\n`, "utf8");
  writeFileSync(join(state, "onto"), `${tip}\n`, "utf8");
  writeFileSync(join(state, "refs-to-delete"), "refs/heads/main\n", "utf8");
  return dir;
}

test("APRV-648 M-A: an orig-head longer than the repository's object id is shared, and git really resets main", () => {
  const { dir, c1 } = forgedLongOrigHead();
  // At 40efb973 this --abort was local, abort-restores (0 commits lost).
  assertMember(dir, "git rebase --abort", "shared", "unreadable-target", BARE);
  assertResumeShared(dir, BARE);
  assert.equal(classifyCli(dir, "git rebase --abort").segments?.[0]?.class, SHARED);
  assert.equal(gitMayFail(dir, "rebase", "--abort"), 0);
  assert.equal(git(dir, "rev-parse", "main"), c1, "git parsed the first 40 characters and reset main");
});

test("APRV-648 M-B: a resume that amends HEAD (an amend file, or a leading fixup) is shared, and git really drops the pushed tip", () => {
  for (const kind of ["amend", "fixup"] as const) {
    const { dir, h } = forgedAmendingResume(kind);
    // At 40efb973 this --continue was local, rebase-in-progress-unpublished (R empty).
    assertMember(dir, "git rebase --continue", "shared", "unreadable-target", BARE);
    assertResumeShared(dir, BARE);
    assert.equal(classifyCli(dir, "git rebase --continue").segments?.[0]?.class, SHARED, kind);
    assert.equal(gitMayFail(dir, "rebase", "--continue"), 0, kind);
    assert.notEqual(
      gitMayFail(dir, "merge-base", "--is-ancestor", h, "lane"),
      0,
      `${kind}: lane no longer holds the pushed commit`,
    );
  }
});

test("APRV-648 round 2: --quit is shared, because git deletes every ref a forged refs-to-delete lists", () => {
  const dir = forgedRefsToDelete();
  // At 40efb973 --quit was local whatever the state said.
  assertMember(dir, "git rebase --quit", "shared", "unreadable-target", BARE);
  assertResumeShared(dir, BARE);
  assert.equal(gitMayFail(dir, "rebase", "--quit"), 0);
  assert.notEqual(gitMayFail(dir, "rev-parse", "--verify", "--quiet", "refs/heads/main"), 0, "git deleted main");
});

// ---------------------------------------------------------------------------
// 7.3 Evidence: the hook's verdicts and what the log gains
// ---------------------------------------------------------------------------

function attest(dir: string): void {
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
}

const LOG = ".approval/log/events.jsonl";

function rawLog(dir: string): string {
  const path = join(dir, LOG);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function records(dir: string): Record<string, unknown>[] {
  return rawLog(dir)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function payloadOf(record: Record<string, unknown>): Record<string, unknown> {
  return (record["payload"] ?? {}) as Record<string, unknown>;
}

interface Verdict {
  permission: string;
  reason: string;
}

function hook(dir: string, command: string, toolUseId: string, extraInput: Record<string, unknown> = {}): Verdict {
  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    JSON.stringify({
      session_id: "sess-r",
      cwd: dir,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command, ...extraInput },
      tool_use_id: toolUseId,
    }),
  );
  assert.equal(run.code, 0, run.stderr);
  const output = (JSON.parse(run.stdout) as Record<string, Record<string, string>>)["hookSpecificOutput"];
  assert.ok(output !== undefined, run.stdout);
  return { permission: output["permissionDecision"] ?? "", reason: output["permissionDecisionReason"] ?? "" };
}

test("P1 and P2 in the hook: under a policy with no own line a local amend is allowed as vcs.commit.branch and the start says it was a rewrite; a local reset with a bare legacy stays human-only", () => {
  const dir = newRepo(THIS_REPO);
  branch(dir, "lane");
  commit(dir, "l1");
  attest(dir);
  const verdict = hook(dir, "git commit --amend --no-edit", "p1");
  assert.equal(verdict.permission, "allow", verdict.reason);
  assert.match(verdict.reason, /^autonomous: vcs\.commit\.branch /u);
  assert.match(verdict.reason, /rewrite-local: range-unpublished/u);
  assert.match(verdict.reason, /pre-split class vcs\.commit\.branch \(legacy, APRV-433\)/u);
  const started = records(dir).filter((record) => record["event"] === "execution.started");
  assert.equal(started.length, 1);
  assert.equal(payloadOf(started[0] as Record<string, unknown>)["class"], BRANCH);
  const evidence = payloadOf(started[0] as Record<string, unknown>)["history_rewrite"] as Record<string, unknown>;
  assert.equal(evidence["reach"], "local");
  assert.equal(evidence["basis"], "range-unpublished");
  assert.equal(evidence["legacy_class"], undefined, "the pre-split class is not part of the logged object");

  // P2: under the same policy, a local reset whose legacy is the bare class
  // stays human-only, and the refusal appends nothing.
  pushUpstream(dir, "lane");
  commit(dir, "l2");
  commit(dir, "l3");
  const before = rawLog(dir);
  const p2 = hook(dir, "git reset --hard HEAD~2", "p2");
  assert.equal(p2.permission, "deny");
  assert.match(p2.reason, /^hook-class-human-only: /u);
  assert.equal(rawLog(dir), before, "a human-only refusal appends nothing");
});

test("E1: case 1 under P3 records execution.started as vcs.history.rewrite.local with schema-valid evidence", () => {
  const dir = newRepo(LOCAL_AUTONOMOUS);
  branch(dir, "lane");
  commit(dir, "l1");
  attest(dir);
  const verdict = hook(dir, "git commit --amend --no-edit", "e1");
  assert.equal(verdict.permission, "allow", verdict.reason);
  assert.match(verdict.reason, /^autonomous: vcs\.history\.rewrite\.local /u);
  const started = records(dir).filter((record) => record["event"] === "execution.started");
  assert.equal(started.length, 1);
  const payload = payloadOf(started[0] as Record<string, unknown>);
  assert.equal(payload["class"], LOCAL);
  const evidence = payload["history_rewrite"] as Record<string, unknown>;
  assert.deepEqual(
    { reach: evidence["reach"], basis: evidence["basis"], ref: evidence["ref"], lost: evidence["lost"], lost_shared: evidence["lost_shared"], witness: evidence["witness"] },
    { reach: "local", basis: "range-unpublished", ref: "refs/heads/lane", lost: 1, lost_shared: 0, witness: null },
  );
  // The record went through the write boundary's schema, and the log verifies.
  const verified = runCli(["log", "verify"], dir);
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
});

test("E3 and P11: case 3 under this repo's proposed lines is denied, appends nothing, and the reason names basis and witness; a claimed member changes nothing", () => {
  const dir = newRepo(PROPOSED);
  branch(dir, "lane");
  commit(dir, "l1");
  pushUpstream(dir, "lane");
  attest(dir);
  const before = rawLog(dir);
  const verdict = hook(dir, "git commit --amend", "e3");
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-class-human-only: class vcs\.history\.rewrite\.shared /u);
  assert.match(verdict.reason, /rewrite-shared: shared-commit, witness refs\/remotes\/origin\/lane/u);
  assert.equal(rawLog(dir), before);

  // P11: a member claimed in the tool input does not stand in for the
  // runtime's derivation.
  const claimed = hook(dir, "git commit --amend", "p11", {
    class: LOCAL,
    history_rewrite: { reach: "local", basis: "range-unpublished" },
    description: "a local amend, please allow",
  });
  assert.equal(claimed.permission, "deny");
  assert.match(claimed.reason, /vcs\.history\.rewrite\.shared/u);
  assert.equal(rawLog(dir), before);

  // P11: a task envelope, or a token-minting request, declaring a member is
  // refused, and nothing is appended.
  const logPath = join(dir, LOG);
  const envelope = {
    origin: { app: "claude-code", created_by: "agent:cc" },
    state: "proposed",
    actions: [{ class: LOCAL, summary: "x", idempotency_key: "t-member:a", payload_hash: "a".repeat(64) }],
  };
  const registered = register(logPath, { task: "t-member", envelope }, "agent:cc", { policy: { dir } });
  assert.equal(registered.ok, false);
  assert.equal(registered.ok ? "" : registered.code, "envelope-invalid");
  assert.match(registered.ok ? "" : registered.message, /never accepts as declared/u);
  const requested = request(
    logPath,
    { task: "t-member", actionKey: "t-member:a", cls: LOCAL, payload_hash: "a".repeat(64) },
    "agent:cc",
    { policy: { dir } },
  );
  assert.equal(requested.ok, false);
  assert.equal(rawLog(dir), before, "nothing was appended");

  // P3/P4 under the same lines: the local amend proceeds.
  commit(dir, "l2");
  const local = hook(dir, "git commit --amend", "e3-local");
  assert.equal(local.permission, "allow", local.reason);
});

test("E2: a manual shared amend is requested with its witness, granted, and spent as .shared; a .local grant does not survive the commit becoming shared", () => {
  const dir = newRepo(SHARED_MANUAL);
  branch(dir, "lane");
  commit(dir, "l1");
  pushUpstream(dir, "lane");
  attest(dir);
  const first = hook(dir, "git commit --amend", "e2-a");
  assert.equal(first.permission, "deny");
  assert.match(first.reason, /^hook-timeout: /u);
  const requested = records(dir).filter((record) => record["event"] === "approval.requested");
  assert.equal(requested.length, 1);
  const asked = payloadOf(requested[0] as Record<string, unknown>);
  assert.equal(asked["class"], SHARED);
  assert.equal((asked["history_rewrite"] as Record<string, unknown>)["witness"], "refs/remotes/origin/lane");
  const granted = runCli(["grant", "hook:sess-r:e2-a:vcs.history.rewrite.shared", "--as", "human:carter"], dir);
  assert.equal(granted.code, 0, granted.stderr);
  const spent = hook(dir, "git commit --amend", "e2-b");
  assert.equal(spent.permission, "allow", spent.reason);
  const started = records(dir).filter((record) => record["event"] === "execution.started");
  assert.equal(started.length, 1);
  assert.equal(payloadOf(started[0] as Record<string, unknown>)["class"], SHARED);
  assert.equal(
    (payloadOf(started[0] as Record<string, unknown>)["history_rewrite"] as Record<string, unknown>)["reach"],
    "shared",
  );

  // The other direction: a grant for the LOCAL member, then the commit is pushed.
  commit(dir, "l2");
  const local = hook(dir, "git commit --amend", "e2-c");
  assert.equal(local.permission, "deny");
  const localKey = "hook:sess-r:e2-c:vcs.history.rewrite.local";
  assert.equal(runCli(["grant", localKey, "--as", "human:carter"], dir).code, 0);
  git(dir, "push", "--quiet", "origin", "lane");
  const after = hook(dir, "git commit --amend", "e2-d");
  assert.equal(after.permission, "deny", "the .local grant does not authorize a .shared rewrite");
  const startedAfter = records(dir).filter((record) => record["event"] === "execution.started");
  assert.equal(startedAfter.length, 1, "nothing was spent on the stale local grant");
  const newRequest = records(dir).filter(
    (record) => record["event"] === "approval.requested" && record["action_key"] === "hook:sess-r:e2-d:vcs.history.rewrite.shared",
  );
  assert.equal(newRequest.length, 1, "a fresh question under the derived member");
});

test("E5: hook classify prints what the hook decides, for cases 1, 3, 22, 27 and 37", () => {
  const expectFor = (dir: string, command: string, toolUseId: string): void => {
    const classified = classifyCli(dir, command);
    assert.equal(classified.ok, true, JSON.stringify(classified));
    const cls = classified.segments?.[0]?.class ?? "";
    assert.ok(cls === LOCAL || cls === SHARED, `${command}: ${cls}`);
    const verdict = hook(dir, command, toolUseId);
    assert.equal(verdict.permission, "allow", verdict.reason);
    assert.ok(
      verdict.reason.startsWith(`autonomous: ${cls}`),
      `${command}: classify said ${cls}, the hook said ${verdict.reason}`,
    );
  };
  const one = newRepo(BOTH_AUTONOMOUS);
  branch(one, "lane");
  commit(one, "l1");
  attest(one);
  expectFor(one, "git commit --amend --no-edit", "e5-1");
  pushUpstream(one, "lane");
  expectFor(one, "git commit --amend", "e5-3");
  // 22 and 27 on one stopped rebase (both shared since APRV-648 round 2, so
  // this pins that the hook names the member classify printed), and 37 in
  // the same checkout.
  const stopped = stoppedRebase(false, BOTH_AUTONOMOUS);
  git(stopped, "config", "remote.origin.push", "+refs/heads/*:refs/heads/*");
  attest(stopped);
  expectFor(stopped, "git rebase --continue", "e5-22");
  expectFor(stopped, "git rebase --abort", "e5-27");
  expectFor(stopped, "git push", "e5-37");
});

test("adversarial, in the hook: under the proposed lines a bundled force push and an abbreviated amend of a pushed branch are denied", () => {
  const dir = newRepo(PROPOSED);
  branch(dir, "lane");
  commit(dir, "l1");
  pushUpstream(dir, "lane");
  attest(dir);
  const before = rawLog(dir);
  for (const [command, id] of [
    ["git push -fu origin lane", "adv-push"],
    ["git commit --am --no-edit", "adv-amend"],
    ["git rebase --inter origin/main", "adv-rebase"],
  ] as const) {
    const verdict = hook(dir, command, id);
    assert.equal(verdict.permission, "deny", `${command}: ${verdict.reason}`);
    assert.match(verdict.reason, /^hook-class-human-only: class vcs\.history\.rewrite\.shared /u, command);
  }
  assert.equal(rawLog(dir), before, "a human-only refusal appends nothing");
});

test("APRV-648, in the hook: under the proposed lines every resume step is denied as .shared, forged state or real", () => {
  const cases: [string, string, string][] = [];
  const detached = forgedDetachedAbort(PROPOSED).dir;
  attest(detached);
  cases.push([detached, "git rebase --abort", "m1-detached"]);
  const both = forgedBothDirs(PROPOSED).dir;
  attest(both);
  cases.push([both, "git rebase --abort", "m1-both"]);
  const resume = forgedBothDirsContinue(PROPOSED);
  attest(resume);
  cases.push([resume, "git rebase --continue", "s1-both"]);
  // Round 2: M-A, both M-B shapes, and a forged refs-to-delete.
  const longOrig = forgedLongOrigHead(PROPOSED).dir;
  attest(longOrig);
  cases.push([longOrig, "git rebase --abort", "ma-long-orig-head"]);
  const amend = forgedAmendingResume("amend", PROPOSED).dir;
  attest(amend);
  cases.push([amend, "git rebase --continue", "mb-amend"]);
  const fixup = forgedAmendingResume("fixup", PROPOSED).dir;
  attest(fixup);
  cases.push([fixup, "git rebase --continue", "mb-fixup"], [fixup, "git rebase --skip", "mb-fixup-skip"]);
  const deleting = forgedRefsToDelete(PROPOSED);
  attest(deleting);
  cases.push([deleting, "git rebase --quit", "quit-refs-to-delete"]);
  // A real stop on an unpushed branch, the departure from the D-6 text.
  const real = stoppedRebase(false, PROPOSED);
  attest(real);
  for (const command of RESUME_STEPS) cases.push([real, command, `real-${command.slice("git rebase --".length)}`]);
  for (const [dir, command, id] of cases) {
    const log = rawLog(dir);
    const verdict = hook(dir, command, id);
    assert.equal(verdict.permission, "deny", `${id}: ${verdict.reason}`);
    assert.match(verdict.reason, /^hook-class-human-only: class vcs\.history\.rewrite\.shared /u, id);
    assert.match(verdict.reason, /unreadable-target/u, id);
    assert.equal(rawLog(dir), log, `${id}: a human-only refusal appends nothing`);
  }
});

// ---------------------------------------------------------------------------
// APRV-648 fix round 3: ONE closed rule for every judge (Carter's FAIL-CLOSED
// ruling, L10075). Every dash word must be, exactly, on the verb's list of
// options that take no value; anything else is shared. Each case below was
// `.local` (or outside the family) at 43031065. Classification only: no
// rewrite runs, and no rebase state is written.
// ---------------------------------------------------------------------------

/** A branch whose whole history is unshared: an orphan with one commit, no upstream. */
function orphanRepo(policy = PROPOSED): string {
  const dir = newRepo(policy);
  branch(dir, "lane");
  commit(dir, "l1");
  git(dir, "checkout", "--quiet", "--orphan", "scratch");
  commit(dir, "s1");
  return dir;
}

test("APRV-648 fix round 3, M1: `git rebase --root <branch>` is shared; git rewrites <branch>, not HEAD's branch", () => {
  const dir = orphanRepo();
  // At 43031065 the first three were `.local` range-unpublished: the hook
  // judged HEAD (`scratch`), git rewrites `main` (or `lane`) from its root.
  for (const command of [
    "git rebase --root main",
    "git rebase --root -f main",
    "git rebase --root --ignore-date lane",
    "git rebase --root --signoff main",
    "git rebase --root",
    "git rebase --root=x main",
    "git rebase --roo main",
    "git rebase -f --root main",
  ]) {
    assertMember(dir, command, "shared", "option-unvetted", BRANCH);
  }
  for (const command of [
    "git rebase --root --onto lane main",
    "git rebase --onto lane --root main",
    "git rebase --root --onto=lane main",
  ]) {
    assertMember(dir, command, "shared", "option-unvetted", BRANCH);
  }
});

test("APRV-648 fix round 3, M2: reset --hard reads no option's value as its target", () => {
  const dir = newRepo(PROPOSED);
  branch(dir, "lane");
  commit(dir, "l1");
  commit(dir, "l2");
  pushUpstream(dir, "lane");
  // An empty file named `@`: git reads no pathspec from it and resets to HEAD~1.
  writeFileSync(join(dir, "@"), "", "utf8");
  // At 43031065 this was `.local` no-commits-lost: the hook read `@` (HEAD).
  assertMember(dir, "git reset --hard --pathspec-from-file @ HEAD~1", "shared", "option-unvetted", BARE);
  for (const command of [
    "git reset --hard --pathspec-from-file=@ HEAD~1",
    "git reset --hard --pathspec-from-file=@",
    "git reset --hard --pathspec-file-nul --pathspec-from-file @ HEAD~1",
    "git reset --hard --pathspec-fr @ HEAD~1",
    "git reset --hard --recurse-submodules HEAD",
    "git reset --soft --hard HEAD",
    "git reset --hard -- HEAD",
    "git reset --hard --end-of-options HEAD",
  ]) {
    assertMember(dir, command, "shared", "option-unvetted", BARE);
  }
  // Two positionals: git dies on paths with --hard; the judge does not pick one.
  assertMember(dir, "git reset --hard HEAD HEAD~1", "shared", "unreadable-target", BARE);
  // The zero-value spellings are still judged.
  assertMember(dir, "git reset --hard", "local", "no-commits-lost", BARE);
  assertMember(dir, "git reset -q --hard --no-refresh HEAD", "local", "no-commits-lost", BARE);
  assertMember(dir, "git reset --hard 'HEAD~1'", "shared", "shared-commit", BARE);
});

// ---------------------------------------------------------------------------
// APRV-648 S1: a positional the shell may still change is shared
// ---------------------------------------------------------------------------
//
// Each pair below is the same target spelled two ways. The lexer reads both
// as the same text, a ref that resolves, but only the first is
// `LexWord.exact`: in the second the shell would hand git other bytes. `.local`
// needs a positive reading of every word, so the second is shared.

test("APRV-648 S1 (a): a brace-expansion positional is shared; the quoted spelling is judged", () => {
  const dir = newRepo();
  // A ref whose name is the brace word: git resolves the lexer's text, while
  // bash hands git `b b` for the unquoted spelling.
  git(dir, "branch", "b{,}", "main");
  branch(dir, "lane");
  commit(dir, "l1");
  commit(dir, "l2");
  assertMember(dir, "git reset --hard 'b{,}'", "local", "range-unpublished", BRANCH);
  assertMember(dir, "git reset --hard b{,}", "shared", "unreadable-target", BRANCH);
});

test("APRV-648 S1 (b): a double-quoted backslash the shell keeps makes the positional shared", () => {
  const dir = newRepo();
  branch(dir, "lane");
  commit(dir, "l1");
  commit(dir, "l2");
  assertMember(dir, 'git reset --hard "origin/main"', "local", "range-unpublished", BRANCH);
  // The lexer drops the backslash and reads `origin/main`; the shell keeps it.
  assertMember(dir, 'git reset --hard "origin/m\\ain"', "shared", "unreadable-target", BRANCH);
});

test("APRV-648 S1 (c): an unquoted non-leading tilde makes the positional shared", () => {
  const dir = newRepo();
  branch(dir, "lane");
  commit(dir, "l1");
  commit(dir, "l2");
  assertMember(dir, "git reset --hard 'origin/main~0'", "local", "range-unpublished", BRANCH);
  assertMember(dir, "git reset --hard origin/main~0", "shared", "unreadable-target", BRANCH);
  // The rebase judge reads its upstream through the same predicate.
  assertMember(dir, "git rebase 'origin/main~0'", "local", "range-unpublished", BRANCH);
  assertMember(dir, "git rebase origin/main~0", "shared", "unreadable-target", BRANCH);
});

test("APRV-648 fix round 3, M3: a rebasing pull hidden behind a swallowed --no-rebase joins the family, shared", () => {
  const dir = newRepo(PROPOSED);
  commit(dir, "m2");
  // On main with its upstream. At 43031065 each of these was `vcs.commit.branch`,
  // outside the family: the classifier let the swallowed `--no-rebase` win.
  for (const command of [
    "git pull -r -o --no-rebase origin",
    "git pull -r --server-option --no-rebase origin",
    "git pull -r --server-option=--no-rebase",
    "git pull -r -o=--no-rebase",
  ]) {
    assert.equal(probe(dir, command).rule, "git-pull-rebase", command);
    assertMember(dir, command, "shared", "default-branch", BRANCH);
  }
  // With pull.rebase=true, a `--no-rebase` that is `-o`'s value no longer
  // blocks the promotion (at 43031065 the substring test did).
  git(dir, "config", "pull.rebase", "true");
  for (const command of [
    "git pull -o --no-rebase",
    "git pull --server-option=--no-rebase",
    "git pull --server-option --no-rebase origin",
    "git pull --serv --no-rebase",
  ]) {
    assert.equal(probe(dir, command).rule, "git-write", command);
    assertMember(dir, command, "shared", "default-branch", BRANCH);
  }
  // An explicit merge in option position still keeps the configuration out.
  assertUnrefined(dir, "git pull --no-rebase", BRANCH);
  assertUnrefined(dir, "git pull -o x --no-rebase", BRANCH);
});

test("APRV-648 fix round 3: the pull judge takes zero-value options and no positional", () => {
  const dir = newRepo(PROPOSED);
  branch(dir, "lane");
  commit(dir, "l1");
  pushUpstream(dir, "lane");
  commit(dir, "l2");
  assertMember(dir, "git pull --rebase", "local", "range-unpublished", BRANCH);
  assertMember(dir, "git pull -r -q --autostash", "local", "range-unpublished", BRANCH);
  // At 43031065 `-o x` was skipped and `x` read as the remote, so this was local.
  assertMember(dir, "git pull -r -o x", "shared", "option-unvetted", BRANCH);
  assertMember(dir, "git pull -r --depth 1", "shared", "option-unvetted", BRANCH);
  assertMember(dir, "git pull --rebase=true", "shared", "option-unvetted", BRANCH);
  // git maps <remote> <branch> through the remote's fetch refspec; the judge
  // does not model that, so any positional is shared.
  assertMember(dir, "git pull --rebase origin lane", "shared", "unreadable-target", BRANCH);
  assertMember(dir, "git pull --rebase origin", "shared", "unreadable-target", BRANCH);
});

test("APRV-648 fix round 3: the amend judge takes zero-value options and no pathspec", () => {
  const dir = newRepo(PROPOSED);
  branch(dir, "lane");
  commit(dir, "l1");
  assertMember(dir, "git commit --amend", "local", "range-unpublished", BRANCH);
  assertMember(dir, "git commit -a --amend --no-edit -q", "local", "range-unpublished", BRANCH);
  for (const command of [
    'git commit --amend -m "x"',
    "git commit --amend --message=x",
    "git commit --amend -C HEAD",
    "git commit --amend --author=x",
    "git commit --amend --fixup=HEAD",
    "git commit --amend --am",
    "git commit --amend --pathspec-from-file=f",
    "git commit -am x --amend",
  ]) {
    assertMember(dir, command, "shared", "option-unvetted", BRANCH);
  }
  assertMember(dir, "git commit --amend l1.txt", "shared", "unreadable-target", BRANCH);
});

test("APRV-648 fix round 3, N1: only the bare `git` is git, before a rewrite and as the rewrite", () => {
  const dir = newRepo(PROPOSED);
  branch(dir, "lane");
  commit(dir, "l1");
  // At 43031065 both were `.local`: `./git status` passed as a harmless earlier segment.
  assertMember(dir, "./git status && git commit --amend --no-edit", "shared", "compound-state", BRANCH, 1);
  assertMember(dir, "/tmp/x/git add . && git commit --amend --no-edit", "shared", "compound-state", BRANCH, 1);
  assertMember(dir, "git status && git commit --amend --no-edit", "local", "range-unpublished", BRANCH, 1);
  assertMember(dir, "./git commit --amend --no-edit", "shared", "global-option", BRANCH);
});

test("APRV-648 fix round 3, in the hook: under the proposed lines each M is denied as .shared", () => {
  const cases: [string, string, string][] = [];
  const m1 = orphanRepo();
  attest(m1);
  cases.push([m1, "git rebase --root main", "m1-root"]);
  cases.push([m1, "git rebase --root -f lane", "m1-root-f"]);
  const m2 = newRepo(PROPOSED);
  branch(m2, "lane");
  commit(m2, "l1");
  commit(m2, "l2");
  pushUpstream(m2, "lane");
  writeFileSync(join(m2, "@"), "", "utf8");
  attest(m2);
  cases.push([m2, "git reset --hard --pathspec-from-file @ HEAD~1", "m2-pathspec"]);
  const m3 = newRepo(PROPOSED);
  commit(m3, "m2");
  attest(m3);
  cases.push([m3, "git pull -r -o --no-rebase origin", "m3-server-option"]);
  cases.push([m3, "git pull -r --server-option=--no-rebase", "m3-server-option-attached"]);
  for (const [dir, command, id] of cases) {
    const log = rawLog(dir);
    const verdict = hook(dir, command, id);
    assert.equal(verdict.permission, "deny", `${id}: ${verdict.reason}`);
    assert.match(verdict.reason, /^hook-class-human-only: class vcs\.history\.rewrite\.shared /u, id);
    assert.equal(rawLog(dir), log, `${id}: a human-only refusal appends nothing`);
  }
});
