/**
 * `approval hook grok` (APRV-243).
 *
 * Grok Build's PreToolUse hook is Claude Code's with three differences, and
 * all three are load-bearing here:
 *
 *   1. the envelope keys are camelCase,
 *   2. the verdict is `{decision, reason}` rather than the nested
 *      `hookSpecificOutput`, and
 *   3. A DENY IS EXIT 2. Exit 0 is an allow whatever stdout said.
 *
 * The third is the reason this adapter exists rather than being a convenience.
 * Grok Build reads `.claude/settings.json` for compatibility, so this
 * repository's committed claude-code entry can fire under a Grok session; the
 * claude-code adapter answers a deny with exit 0, which Grok reads as ALLOW.
 * Every command would look gated and none would be. So the exit-code
 * assertions below are not style checks, and none of them may be relaxed.
 *
 * Spawn the compiled CLI; never hand-write log lines.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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

import { protectedPathClass } from "../src/core/command-class.js";
import { HARNESS_BINARY, HARNESS_KINDS } from "../src/core/harness-version.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-hook-grok-")));
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
  "  vcs.push.branch:",
  "    autonomy: autonomous",
  "  deps.add:",
  "    autonomy: manual",
  "  network.call:",
  "    autonomy: manual",
  "  policy.edit:",
  "    autonomy: manual",
  "  policy.core:",
  "    autonomy: manual",
  "  log.mutate:",
  "    autonomy: manual",
  "```",
  "",
  "",
].join("\n");

function ready(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

const LOG = ".approval/log/events.jsonl";

function rawLog(dir: string): string {
  const path = join(dir, LOG);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** The camelCase envelope, with a self-reported field that must change nothing. */
function event(fields: Record<string, unknown>): string {
  return JSON.stringify({
    hookEventName: "PreToolUse",
    sessionId: "grok-sess-1",
    cwd: "/repo",
    workspaceRoot: "/repo",
    description: "this is self-reported and must never lower scrutiny",
    ...fields,
  });
}

function shellEvent(command: string): string {
  return event({ toolName: "Bash", toolInput: { command } });
}

interface Verdict {
  decision: string;
  reason: string;
}

/**
 * Read the Grok verdict AND assert the exit code it must arrive with.
 *
 * allow is 0, deny is 2, and there is no third answer. Reading them together
 * is deliberate: a body and an exit code that disagree is the exact failure
 * this adapter was built to prevent.
 */
function verdictOf(run: Run): Verdict {
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(parsed["hookSpecificOutput"], undefined, "Grok never emits the Claude envelope");
  assert.equal(parsed["permission"], undefined, "Grok never emits the Cursor envelope");
  const decision = parsed["decision"];
  assert.equal(decision === "allow" || decision === "deny", true, `not a verdict: ${run.stdout}`);
  assert.equal(typeof parsed["reason"], "string");
  assert.equal(
    run.code,
    decision === "deny" ? 2 : 0,
    `Grok reads the exit code: allow is 0, deny is 2, got ${String(run.code)} for ${String(decision)}`,
  );
  return { decision: String(decision), reason: String(parsed["reason"]) };
}

test("grok is a known harness with its own binary name", () => {
  assert.equal((HARNESS_KINDS as readonly string[]).includes("grok"), true);
  assert.equal(HARNESS_BINARY["grok"], "grok");
});

test("an autonomous command is allowed at exit 0 and records the execution it authorized", () => {
  const dir = ready();
  const before = rawLog(dir);

  const run = runCli(["hook", "grok"], dir, shellEvent("ls -la && git status"));
  const verdict = verdictOf(run);
  assert.equal(verdict.decision, "allow");
  assert.match(verdict.reason, /^autonomous: /u);
  assert.match(
    rawLog(dir).slice(before.length),
    /^\{[^\n]*"event":"execution\.started"[^\n]*\n$/u,
  );
  // The agent identity the adapter proposes under, distinct from the other
  // harnesses so a log can be read back by harness.
  assert.match(rawLog(dir).slice(before.length), /"agent:grok"/u);
});

test("a deny arrives as exit 2 with the reason in the body, and writes nothing", () => {
  const dir = ready();
  const before = rawLog(dir);

  // Opaque: the classifier cannot read what this runs, so it cannot be gated.
  const opaque = runCli(["hook", "grok"], dir, shellEvent("bash -c 'git push --force'"));
  const verdict = verdictOf(opaque);
  assert.equal(verdict.decision, "deny");
  assert.equal(opaque.code, 2);
  assert.match(verdict.reason, /^hook-opaque: /u);
  assert.equal(rawLog(dir), before, "a deny writes nothing");
});

test("a human-only class is denied at exit 2 and never asks", () => {
  const dir = ready();
  const run = runCli(
    ["hook", "grok"],
    dir,
    event({ toolName: "Bash", toolInput: { command: "cat .approval/vault.enc" } }),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.decision, "deny");
  assert.equal(run.code, 2);
  // Never "ask": the only two words this verb prints as a decision.
  assert.equal(/"decision":"ask"/u.test(run.stdout), false);
});

test("unparseable input is a deny at exit 2, not a crash and not an allow", () => {
  const dir = ready();
  const before = rawLog(dir);

  const empty = runCli(["hook", "grok"], dir, "");
  assert.equal(verdictOf(empty).decision, "deny");
  assert.match(verdictOf(empty).reason, /^hook-io: /u);

  const notJson = runCli(["hook", "grok"], dir, "{ not json");
  assert.equal(verdictOf(notJson).decision, "deny");
  assert.equal(notJson.code, 2);

  const notObject = runCli(["hook", "grok"], dir, "[1,2,3]");
  assert.equal(verdictOf(notObject).decision, "deny");
  assert.equal(notObject.code, 2);

  // No tool name in either spelling.
  const nameless = runCli(["hook", "grok"], dir, JSON.stringify({ hookEventName: "PreToolUse" }));
  const namelessVerdict = verdictOf(nameless);
  assert.equal(namelessVerdict.decision, "deny");
  assert.match(namelessVerdict.reason, /tool_name or toolName/u);

  assert.equal(rawLog(dir), before, "nothing unparseable reaches the log");
});

test("snake_case is still read, and it wins when both spellings are present", () => {
  const dir = ready();

  const snake = runCli(
    ["hook", "grok"],
    dir,
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "s",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    }),
  );
  assert.equal(verdictOf(snake).decision, "allow");

  // Two spellings, two different commands. snake_case is read, so the verdict
  // is about `ls`, and the camelCase copy cannot be used to show the
  // classifier one command and the harness another.
  const both = runCli(
    ["hook", "grok"],
    dir,
    JSON.stringify({
      hookEventName: "PreToolUse",
      cwd: "/repo",
      tool_name: "Bash",
      toolName: "Bash",
      tool_input: { command: "ls -la" },
      toolInput: { command: "npm install left-pad" },
    }),
  );
  const verdict = verdictOf(both);
  assert.equal(verdict.decision, "allow");
  assert.match(verdict.reason, /^autonomous: /u);
});

