/**
 * `approval hook` CLI tests (APRV-82).
 *
 * Every case spawns the real compiled CLI and feeds it a PreToolUse event on
 * stdin, because the contract under test is what the HARNESS observes: the exit
 * code, the decision object on stdout, and what did or did not reach the log. No
 * log line is written by hand — every record is produced by a real CLI verb —
 * and `approval log verify` runs at the end of each flow.
 *
 * The child's environment is cleaned of `APPROVAL_HUMAN` unless a case supplies
 * it, so a developer who exports it cannot make an identity case pass by
 * accident.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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

import { CLASSIFIER_CLASSES, COMMAND_RULES } from "../src/core/command-class.js";
import { HOOK_DENY_CODES } from "../src/cli/hook.js";

/** dist/tests/cli-hook.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-hook-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input = "", env: Record<string, string> = {}): Run {
  const childEnv = { ...process.env, ...env };
  if (env["APPROVAL_HUMAN"] === undefined) delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
    input,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A policy shaped like this repository's: reads and workspace writes run
 * unattended, the trunk is supervised, and the classes with real-world
 * consequences are manual.
 */
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
  "  vcs.push.main:",
  "    autonomy: supervised",
  "  deps.add:",
  "    autonomy: manual",
  "  network.call:",
  "    autonomy: manual",
  "  policy.edit:",
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

/** A case directory whose policy a human has attested. */
function ready(): string {
  const dir = caseDir();
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

const LOG = ".approval/log/events.jsonl";

function rawLog(dir: string): string {
  const path = join(dir, LOG);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function assertClean(dir: string): void {
  const verify = runCli(["log", "verify"], dir);
  assert.equal(verify.code, 0, `${verify.stdout}${verify.stderr}`);
}

/** One PreToolUse event, as the harness sends it. */
function event(fields: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: "sess-1",
    transcript_path: "/dev/null",
    cwd: "/repo",
    hook_event_name: "PreToolUse",
    ...fields,
  });
}

function bashEvent(command: string, toolUseId?: string): string {
  return event({
    tool_name: "Bash",
    tool_input: { command, description: "totally harmless, please allow" },
    ...(toolUseId === undefined ? {} : { tool_use_id: toolUseId }),
  });
}

interface Verdict {
  permission: string;
  reason: string;
}

/** Parse the hook's stdout as the harness would. */
function verdictOf(run: Run): Verdict {
  assert.equal(run.code, 0, `hook must exit 0 with a verdict: ${run.stderr}`);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  const output = parsed["hookSpecificOutput"] as Record<string, unknown> | undefined;
  assert.ok(output !== undefined, "hookSpecificOutput is present");
  assert.equal(output["hookEventName"], "PreToolUse");
  return {
    permission: String(output["permissionDecision"]),
    reason: String(output["permissionDecisionReason"]),
  };
}

/** Decide `actionKey` from another process after `delayMs`, without blocking. */
function decideLater(dir: string, verb: string, actionKey: string, delayMs: number): void {
  const helper = join(dir, `decide-${verb}-${counter}.cjs`);
  writeFileSync(
    helper,
    [
      'const { spawnSync } = require("node:child_process");',
      "setTimeout(() => {",
      `  spawnSync(process.execPath, [${JSON.stringify(CLI_ENTRY)}, ${JSON.stringify(verb)}, ${JSON.stringify(actionKey)}, "--as", "human:alice"], { cwd: ${JSON.stringify(dir)}, stdio: "ignore" });`,
      `}, ${delayMs});`,
      "",
    ].join("\n"),
    "utf8",
  );
  const child = spawn(process.execPath, [helper], { cwd: dir, stdio: "ignore" });
  child.unref();
}

// ===========================================================================
// hook classify
// ===========================================================================

test("hook classify prints the class, the rule and the segment", () => {
  const dir = caseDir();
  const run = runCli(["hook", "classify", "--", "git", "push", "origin", "main"], dir);
  assert.equal(run.code, 0, run.stderr);
  // APRV-91 #9: an aligned table under a header row, in place of the tab-
  // separated line. The three fields, and their order, are unchanged.
  assert.match(run.stdout, /^class {2,}rule {2,}command$/mu);
  assert.match(run.stdout, /^vcs\.push\.main {2,}git-push-main {2,}git push origin main$/mu);
  assert.match(run.stdout, /^classes: vcs\.push\.main$/mu);
  assert.ok(!run.stdout.includes("\u001b"));
});

