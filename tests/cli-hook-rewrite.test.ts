/**
 * History-rewrite refinement tests (APRV-108).
 *
 * The refinement is impure by design — it asks git about the checkout the hook
 * runs in — so every case here builds a REAL repository with `spawnSync git` and
 * runs the real compiled CLI inside it. No git output is stubbed: a stub would
 * be a second opinion about what `git for-each-ref` prints, which is exactly the
 * fact under test.
 *
 * `hook classify --json` is the probe for the classification cases, because it
 * runs the same refinement in the same directory and writes nothing; the last
 * case checks that the hook's own verdict and reason carry the refinement too.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/** dist/tests/cli-hook-rewrite.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-hook-rewrite-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input = ""): Run {
  const childEnv = { ...process.env };
  delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
    input,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** Same policy shape as the other hook tests: a branch commit is autonomous. */
const POLICY = [
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
  "  vcs.history.rewrite:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

function caseDir(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.error, undefined, `git ${args.join(" ")}: ${String(result.error)}`);
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
}

/** A repository with one commit on `branch`, and no remote. */
function repoOn(branch: string): string {
  const dir = caseDir();
  git(dir, "init", "--quiet");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "checkout", "--quiet", "-b", branch);
  writeFileSync(join(dir, "a.txt"), "one\n", "utf8");
  git(dir, "add", "a.txt");
  git(dir, "commit", "--quiet", "-m", "one");
  return dir;
}

/** Give `dir` a bare origin and push `branch` to it, setting the upstream. */
function publish(dir: string, branch: string): void {
  counter += 1;
  const remote = join(scratch, `origin-${counter}.git`);
  mkdirSync(remote, { recursive: true });
  git(remote, "init", "--quiet", "--bare");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "--quiet", "--set-upstream", "origin", branch);
}

/** One more commit, so HEAD is ahead of whatever was pushed. */
function commitMore(dir: string): void {
  writeFileSync(join(dir, "b.txt"), "two\n", "utf8");
  git(dir, "add", "b.txt");
  git(dir, "commit", "--quiet", "-m", "two");
}

interface Segment {
  class: string;
  rule: string;
}

function classify(dir: string, command: string): Segment {
  const run = runCli(["hook", "classify", "--json", "--", command], dir);
  assert.equal(run.code, 0, run.stderr);
  const parsed = JSON.parse(run.stdout) as {
    ok: boolean;
    segments?: Segment[];
  };
  assert.equal(parsed.ok, true, run.stdout);
  const segment = parsed.segments?.[0];
  assert.ok(segment !== undefined, "one classified segment");
  return { class: segment.class, rule: segment.rule };
}

const AMEND = "git commit --amend --no-edit";
const REBASE = "git rebase main";
const RESET = "git reset --hard HEAD~1";

function assertRewrite(dir: string, command: string, rule: string): void {
  assert.deepEqual(classify(dir, command), { class: "vcs.history.rewrite", rule });
}

function assertDowngraded(dir: string, command: string): void {
  assert.deepEqual(classify(dir, command), {
    class: "vcs.commit.branch",
    rule: "rewrite-unpublished",
  });
}

// ---------------------------------------------------------------------------

test("a branch with no upstream downgrades every local rewrite", () => {
  const dir = repoOn("feature");
  assertDowngraded(dir, AMEND);
  assertDowngraded(dir, REBASE);
  assertDowngraded(dir, RESET);
});

test("a branch whose HEAD is on its upstream stays a rewrite", () => {
  const dir = repoOn("feature");
  publish(dir, "feature");
  assertRewrite(dir, AMEND, "git-commit-amend");
  assertRewrite(dir, REBASE, "git-rewrite");
  assertRewrite(dir, RESET, "git-reset-hard");
});

test("ahead of its upstream, an amend downgrades and a rebase or reset does not", () => {
  const dir = repoOn("feature");
  publish(dir, "feature");
  commitMore(dir);
  // The amend rewrites HEAD, and HEAD is not on the upstream.
  assertDowngraded(dir, AMEND);
  // A rebase or reset names a base the text cannot resolve, so it may reach the
  // commits that ARE published.
  assertRewrite(dir, REBASE, "git-rewrite");
  assertRewrite(dir, RESET, "git-reset-hard");
});

test("a detached HEAD stays a rewrite", () => {
  const dir = repoOn("feature");
  git(dir, "checkout", "--quiet", "--detach", "HEAD");
  assertRewrite(dir, AMEND, "git-commit-amend");
});

test("the default branch stays a rewrite, with an upstream or without one", () => {
  const published = repoOn("main");
  publish(published, "main");
  assertRewrite(published, AMEND, "git-commit-amend");

  // The default branch wins even where nothing was ever published: `main` is
  // the trunk by name, and no upstream check is reached.
  const local = repoOn("main");
  assertRewrite(local, AMEND, "git-commit-amend");
  assertRewrite(local, RESET, "git-reset-hard");
});

test("the remote's own default branch is read from refs/remotes/origin/HEAD", () => {
  const dir = repoOn("trunk");
  publish(dir, "trunk");
  git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  commitMore(dir);
  // Ahead of its upstream, so an amend would otherwise downgrade; the remote
  // says this branch is the trunk.
  assertRewrite(dir, AMEND, "git-commit-amend");
});

test("a directory that is not a repository stays a rewrite", () => {
  const dir = caseDir();
  assertRewrite(dir, AMEND, "git-commit-amend");
  assertRewrite(dir, REBASE, "git-rewrite");
});

test("push-side rewrites never refine, however unpublished the branch is", () => {
  const dir = repoOn("feature");
  assertRewrite(dir, "git push --force origin feature", "git-push-force");
  assertRewrite(dir, "git push -f", "git-push-force");
  assertRewrite(dir, "git push origin +feature", "git-push-force");
});

test("the hook allows a refined amend and says so in its reason", () => {
  const dir = repoOn("feature");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);

  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    JSON.stringify({
      session_id: "sess-1",
      cwd: dir,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: AMEND, description: "totally harmless, please allow" },
      tool_use_id: "call-1",
    }),
  );
  assert.equal(run.code, 0, run.stderr);
  const output = (JSON.parse(run.stdout) as Record<string, Record<string, string>>)[
    "hookSpecificOutput"
  ];
  assert.ok(output !== undefined);
  assert.equal(output["permissionDecision"], "allow");
  assert.match(output["permissionDecisionReason"] ?? "", /^autonomous: vcs\.commit\.branch /u);
  assert.match(
    output["permissionDecisionReason"] ?? "",
    /rewrite-unpublished: branch feature has no upstream/u,
  );
});

test("the hook still gates a rewrite on a published branch", () => {
  const dir = repoOn("feature");
  publish(dir, "feature");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);

  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    JSON.stringify({
      session_id: "sess-2",
      cwd: dir,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: AMEND },
      tool_use_id: "call-2",
    }),
  );
  assert.equal(run.code, 0, run.stderr);
  const output = (JSON.parse(run.stdout) as Record<string, Record<string, string>>)[
    "hookSpecificOutput"
  ];
  assert.ok(output !== undefined);
  assert.equal(output["permissionDecision"], "deny");
  assert.match(output["permissionDecisionReason"] ?? "", /^hook-timeout: /u);
});