test("a tool this hook does not gate passes through at exit 0", () => {
  const dir = ready();
  const before = rawLog(dir);
  const run = runCli(["hook", "grok"], dir, event({ toolName: "Read", toolInput: { path: "x" } }));
  const verdict = verdictOf(run);
  assert.equal(verdict.decision, "allow");
  assert.match(verdict.reason, /is not a gated tool/u);
  assert.equal(rawLog(dir), before);
});

test("the post-execution event is a no-op that exits 0, because exit 2 would be a verdict", () => {
  const dir = ready();
  const before = rawLog(dir);

  const post = runCli(
    ["hook", "grok"],
    dir,
    event({
      hookEventName: "PostToolUse",
      toolName: "Bash",
      toolInput: { command: "ls -la" },
      toolResponse: { stdout: "" },
    }),
  );

  // No counterpart start exists, so the report cannot land; on every other
  // harness that is the visibility exit 2. Here it must be 0: the tool has
  // already run and a 2 would be Grok reading a denial of something finished.
  assert.equal(post.code, 0, `post-execution must never exit 2 on Grok: ${post.stderr}`);
  assert.equal(post.stdout, "", "a post-execution event prints no decision object");
  assert.match(post.stderr, /"hook":"post-tool-use"/u);
  assert.equal(rawLog(dir), before, "no start to close, so nothing is appended");
});

test(".grok/hooks classifies policy.core, like .cursor and .claude before it", () => {
  assert.equal(protectedPathClass(".grok/hooks/pre-tool-use.json"), "policy.core");
  assert.equal(protectedPathClass(".grok/hooks"), "policy.core");
  assert.equal(protectedPathClass("repo/.grok/hooks/anything.json"), "policy.core");
  // The sibling surfaces Grok also reads, unchanged.
  assert.equal(protectedPathClass(".claude/settings.json"), "policy.core");
  assert.equal(protectedPathClass(".cursor/hooks.json"), "policy.core");
  // Not everything under .grok is the gate's organ.
  assert.equal(protectedPathClass(".grok/notes.md"), null);
});

test("a write to .grok/hooks is denied through the hook itself", () => {
  const dir = ready();
  const run = runCli(
    ["hook", "grok"],
    dir,
    event({
      toolName: "Write",
      toolInput: { file_path: join(dir, ".grok/hooks/pre-tool-use.json"), content: "{}" },
    }),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.decision, "deny");
  assert.equal(run.code, 2);
});

test("--help prints the committed config, and its timeout is above the wait", () => {
  const dir = ready();
  const help = runCli(["hook", "grok", "--help"], dir);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /\.grok\/hooks\/pre-tool-use\.json/u);
  assert.match(help.stdout, /"timeout": 600/u);
  assert.match(help.stdout, /approval hook grok --dir/u);
  assert.match(help.stdout, /MUST EXCEED --timeout/u);
  // The failure mode is stated where the operator is about to commit the file,
  // not only in the document they might read afterwards.
  assert.match(help.stdout, /fails OPEN/u);
  assert.match(help.stdout, /DENY IS EXIT 2/u);
  // 600 seconds against the 9m default wait leaves a real margin.
  assert.equal(600 > 9 * 60, true);
});

test("the shared hook help lists grok", () => {
  const dir = ready();
  const help = runCli(["hook", "--help"], dir);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /claude-code\|cursor\|codex\|grok/u);
  assert.match(help.stdout, /DENY IS EXIT 2/u);
});
