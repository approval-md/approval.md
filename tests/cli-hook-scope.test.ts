/**
 * Where `approval hook claude-code` reads policy and appends records (APRV-101).
 *
 * The bug this file pins: `--dir` scoped only the policy while the log was
 * resolved from the process working directory, so a hook invoked with `--dir
 * <primary>` from an agent worktree read the primary's policy and wrote the
 * worktree's copy of `.approval/log/events.jsonl` — a chain forked from the real
 * one's tail, which no merge can reconcile. There is one log. The hook writes to
 * it, or it denies.
 *
 * As in `cli-hook.test.ts`, every case spawns the real compiled CLI and every
 * record is produced by a real verb; nothing is written into a log by hand. The
 * worktree cases shell out to git, and skip themselves when git is unavailable.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

/** dist/tests/cli-hook-scope.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-hook-scope-")));
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

/** git as the runtime runs it: no shell, output captured, failure is a value. */
function git(args: string[], cwd: string): Run {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error !== undefined) return { code: -1, stdout: "", stderr: String(result.error) };
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function haveGit(): boolean {
  return git(["--version"], scratch).code === 0;
}

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
  "  vcs.push.main:",
  "    autonomy: supervised",
  "  deps.add:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

const LOG = ".approval/log/events.jsonl";

function caseDir(name: string): string {
  counter += 1;
  const dir = join(scratch, `${name}-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  return dir;
}

/** A directory whose policy a human has attested, which is what creates the log. */
function attested(name: string): string {
  const dir = caseDir(name);
  const run = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.ok(existsSync(join(dir, LOG)));
  return dir;
}

function rawLog(dir: string): string {
  const path = join(dir, LOG);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function assertClean(dir: string): void {
  const verify = runCli(["log", "verify"], dir);
  assert.equal(verify.code, 0, `${verify.stdout}${verify.stderr}`);
}

function pushEvent(toolUseId: string): string {
  return JSON.stringify({
    session_id: "sess-scope",
    transcript_path: "/dev/null",
    cwd: "/repo",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git push origin main" },
    tool_use_id: toolUseId,
  });
}

interface Verdict {
  permission: string;
  reason: string;
}

function verdictOf(run: Run): Verdict {
  assert.equal(run.code, 0, `hook must exit 0 with a verdict: ${run.stderr}`);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  const output = parsed["hookSpecificOutput"] as Record<string, unknown>;
  return {
    permission: String(output["permissionDecision"]),
    reason: String(output["permissionDecisionReason"]),
  };
}

const HOOK = ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"];

/**
 * A git repository whose policy is attested, plus a linked worktree of it.
 *
 * `.approval/` is deliberately NOT committed here, so "nothing was created in
 * the worktree" is a statement about an empty directory rather than about a
 * checked-out file that happened not to change.
 */
function repoWithWorktree(name: string): { primary: string; worktree: string } {
  const primary = caseDir(name);
  assert.equal(git(["init", "-b", "main"], primary).code, 0);
  assert.equal(git(["config", "user.email", "test@example.com"], primary).code, 0);
  assert.equal(git(["config", "user.name", "Test"], primary).code, 0);
  assert.equal(git(["add", "APPROVAL.md"], primary).code, 0);
  const commit = git(["commit", "--no-gpg-sign", "-m", "policy"], primary);
  assert.equal(commit.code, 0, commit.stderr);

  const attest = runCli(["policy", "attest", "--as", "human:alice"], primary);
  assert.equal(attest.code, 0, attest.stderr);

  const worktree = join(primary, "wt");
  const added = git(["worktree", "add", "--detach", worktree], primary);
  assert.equal(added.code, 0, added.stderr);
  assert.ok(!existsSync(join(worktree, ".approval")), "the worktree starts with no .approval/");
  return { primary, worktree: realpathSync(worktree) };
}

// ===========================================================================

test("--dir scopes the log as well as the policy", () => {
  const primary = attested("dir-primary");
  const elsewhere = caseDir("dir-elsewhere");

  const before = rawLog(primary);
  const run = runCli([...HOOK, "--dir", primary], elsewhere, pushEvent("tu-dir"));
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "allow", verdict.reason);

  const after = rawLog(primary);
  assert.notEqual(after, before, "the record belongs in the directory --dir names");
  assert.match(after, /"event":"task\.registered"/u);
  assert.ok(
    !existsSync(join(elsewhere, ".approval")),
    "the working directory must not grow a log of its own",
  );
  assertClean(primary);
});

test("an explicit --log still wins over --dir", () => {
  const policySide = attested("log-policy");
  const logSide = attested("log-target");

  const beforePolicySide = rawLog(policySide);
  const beforeLogSide = rawLog(logSide);
  const run = runCli(
    [...HOOK, "--dir", policySide, "--log", join(logSide, LOG)],
    scratch,
    pushEvent("tu-log"),
  );
  assert.equal(verdictOf(run).permission, "allow");
  assert.equal(rawLog(policySide), beforePolicySide, "--log names the log, --dir does not");
  assert.notEqual(rawLog(logSide), beforeLogSide);
  assertClean(logSide);
});

test("with no flags, a plain checkout resolves to itself", (t: TestContext) => {
  if (!haveGit()) {
    t.skip("git is not available on this host");
    return;
  }
  const primary = caseDir("plain");
  assert.equal(git(["init", "-b", "main"], primary).code, 0);
  const attest = runCli(["policy", "attest", "--as", "human:alice"], primary);
  assert.equal(attest.code, 0, attest.stderr);

  const before = rawLog(primary);
  const run = runCli(HOOK, primary, pushEvent("tu-plain"));
  assert.equal(verdictOf(run).permission, "allow");
  assert.notEqual(rawLog(primary), before);
  assertClean(primary);
});

test("with no flags, a worktree session writes to the primary checkout's log", (t: TestContext) => {
  if (!haveGit()) {
    t.skip("git is not available on this host");
    return;
  }
  const { primary, worktree } = repoWithWorktree("worktree");

  const before = rawLog(primary);
  const run = runCli(HOOK, worktree, pushEvent("tu-worktree"));
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "allow", verdict.reason);

  assert.notEqual(rawLog(primary), before, "the record lands in the primary checkout's log");
  assert.match(rawLog(primary), /"event":"task\.registered"/u);
  assert.ok(
    !existsSync(join(worktree, ".approval")),
    "no .approval/ may appear inside the worktree",
  );
  assertClean(primary);
});

test("a worktree whose primary has no log denies with hook-log-unreachable", (t: TestContext) => {
  if (!haveGit()) {
    t.skip("git is not available on this host");
    return;
  }
  const { primary, worktree } = repoWithWorktree("worktree-nolog");
  rmSync(join(primary, ".approval"), { recursive: true, force: true });

  const run = runCli(HOOK, worktree, pushEvent("tu-nolog"));
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-log-unreachable: /u);
  assert.ok(verdict.reason.includes(primary), `the detail names ${primary}: ${verdict.reason}`);
  assert.ok(verdict.reason.includes("approval init"), verdict.reason);
  assert.ok(
    !existsSync(join(worktree, ".approval")),
    "a refusal must not scaffold a log in the worktree",
  );
  assert.ok(!existsSync(join(primary, ".approval")), "nor in the primary checkout");
});