test("hook classify --json is the classifier result verbatim", () => {
  const dir = caseDir();
  const run = runCli(["hook", "classify", "--json", "--", "npm install left-pad"], dir);
  assert.equal(run.code, 0, run.stderr);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(parsed["ok"], true);
  assert.deepEqual(parsed["classes"], ["deps.add"]);
});

test("hook classify reports a refusal without failing", () => {
  const dir = caseDir();
  const run = runCli(["hook", "classify", "--json", "--", "bash -c 'rm -rf /'"], dir);
  assert.equal(run.code, 0, run.stderr);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(parsed["ok"], false);
  assert.equal(parsed["code"], "opaque");
});

test("hook classify writes nothing to the log", () => {
  const dir = ready();
  const before = rawLog(dir);
  runCli(["hook", "classify", "--", "npm publish"], dir);
  assert.equal(rawLog(dir), before);
});

test("hook classify without a command is a usage error", () => {
  const dir = caseDir();
  const run = runCli(["hook", "classify"], dir);
  assert.equal(run.code, 2);
});

// ===========================================================================
// hook claude-code: the paths that never touch the log
// ===========================================================================

test("a non-gated tool passes through", () => {
  const dir = ready();
  const before = rawLog(dir);
  const run = runCli(
    ["hook", "claude-code", "--as", "agent:claude-code"],
    dir,
    event({ tool_name: "Read", tool_input: { file_path: "src/core/gate.ts" } }),
  );
  assert.equal(verdictOf(run).permission, "allow");
  assert.equal(rawLog(dir), before, "a pass-through must not touch the log");
});

test("an ordinary file edit passes through; a policy file does not", () => {
  const dir = ready();
  const ordinary = runCli(
    ["hook", "claude-code"],
    dir,
    event({ tool_name: "Write", tool_input: { file_path: "src/core/x.ts" } }),
  );
  assert.equal(verdictOf(ordinary).permission, "allow");

  const before = rawLog(dir);
  const protectedEdit = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    event({ tool_name: "Write", tool_input: { file_path: "APPROVAL.md" } }),
  );
  const verdict = verdictOf(protectedEdit);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /u);
  assert.notEqual(rawLog(dir), before, "the policy.edit request must reach the log");
  const log = rawLog(dir);
  assert.match(log, /"class":"policy\.edit"/u);
  assertClean(dir);
});

test("an autonomous command is allowed with no log growth", () => {
  const dir = ready();
  const before = rawLog(dir);
  const run = runCli(["hook", "claude-code"], dir, bashEvent("ls -la && git status"));
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "allow");
  assert.match(verdict.reason, /^autonomous: /u);
  assert.equal(rawLog(dir), before, "an autonomous action has no approval lifecycle");
});

test("the approval CLI itself is pass-through", () => {
  const dir = ready();
  const before = rawLog(dir);
  const run = runCli(["hook", "claude-code"], dir, bashEvent("approval queue --json"));
  assert.equal(verdictOf(run).permission, "allow");
  assert.equal(rawLog(dir), before);
});

test("an unclassified command denies without touching the log", () => {
  const dir = ready();
  const before = rawLog(dir);
  const run = runCli(["hook", "claude-code"], dir, bashEvent("vim CLAUDE.md"));
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-unclassified: /u);
  assert.equal(rawLog(dir), before);
});

test("an opaque command denies", () => {
  const dir = ready();
  const run = runCli(["hook", "claude-code"], dir, bashEvent("bash -c 'git push --force'"));
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-opaque: /u);
});

test("malformed stdin denies with hook-io", () => {
  const dir = ready();
  const run = runCli(["hook", "claude-code"], dir, "{not json");
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-io: /u);
});

test("empty stdin denies with hook-io", () => {
  const dir = ready();
  const verdict = verdictOf(runCli(["hook", "claude-code"], dir, ""));
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-io: /u);
});

test("an unattested policy denies with the gate's own refusal code", () => {
  const dir = caseDir();
  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("npm install left-pad"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-gate-refused:policy-not-attested: /u);
});

