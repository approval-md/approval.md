/**
 * APRV-518 beside the no-rule abstain (`defaults.unclassified_command:
 * abstain`), which main gained after APRV-518 was first written.
 *
 * Under that key a segment no built-in rule covers stands in as
 * `NO_RULE_CLASS` and the harness decides, when every other segment is a
 * read. APRV-518 must never get looser through it:
 *
 * (i)   a `git config remote.*` / `push.*` write, which APRV-518 leaves with
 *       no row on purpose, keeps the deny: `git` is a binary the table knows,
 *       and a known binary's unlisted subcommand never stands in;
 * (ii)  a no-rule stand-in before a `git push`, or beside it on a line that
 *       runs segments at the same time, is NOT a read for the push-repository
 *       pass's trust rule, so the push is answered as unreadable;
 * (iii) no line holding a mutating `git remote`, a write into `.git` or into
 *       a git configuration file, or a push ever abstains. On 0.4.8,
 *       `railway status && git remote add --mirror=push m <url>` abstained,
 *       because the remote write classified `read.vcs.remote`.
 *
 * Hermetic: HOME is a fixture directory and system configuration is off for
 * every git this file runs and for the git the refinement runs.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyForHook } from "../src/cli/hook.js";
import { classifyCommand, NO_RULE_CLASS } from "../src/core/command-class.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-remote-abstain-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

const HOME = join(scratch, "home");
mkdirSync(HOME);
writeFileSync(
  join(HOME, ".gitconfig"),
  ["[user]", "\tname = Abstain Oracle", "\temail = oracle@example.invalid", "[init]", "\tdefaultBranch = main", ""].join("\n"),
);
// classifyForHook runs git with this process's environment.
process.env["HOME"] = HOME;
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
process.env["GIT_TERMINAL_PROMPT"] = "0";
delete process.env["GIT_CONFIG_GLOBAL"];
delete process.env["GIT_DIR"];
delete process.env["GIT_WORK_TREE"];

const ENV: NodeJS.ProcessEnv = { ...process.env };
delete ENV["APPROVAL_HUMAN"];

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: readonly string[], cwd: string, input = ""): Run {
  const result = spawnSync(cmd, [...args], { cwd, encoding: "utf8", env: ENV, input });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function git(cwd: string, ...args: string[]): void {
  const ran = run("git", args, cwd);
  assert.equal(ran.code, 0, `git ${args.join(" ")}: ${ran.stderr}`);
}

const GIT = spawnSync("git", ["--version"], { env: ENV }).status === 0;
const skip = GIT ? false : "no git binary";

/** This repository's push lines, plus the abstain key. */
const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "  unclassified_command: abstain",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  vcs.commit.branch:",
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
  "```",
  "",
].join("\n");

let cases = 0;

