/**
 * The hook end to end for APRV-518: `git remote` writes, a push its remote
 * configuration decides, and `HEAD`/`@`.
 *
 * Each case spawns the real compiled CLI as `approval hook claude-code` in a
 * git checkout that carries this repository's push policy lines, feeds it a
 * Bash PreToolUse event, and reads the verdict the harness would read. The
 * verdict names the class it was decided under (`autonomous: …`, `granted:
 * vcs.push.main needs no approval …`, `hook-class-human-only: …`).
 *
 * On main before this task, `git remote add --mirror=push m <url>` came back
 * `autonomous: read.vcs.remote` and the `git push m` after it `granted:
 * vcs.push.main`, while the push deleted remote branches; `git push origin
 * HEAD` on main came back `autonomous: vcs.push.branch`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-hook-remote-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

const HOME = join(scratch, "home");
mkdirSync(HOME);
writeFileSync(
  join(HOME, ".gitconfig"),
  ["[user]", "\tname = Hook Oracle", "\temail = oracle@example.invalid", "[init]", "\tdefaultBranch = main", ""].join("\n"),
);

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  HOME,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
delete ENV["APPROVAL_HUMAN"];
delete ENV["GIT_CONFIG_GLOBAL"];
delete ENV["GIT_DIR"];
delete ENV["GIT_WORK_TREE"];

function run(cmd: string, args: readonly string[], cwd: string, input = ""): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(cmd, [...args], { cwd, encoding: "utf8", env: ENV, input });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function git(cwd: string, ...args: string[]): void {
  const ran = run("git", args, cwd);
  assert.equal(ran.code, 0, `git ${args.join(" ")}: ${ran.stderr}`);
}

const GIT = spawnSync("git", ["--version"], { env: ENV }).status === 0;

/** The push lines of this repository's APPROVAL.md. */
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
  "  vcs.push.branch:",
  "    autonomy: autonomous",
  "  vcs.push.main:",
  "    autonomy: supervised-retro",
  "  vcs.history.rewrite:",
  "    autonomy: human-only",
  "  vcs.ref.delete:",
  "    autonomy: manual",
  "  release.publish:",
  "    autonomy: manual",
  "  policy.edit:",
  "    autonomy: manual",
  "  policy.core:",
  "    autonomy: manual",
  "  log.mutate:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