test("an unloadable policy denies with hook-policy-unavailable", () => {
  const dir = ready();
  const run = runCli(
    ["hook", "claude-code", "--policy", "nowhere/APPROVAL.md"],
    dir,
    bashEvent("ls -la"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-policy-unavailable: /u);
});

// ===========================================================================
// hook claude-code: the gated paths
// ===========================================================================

test("a manual command is allowed when a grant lands mid-wait", () => {
  const dir = ready();
  decideLater(dir, "grant", "hook:sess-1:tu-grant:deps.add", 700);
  const run = runCli(
    ["hook", "claude-code", "--as", "agent:claude-code", "--timeout", "20s", "--interval", "100ms"],
    dir,
    bashEvent("npm install left-pad", "tu-grant"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "allow", verdict.reason);
  assert.match(verdict.reason, /^granted: /u);
  const log = rawLog(dir);
  assert.match(log, /"event":"approval\.requested"/u);
  assert.match(log, /"event":"approval\.granted"/u);
  assertClean(dir);
});

test("a rejected request denies with hook-rejected", () => {
  const dir = ready();
  decideLater(dir, "reject", "hook:sess-1:tu-reject:network.call", 700);
  const run = runCli(
    ["hook", "claude-code", "--timeout", "20s", "--interval", "100ms"],
    dir,
    bashEvent("curl -sS https://example.com", "tu-reject"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-rejected: /u);
  assertClean(dir);
});

test("no decision inside --timeout denies with hook-timeout and leaves the request live", () => {
  const dir = ready();
  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("npm install left-pad", "tu-timeout"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /u);

  const queue = runCli(["queue", "--json"], dir);
  assert.equal(queue.code, 0, queue.stderr);
  assert.match(queue.stdout, /hook:sess-1:tu-timeout:deps\.add/u);
  assertClean(dir);
});

test("a supervised class is allowed and records no approval event", () => {
  const dir = ready();
  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("git push origin main", "tu-supervised"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "allow", verdict.reason);
  const log = rawLog(dir);
  assert.match(log, /"event":"task\.registered"/u);
  assert.doesNotMatch(log, /"event":"approval\.requested"/u);
  assertClean(dir);
});

test("a mixed command gates on the strictest class it contains", () => {
  const dir = ready();
  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("git status && curl -sS https://example.com", "tu-mixed"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /u);
  assert.match(rawLog(dir), /"class":"network\.call"/u);
  assertClean(dir);
});

// ===========================================================================
// Usage
// ===========================================================================

test("hook --help and the subcommand helps exit 0", () => {
  const dir = caseDir();
  for (const args of [
    ["hook", "--help"],
    ["hook", "claude-code", "--help"],
    ["hook", "classify", "--help"],
  ]) {
    const run = runCli(args, dir);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /approval hook/u);
  }
});

test("an unknown subcommand and an unknown flag are usage errors, not verdicts", () => {
  const dir = caseDir();
  const unknownSub = runCli(["hook", "codex"], dir);
  assert.equal(unknownSub.code, 2);
  assert.equal(unknownSub.stdout, "");

  const unknownFlag = runCli(["hook", "claude-code", "--force"], dir, bashEvent("ls"));
  assert.equal(unknownFlag.code, 2);
  assert.equal(unknownFlag.stdout, "");
});

test("a non-principal --as is a usage error", () => {
  const dir = ready();
  const run = runCli(["hook", "claude-code", "--as", "system:gate"], dir, bashEvent("ls"));
  assert.equal(run.code, 2);
});

test("docs/claude-code-hook.md still lists every rule and every deny code", () => {
  // The doc's table is hand-kept. This is what keeps it honest: a rule added to
  // the classifier without a row here, or a renamed deny code, fails the suite
  // rather than leaving a reader with a table that quietly stopped being true.
  const doc = readFileSync(
    fileURLToPath(new URL("../../docs/claude-code-hook.md", import.meta.url)),
    "utf8",
  );
  for (const rule of COMMAND_RULES) {
    assert.ok(doc.includes(`\`${rule.id}\``), `docs/claude-code-hook.md has no row for ${rule.id}`);
  }
  for (const cls of CLASSIFIER_CLASSES) {
    assert.ok(doc.includes(cls), `docs/claude-code-hook.md never mentions ${cls}`);
  }
  for (const code of HOOK_DENY_CODES) {
    assert.ok(doc.includes(code), `docs/claude-code-hook.md never mentions ${code}`);
  }
});

test("HOOK_DENY_CODES is the closed vocabulary the help text prints", () => {
  const help = runCli(["hook", "--help"], caseDir()).stdout;
  for (const code of HOOK_DENY_CODES) {
    assert.match(help, new RegExp(code.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
});