/** A checkout on the feature branch `lane`, a bare remote beside it, and an attested abstain policy. */
function checkout(): string {
  cases += 1;
  const root = join(scratch, `case-${String(cases)}`);
  const dir = join(root, "clone");
  mkdirSync(dir, { recursive: true });
  git(root, "init", "-q", "--bare", "remote.git");
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", "../remote.git");
  git(dir, "commit", "-q", "--allow-empty", "-m", "c0");
  git(dir, "checkout", "-q", "-b", "lane");
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const attested = run(process.execPath, [CLI_ENTRY, "policy", "attest", "--dir", dir, "--log", logPath(dir), "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

function logPath(dir: string): string {
  return join(dir, ".approval", "log", "events.jsonl");
}

function rawLog(dir: string): string {
  return existsSync(logPath(dir)) ? readFileSync(logPath(dir), "utf8") : "";
}

let toolUse = 0;

function claude(dir: string, command: string): Run {
  toolUse += 1;
  const event = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "cc-sess-remote-abstain",
    tool_use_id: `t-remote-abstain-${String(toolUse)}`,
    cwd: dir,
    tool_name: "Bash",
    tool_input: { command },
  });
  return run(process.execPath, [CLI_ENTRY, "hook", "claude-code", "--as", "agent:cc", "--dir", dir], dir, event);
}

function verdict(ran: Run): { permission: string; reason: string } {
  assert.equal(ran.code, 0, ran.stderr);
  assert.notEqual(ran.stdout, "", "a verdict was printed (an abstain prints nothing)");
  const parsed = JSON.parse(ran.stdout) as { hookSpecificOutput?: Record<string, unknown> };
  const out = parsed.hookSpecificOutput ?? {};
  return { permission: String(out["permissionDecision"]), reason: String(out["permissionDecisionReason"]) };
}

/** A command the rule table has no row for, whose words pass every no-rule guard. */
const NO_RULE = "railway status";

const NEUTRAL_CWDS = [join(scratch, "neutral")];

// ---------------------------------------------------------------------------
// (i) git config writes keep the deny
// ---------------------------------------------------------------------------

/** `git config` writes of the keys that steer a push, spelled so every no-rule word guard passes. */
const CONFIG_WRITES = [
  "git config remote.origin.mirror true",
  "git config remote.origin.push lane",
  "git config push.followtags true",
  "git config push.recursesubmodules check",
  "git config submodule.recurse true",
  "git config --global remote.origin.mirror true",
  "git config --add remote.origin.push main",
  "git config remote.backup.url origin",
];

test("(i) a git config write of a push key never stands in: alone, after or before a no-rule segment, it keeps the refusal", () => {
  for (const write of CONFIG_WRITES) {
    for (const command of [write, `${NO_RULE} && ${write}`, `${write}; ${NO_RULE}`, `${NO_RULE} | ${write}`]) {
      const result = classifyCommand(command, [], { noRuleSegments: true, noRuleCwds: NEUTRAL_CWDS });
      assert.equal(result.ok, false, `${command} must not classify: ${JSON.stringify(result)}`);
      if (result.ok) continue;
      assert.equal(result.code, "unclassified", command);
      assert.equal(result.segment, write, `${command}: the refusal is the git config segment`);
    }
  }
});

test("(i) control: the plain no-rule segment does stand in, so the refusal above is the known-binary guard", () => {
  const result = classifyCommand(`git status && ${NO_RULE}`, [], { noRuleSegments: true, noRuleCwds: NEUTRAL_CWDS });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(result.classes, ["read.shell", NO_RULE_CLASS]);
});

test("(i, hook) git config writes of push keys are denied hook-unclassified under an attested abstain policy", { skip }, () => {
  const dir = checkout();
  const before = rawLog(dir);
  for (const command of ["git config remote.origin.mirror true", `${NO_RULE} && git config push.followtags true`]) {
    const v = verdict(claude(dir, command));
    assert.equal(v.permission, "deny", `${command}: ${v.reason}`);
    assert.match(v.reason, /^hook-unclassified: no rule for git config/u, command);
  }
  assert.equal(rawLog(dir), before);
});

// ---------------------------------------------------------------------------
// (ii) a no-rule stand-in is not a read for the push's trust rule
// ---------------------------------------------------------------------------

function pushSegment(dir: string, command: string, noRule: boolean): { class: string; rule: string; notes: string[] } {
  const refined = classifyForHook(command, [], dir, [], false, [], noRule);
  assert.equal(refined.result.ok, true, `${command}: ${JSON.stringify(refined.result)}`);
  if (!refined.result.ok) throw new Error("unreachable");
  const push = refined.result.segments.find((segment) => segment.text.startsWith("git push"));
  assert.ok(push !== undefined, `${command}: a push segment`);
  return { class: push.class, rule: push.rule, notes: refined.notes };
}

test("(ii) a no-rule stand-in before a push makes the push unreadable; a read before it does not", { skip }, () => {
  const dir = checkout();
  // Controls: alone, or after a read, the hook trusts its reading of the checkout.
  assert.deepEqual(
    { ...pushSegment(dir, "git push -u origin lane", true), notes: [] },
    { class: "vcs.push.branch", rule: "git-push-branch", notes: [] },
  );
  assert.deepEqual(
    { ...pushSegment(dir, "git status && git push origin HEAD", true), notes: [] },
    { class: "vcs.push.branch", rule: "git-push-branch", notes: [] },
  );
  // The stand-in runs first: the push's refs are on the line, so at least release.publish.
  for (const command of [`${NO_RULE}; git push origin HEAD`, `${NO_RULE} && git push origin @`, `${NO_RULE} || git push origin lane:lane`]) {
    const answer = pushSegment(dir, command, true);
    assert.equal(answer.class, "release.publish", `${command}: ${JSON.stringify(answer)}`);
    assert.equal(answer.rule, "git-push-config-unreadable", command);
    assert.ok(
      answer.notes.some((note) => note.startsWith("push-repo: ") && note.includes(`\`${NO_RULE}\` runs first`)),
      `${command}: the note names the stand-in (${answer.notes.join(" | ")})`,
    );
  }
  // A push its configuration decides (no refspec, or a colon-less name a
  // configured refspec may map) is the rewrite class.
  for (const command of [`${NO_RULE} && git push`, `${NO_RULE} && git push origin`, `${NO_RULE} && git push -u origin lane`]) {
    const answer = pushSegment(dir, command, true);
    assert.equal(answer.class, "vcs.history.rewrite", `${command}: ${JSON.stringify(answer)}`);
    assert.equal(answer.rule, "git-push-config-unreadable", command);
  }
});

test("(ii) a no-rule stand-in running alongside a push (|, &) makes the push unreadable, after it too", { skip }, () => {
  const dir = checkout();
  // (A stand-in fed by a pipe is no stand-in at all: the no-rule guard refuses a stdin-fed segment.)
  for (const command of [`${NO_RULE} | git push origin lane:lane`, `git push origin lane:lane & ${NO_RULE}`, `${NO_RULE} & git push origin HEAD`]) {
    const answer = pushSegment(dir, command, true);
    assert.equal(answer.class, "release.publish", `${command}: ${JSON.stringify(answer)}`);
    assert.equal(answer.rule, "git-push-config-unreadable", command);
    assert.ok(answer.notes.some((note) => note.includes("runs alongside it")), `${command}: ${answer.notes.join(" | ")}`);
  }
  // Sequenced after the push, the stand-in cannot change what the push read.
  const later = pushSegment(dir, `git push origin lane:lane; ${NO_RULE}`, true);
  assert.equal(later.class, "vcs.push.branch", JSON.stringify(later));
});

test("(ii) the push-repository pass runs first in the chain under noRuleSegments, and its note leads", { skip }, () => {
  const dir = checkout();
  const refined = classifyForHook(`${NO_RULE} && git push origin`, [], dir, [], false, [], true);
  assert.equal(refined.result.ok, true);
  if (!refined.result.ok) return;
  assert.deepEqual(refined.result.classes, [NO_RULE_CLASS, "vcs.history.rewrite"]);
  assert.match(refined.notes[0] ?? "", /^push-repo: `git push origin` is vcs\.history\.rewrite \(git-push-config-unreadable\)/u);
  // The stand-in itself is untouched by the pass.
  assert.deepEqual(
    { class: refined.result.segments[0]?.class, rule: refined.result.segments[0]?.rule },
    { class: NO_RULE_CLASS, rule: "no-rule" },
  );
});

// ---------------------------------------------------------------------------
// (iii) no line holding a remote write, a .git write, a git config file write or a push abstains
// ---------------------------------------------------------------------------

test("(iii) control: a no-rule segment beside a git remote READ still abstains in this fixture", { skip }, () => {
  const dir = checkout();
  const before = rawLog(dir);
  for (const command of [`${NO_RULE} && git remote -v`, `git remote get-url origin; ${NO_RULE}`]) {
    const ran = claude(dir, command);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.stdout, "", `${command} abstains: ${ran.stdout}`);
    assert.equal(ran.stderr, "");
  }
  assert.equal(rawLog(dir), before);
});