/** A checkout with an attested gate, a bare remote beside it, and a feature branch. */
function checkout(): string {
  const root = join(scratch, "case");
  const dir = join(root, "clone");
  mkdirSync(dir, { recursive: true });
  git(root, "init", "-q", "--bare", "remote.git");
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", "../remote.git");
  git(dir, "commit", "-q", "--allow-empty", "-m", "c0");
  git(dir, "branch", "lane");
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const attested = run(process.execPath, [CLI_ENTRY, "policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

let toolUse = 0;

function hook(dir: string, command: string): { permission: string; reason: string } {
  toolUse += 1;
  const event = JSON.stringify({
    session_id: "sess-remote",
    transcript_path: "/dev/null",
    cwd: "/repo",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "tidying remotes" },
    tool_use_id: `tu-remote-${toolUse}`,
  });
  const ran = run(process.execPath, [CLI_ENTRY, "hook", "claude-code", "--timeout", "200ms", "--interval", "50ms"], dir, event);
  assert.equal(ran.code, 0, `hook must exit 0 with a verdict: ${ran.stderr}`);
  const output = (JSON.parse(ran.stdout) as Record<string, Record<string, unknown>>)["hookSpecificOutput"];
  assert.ok(output !== undefined, "hookSpecificOutput is present");
  return { permission: String(output["permissionDecision"]), reason: String(output["permissionDecisionReason"]) };
}

const dir = GIT ? checkout() : "";
const skip = GIT ? false : "no git binary";

test("hook: a mirror remote cannot be added unasked; it is the human-only rewrite class", { skip }, () => {
  const verdict = hook(dir, "git remote add --mirror=push m ../remote.git");
  assert.equal(verdict.permission, "deny", verdict.reason);
  assert.match(verdict.reason, /^hook-class-human-only: /u);
  assert.match(verdict.reason, /vcs\.history\.rewrite/u);
});

test("hook: every other remote write is refused the same way", { skip }, () => {
  for (const command of ["git remote set-url origin ../remote.git", "git remote rename origin m", "git remote update --prune"]) {
    const verdict = hook(dir, command);
    assert.equal(verdict.permission, "deny", `${command}: ${verdict.reason}`);
    assert.match(verdict.reason, /^hook-class-human-only: /u, command);
  }
});

test("hook: the remote reads are still allowed unasked", { skip }, () => {
  for (const command of ["git remote -v", "git remote get-url origin", "git fetch origin"]) {
    const verdict = hook(dir, command);
    assert.equal(verdict.permission, "allow", `${command}: ${verdict.reason}`);
    assert.match(verdict.reason, /^autonomous: read\.vcs\.remote/u, command);
  }
});

test("hook: a mirror remote already configured (by a person) turns git push into the rewrite class", { skip }, () => {
  git(dir, "config", "remote.backup.url", "../remote.git");
  git(dir, "config", "remote.backup.mirror", "true");
  try {
    for (const command of ["git push backup", "git push", "git push --tags backup"]) {
      const verdict = hook(dir, command);
      assert.equal(verdict.permission, "deny", `${command}: ${verdict.reason}`);
      assert.match(verdict.reason, /^hook-class-human-only: /u, command);
    }
    // A push to another remote, by name, is not the mirror.
    const branch = hook(dir, "git push -u origin lane");
    assert.equal(branch.permission, "allow", branch.reason);
    assert.match(branch.reason, /^autonomous: vcs\.push\.branch/u);
  } finally {
    git(dir, "config", "--remove-section", "remote.backup");
  }
});

test("hook: HEAD on main is the trunk push; HEAD on a feature branch is that branch", { skip }, () => {
  git(dir, "checkout", "-q", "main");
  for (const command of ["git push origin HEAD", "git push -u origin @"]) {
    const verdict = hook(dir, command);
    assert.equal(verdict.permission, "allow", verdict.reason);
    assert.match(verdict.reason, /vcs\.push\.main/u, command);
  }
  git(dir, "checkout", "-q", "lane");
  for (const command of ["git push origin HEAD", "git push -u origin @"]) {
    const verdict = hook(dir, command);
    assert.equal(verdict.permission, "allow", verdict.reason);
    assert.match(verdict.reason, /^autonomous: vcs\.push\.branch/u, command);
  }
});

test("hook: a push behind a cd the hook cannot follow, whose configuration decides it, is refused as the rewrite class", { skip }, () => {
  const verdict = hook(dir, 'cd "$WT" && git push -u origin lane');
  assert.equal(verdict.permission, "deny", verdict.reason);
  assert.match(verdict.reason, /^hook-class-human-only: /u);
});

test("hook: a remote key written through git config stays refused as unclassified", { skip }, () => {
  const verdict = hook(dir, "git config remote.origin.mirror true");
  assert.equal(verdict.permission, "deny", verdict.reason);
  assert.match(verdict.reason, /^hook-unclassified: /u);
});

test("hook (steer): a push refspec written into .git/config by a shell redirect is refused with the push it arms", { skip }, () => {
  const verdict = hook(dir, "printf '[remote \"origin\"]\\n\\tpush = :refs/heads/lane\\n' >> .git/config && git push origin");
  assert.equal(verdict.permission, "deny", verdict.reason);
  assert.match(verdict.reason, /^hook-class-human-only: /u);
});

test("hook (steer): a destination git DWIMs to the trunk is the trunk push", { skip }, () => {
  for (const command of ["git push origin lane:heads/main", "git push origin lane:refs/heads/main"]) {
    const verdict = hook(dir, command);
    assert.equal(verdict.permission, "allow", verdict.reason);
    assert.match(verdict.reason, /vcs\.push\.main/u, command);
  }
});