const NEVER_ABSTAIN: readonly string[] = [
  // A mutating git remote: on 0.4.8 the first line abstained (read.vcs.remote).
  `${NO_RULE} && git remote add --mirror=push m ../remote.git`,
  `${NO_RULE} && git remote add m ../remote.git`,
  `git remote set-url origin ../remote.git; ${NO_RULE}`,
  `${NO_RULE} && git remote rename origin m`,
  `${NO_RULE} && git remote remove origin`,
  `${NO_RULE} && git remote set-head origin main`,
  `${NO_RULE} && git remote prune origin`,
  `${NO_RULE} && git remote update --prune`,
  `${NO_RULE} | git remote set-branches origin main`,
  // A write into .git.
  `${NO_RULE} && rm -f .git/index.lock`,
  `${NO_RULE} && printf x >> .git/config`,
  `${NO_RULE}; cp hook.sh .git/hooks/pre-push`,
  `${NO_RULE} && touch .GIT/config`,
  // A write to a git configuration file.
  `${NO_RULE} && printf x >> ~/.gitconfig`,
  `${NO_RULE} && cp g ~/.config/git/config`,
  // A push.
  `${NO_RULE} && git push -u origin lane`,
  `${NO_RULE} && git push origin HEAD`,
  `${NO_RULE} | git push origin`,
  `git push origin lane; ${NO_RULE}`,
];

test("(iii) a line with a remote write, a .git write, a git config file write or a push never abstains", { skip }, () => {
  const dir = checkout();
  const before = rawLog(dir);
  for (const command of NEVER_ABSTAIN) {
    const ran = claude(dir, command);
    const v = verdict(ran);
    assert.equal(v.permission, "deny", `${command}: ${v.reason}`);
  }
  assert.equal(rawLog(dir), before, "nothing was appended");
});

test("(iii) the same lines classify with a side-effecting class beside the stand-in, which is what refuses the abstain", { skip }, () => {
  const dir = checkout();
  for (const command of NEVER_ABSTAIN) {
    const refined = classifyForHook(command, [], dir, [], false, [], true);
    assert.equal(refined.result.ok, true, `${command}: ${JSON.stringify(refined.result)}`);
    if (!refined.result.ok) continue;
    const others = refined.result.classes.filter((cls) => cls !== NO_RULE_CLASS);
    assert.ok(
      others.some((cls) => ["vcs.history.rewrite", "release.publish", "vcs.ref.delete", "vcs.push.main", "vcs.push.branch"].includes(cls)),
      `${command}: ${JSON.stringify(refined.result.classes)}`,
    );
  }
});
