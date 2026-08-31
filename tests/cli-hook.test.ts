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
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { ChannelRequest } from "../src/channels/contract.js";
import {
  CANONICAL_JSON_HEADING,
  DIFF_BEGIN,
  DIFF_END,
  EDIT_VIEW_HEADING,
  LIVE_QUALIFIER,
} from "../src/channels/payload-view.js";
import { buildPendingQueue } from "../src/channels/tagging.js";
import { renderTelegram } from "../src/channels/telegram.js";
import { supervisedExecutions } from "../src/core/audit.js";
import { runPayloadHash } from "../src/core/payload.js";
import { CLASSIFIER_CLASSES, COMMAND_RULES } from "../src/core/command-class.js";
import type { EventRecord } from "../src/core/log.js";
import { payloadHash } from "../src/core/payload.js";
import { loadPolicy } from "../src/core/policy-load.js";
import { harnessLoopEscalation, loopEscalation } from "../src/core/loop.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { HOOK_DENY_CODES, SUMMARY_LIMIT } from "../src/cli/hook.js";

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

/** One autonomous action a day: the second harness execution must be refused. */
const POLICY_ONE_ACTION = POLICY.replace(
  "```\n",
  "budgets:\n  global:\n    daily_actions: 1\n```\n",
);

function caseDir(policyText: string = POLICY): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), policyText, "utf8");
  return dir;
}

/** A case directory whose policy a human has attested. */
function ready(policyText: string = POLICY): string {
  const dir = caseDir(policyText);
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

const LOG = ".approval/log/events.jsonl";

function rawLog(dir: string): string {
  const path = join(dir, LOG);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Every record the log grew by since `before`, parsed. */
function recordsSince(dir: string, before: string): Record<string, unknown>[] {
  return rawLog(dir)
    .slice(before.length)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function payloadOf(record: Record<string, unknown>): Record<string, unknown> {
  return (record["payload"] ?? {}) as Record<string, unknown>;
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

test("hook classify reports the read class for a GET-shaped fetch", () => {
  // APRV-114, end to end: the verb a session is told to run when in doubt has
  // to show the carve-out, or the carve-out does not exist where it is used.
  const dir = caseDir();
  const run = runCli(["hook", "classify", "--", "curl", "https://example.com"], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^read\.web {2,}web-read {2,}curl https:\/\/example\.com$/mu);
  assert.match(run.stdout, /^classes: read\.web$/mu);
});

test("hook classify keeps a body-carrying fetch at network.call", () => {
  const dir = caseDir();
  for (const command of ["curl -X POST https://example.com", "curl -d a=b https://example.com"]) {
    const run = runCli(["hook", "classify", "--json", "--", command], dir);
    assert.equal(run.code, 0, run.stderr);
    const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
    assert.deepEqual(parsed["classes"], ["network.call"], command);
  }
});

test("hook classify reads gh api by its method and field flags", () => {
  const dir = caseDir();
  const read = runCli(["hook", "classify", "--json", "--", "gh api repos/x/y/pulls"], dir);
  assert.equal(read.code, 0, read.stderr);
  assert.deepEqual((JSON.parse(read.stdout) as Record<string, unknown>)["classes"], [
    "read.vcs.remote",
  ]);
  const write = runCli(["hook", "classify", "--json", "--", "gh api -X POST repos/x/y/issues"], dir);
  assert.equal(write.code, 0, write.stderr);
  assert.deepEqual((JSON.parse(write.stdout) as Record<string, unknown>)["classes"], [
    "network.call",
  ]);
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

test("an autonomous command is allowed and records only its execution", () => {
  const dir = ready();
  const before = rawLog(dir);
  const run = runCli(["hook", "claude-code"], dir, bashEvent("ls -la && git status", "tu-auto"));
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "allow");
  assert.match(verdict.reason, /^autonomous: /u);

  // APRV-141: the approval lifecycle is still absent — nothing is requested,
  // decided or granted — and the execution record is present, because that is
  // the moment the policy authorized the command and the moment budgets charge.
  const named = verdict.reason.replace(/^autonomous: /u, "").split(", ");
  const written = recordsSince(dir, before);
  assert.deepEqual(
    written.map((record) => record["event"]),
    named.map(() => "execution.started"),
  );
  assert.deepEqual(
    written.map((record) => payloadOf(record)["class"]),
    named,
  );
  for (const record of written) {
    assert.equal(payloadOf(record)["execution"], "harness", "no completion will follow");
    assert.equal(record["task"], "hook:sess-1:tu-auto");
  }
  assertClean(dir);
});

test("a GET-shaped fetch runs unattended, and a POST-shaped one does not", () => {
  // APRV-114: the noise this refinement exists to remove. A research fetch is
  // a read under the policy's `read.*` rule and asks nobody; the same binary
  // carrying a body is still held at manual.
  const dir = ready();
  const before = rawLog(dir);
  const read = runCli(["hook", "claude-code"], dir, bashEvent("curl -sS https://example.com"));
  const verdict = verdictOf(read);
  assert.equal(verdict.permission, "allow", verdict.reason);
  assert.match(verdict.reason, /^autonomous: /u);
  assert.deepEqual(
    recordsSince(dir, before).map((record) => record["event"]),
    ["execution.started"],
    "a read fetch has no approval lifecycle, only the execution APRV-141 charges",
  );

  const write = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("curl -X POST https://example.com", "tu-post"),
  );
  assert.equal(verdictOf(write).permission, "deny");
  assert.match(rawLog(dir), /"class":"network\.call"/u);
  assertClean(dir);
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
  // APRV-101: the hook writes to an existing log and creates none, so this case
  // has to be a scaffolded (empty) log — otherwise the refusal under test is
  // preempted by `hook-log-unreachable`, which is a different sentence about a
  // different problem. `init` makes .approval/log/ and appends nothing.
  const init = runCli(["init"], dir);
  assert.equal(init.code, 0, init.stderr);
  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("npm install left-pad"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-gate-refused:policy-not-attested: /u);
});

// ===========================================================================
// APRV-139: an unattended verdict is checked against the verified log first
// ===========================================================================

test("an edited-but-unattested policy no longer runs an autonomous command", () => {
  // The red-team's F2, reproduced end to end. Whoever can write APPROVAL.md
  // reclassifies a manual class to autonomous; before APRV-139 the hook read
  // the edited file, resolved `autonomous`, and allowed, and because the
  // HARNESS executes on an allow the runtime's own attestation check was never
  // reached. `deps.add` is the class chosen because the baseline policy holds
  // it at manual, so the edit is unmistakably a widening.
  const dir = ready();
  const before = rawLog(dir);
  writeFileSync(
    join(dir, "APPROVAL.md"),
    POLICY.replace("  deps.add:\n    autonomy: manual", "  deps.add:\n    autonomy: autonomous"),
    "utf8",
  );

  const run = runCli(["hook", "claude-code"], dir, bashEvent("npm install left-pad"));
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny", verdict.reason);
  assert.match(verdict.reason, /^hook-gate-refused:policy-not-attested: /u);
  assert.match(verdict.reason, /re-attests it/u);
  assert.equal(rawLog(dir), before, "a refused unattended verdict appends nothing");
});

test("an edited policy stops the supervised fast path too", () => {
  const dir = ready();
  const before = rawLog(dir);
  writeFileSync(join(dir, "APPROVAL.md"), `${POLICY}\n<!-- edited, not re-attested -->\n`, "utf8");

  const run = runCli(["hook", "claude-code"], dir, bashEvent("git push origin main"));
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny", verdict.reason);
  assert.match(verdict.reason, /^hook-gate-refused:policy-not-attested: /u);
  assert.equal(rawLog(dir), before, "nothing is registered under an inoperative policy");
});

test("an unreachable log denies an autonomous command, not just a gated one", () => {
  // The check moved above the fast paths (APRV-139): attestation and
  // loop-escalation are facts about the log, so a hook that cannot reach the
  // log cannot establish them and must not allow.
  const dir = caseDir();
  const run = runCli(["hook", "claude-code"], dir, bashEvent("ls -la"));
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny", verdict.reason);
  assert.match(verdict.reason, /^hook-log-unreachable: /u);
});

test("a loop-escalated harness task may not run unattended", () => {
  // SPEC.md §10.2, the half `core/execute.ts` has always enforced and the hook
  // did not. The streak is built through the real verbs — register, then three
  // supervised `approval run`s that exit non-zero — under the very task id the
  // hook mints for this session and tool-use id.
  const dir = ready();
  const task = "hook:sess-1:tu-loop";
  const actions = ["one", "two", "three"];
  // APRV-140: a supervised action binds to the bytes it will run, so the
  // declaration commits to this exact command before it is registered.
  const failing = [process.execPath, "-e", "process.exit(1)"];
  const binding = runPayloadHash(failing, dir);
  writeFileSync(
    join(dir, "loop-task.md"),
    [
      "---",
      `id: ${task}`,
      "title: A harness task that keeps failing",
      "status: In Progress",
      "approval:",
      "  origin:",
      "    app: claude-code-hook",
      '    created_by: "agent:claude-code"',
      "  state: proposed",
      "  actions: ",
      ...actions.flatMap((name) => [
        "    - class: vcs.push.main",
        `      summary: "attempt ${name}"`,
        '      est_cost_usd: "0"',
        `      idempotency_key: "${task}:${name}"`,
        `      payload_hash: "${binding}"`,
      ]),
      "---",
      "",
      "## Description",
      "Body.",
      "",
    ].join("\n"),
    "utf8",
  );
  assert.equal(runCli(["register", "loop-task.md", "--as", "agent:claude-code"], dir).code, 0);
  for (const name of actions) {
    const failed = runCli(
      ["run", `${task}:${name}`, "--as", "agent:claude-code", "--", ...failing],
      dir,
    );
    assert.equal(failed.code, 1, `${name}: ${failed.stderr}`);
  }

  const run = runCli(["hook", "claude-code"], dir, bashEvent("ls -la", "tu-loop"));
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny", verdict.reason);
  assert.match(verdict.reason, /^hook-gate-refused:loop-escalated: /u);
  assert.match(verdict.reason, /§10\.2/u);

  // A different tool-use id is a different task, and is unaffected: the
  // escalation is per task, exactly as `core/loop.ts` computes it.
  const other = runCli(["hook", "claude-code"], dir, bashEvent("ls -la", "tu-fresh"));
  assert.equal(verdictOf(other).permission, "allow");
  assertClean(dir);
});

// ===========================================================================
// APRV-145: the completion counterpart and the harness loop streaks
// ===========================================================================

/**
 * Grant `actionKey` from another process as soon as it is pending, retrying
 * until it lands or the deadline passes.
 *
 * {@link decideLater}'s single shot at a fixed delay is enough where the hook
 * opens its request immediately. The APRV-145 floor tests run three tool calls
 * and six CLI invocations first, so under parallel load the request can be
 * later than any one fixed delay; a poller is the difference between a test that
 * pins the floor and a test that pins the machine's mood.
 */
function grantWhenPending(dir: string, actionKey: string): void {
  const helper = join(dir, `grant-when-pending-${counter}.cjs`);
  writeFileSync(
    helper,
    [
      'const { spawnSync } = require("node:child_process");',
      "const deadline = Date.now() + 25000;",
      "const attempt = () => {",
      `  const run = spawnSync(process.execPath, [${JSON.stringify(CLI_ENTRY)}, "grant", ${JSON.stringify(actionKey)}, "--as", "human:alice"], { cwd: ${JSON.stringify(dir)}, stdio: "ignore" });`,
      "  if (run.status === 0 || Date.now() > deadline) return;",
      "  setTimeout(attempt, 200);",
      "};",
      "setTimeout(attempt, 200);",
      "",
    ].join("\n"),
    "utf8",
  );
  const child = spawn(process.execPath, [helper], { cwd: dir, stdio: "ignore" });
  child.unref();
}

/** One post-execution event, as the harness sends it after the tool ran. */
function postEvent(
  toolUseId: string,
  toolResponse: unknown,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    session_id: "sess-1",
    transcript_path: "/dev/null",
    cwd: "/repo",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls -la", description: "totally harmless, please allow" },
    tool_use_id: toolUseId,
    tool_response: toolResponse,
    ...extra,
  });
}

/** The single JSON line the counterpart prints on stderr. */
function reportOf(run: Run): Record<string, unknown> {
  assert.equal(run.code, 0, `the counterpart always exits 0: ${run.stderr}`);
  assert.equal(run.stdout, "", "a post-execution hook prints no verdict on stdout");
  const parsed = JSON.parse(run.stderr.trim()) as Record<string, unknown>;
  return (parsed["approval"] ?? {}) as Record<string, unknown>;
}

/** Every record in the log, parsed. */
function allRecords(dir: string): Record<string, unknown>[] {
  return recordsSince(dir, "");
}

/**
 * Run one gated tool call and report an outcome for it, both through the real
 * CLI: a PreToolUse event that allows and records `execution.started`, then a
 * PostToolUse event that closes it.
 */
function toolCall(
  dir: string,
  toolUseId: string,
  outcome: "text" | "error",
  session = "sess-1",
): void {
  const pre = runCli(
    ["hook", "claude-code"],
    dir,
    JSON.stringify({
      session_id: session,
      transcript_path: "/dev/null",
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      tool_use_id: toolUseId,
    }),
  );
  assert.equal(verdictOf(pre).permission, "allow", pre.stdout);
  const post = runCli(
    ["hook", "claude-code"],
    dir,
    postEvent(toolUseId, { type: outcome, [outcome === "text" ? "text" : "error"]: "…" }, {
      session_id: session,
    }),
  );
  assert.equal(reportOf(post)["code"], "post-tool-reported", post.stderr);
}

test("the counterpart closes the delegated start the pre-execution event opened", () => {
  const dir = ready();
  const before = rawLog(dir);
  const pre = runCli(["hook", "claude-code"], dir, bashEvent("ls -la", "tu-a"));
  assert.equal(verdictOf(pre).permission, "allow");

  const post = runCli(
    ["hook", "claude-code"],
    dir,
    postEvent("tu-a", { type: "text", text: "total 0\ndrwxr-xr-x  2 carter  staff" }),
  );
  const report = reportOf(post);
  assert.equal(report["code"], "post-tool-reported");
  assert.equal(report["task"], "hook:sess-1:tu-a");
  assert.equal(report["outcome"], "completed");
  assert.equal(report["appended"], 1);

  const written = recordsSince(dir, before);
  assert.deepEqual(
    written.map((record) => record["event"]),
    ["execution.started", "execution.completed"],
  );
  const closing = written[1] as Record<string, unknown>;
  assert.equal(closing["task"], "hook:sess-1:tu-a");
  assert.equal(closing["action_key"], "hook:sess-1:tu-a:read.shell");
  // An `agent:` actor, never a `system:` one: the runtime did not observe this
  // exit, the harness did, and the record must say who is asserting it.
  assert.equal(closing["actor"], "agent:claude-code");
  assert.deepEqual(payloadOf(closing), {
    execution: "harness",
    reported_by: "post-tool-use",
    exit_code: null,
  });
  // SPEC.md §11.1 invariant 3: none of the text the tool produced is in the log.
  assert.ok(!rawLog(dir).includes("drwxr-xr-x"), "the tool's output must never reach the log");
  assertClean(dir);
});

test("an error tool_response and a PostToolUseFailure event both record a failure", () => {
  for (const [id, event, response] of [
    ["tu-err", "PostToolUse", { type: "error", error: "command not found" }],
    ["tu-fail", "PostToolUseFailure", { type: "text", text: "…" }],
  ] as const) {
    const dir = ready();
    assert.equal(verdictOf(runCli(["hook", "claude-code"], dir, bashEvent("ls -la", id))).permission, "allow");
    const before = rawLog(dir);
    const post = runCli(
      ["hook", "claude-code"],
      dir,
      postEvent(id, response, { hook_event_name: event }),
    );
    assert.equal(reportOf(post)["code"], "post-tool-reported", post.stderr);
    assert.deepEqual(
      recordsSince(dir, before).map((record) => record["event"]),
      ["execution.failed"],
      `${event} must record a failure`,
    );
    assertClean(dir);
  }
});

test("THE DEFECT: three failed tool calls accrue nothing per task and escalate the session", () => {
  // The pin APRV-145 exists for. Each tool call mints its own task id
  // (`hook:<session>:<tool-use id>`), so the per-task streak of SPEC.md §10.2
  // sees three tasks with one failure each and escalates NOTHING — the APRV-139
  // guard is correct and vacuous by construction on this surface. The session
  // and actor scopes of the amended §10.2 are what see the loop.
  const dir = ready();
  for (const id of ["tu-1", "tu-2", "tu-3"]) toolCall(dir, id, "error");

  const read = readVerifiedRecords(join(dir, LOG));
  assert.equal(read.ok, true);
  if (!read.ok) throw new Error("unreachable");

  assert.deepEqual(
    loopEscalation(read.records).filter((state) => state.escalated),
    [],
    "three failures across three tool calls escalate no TASK: that is the defect",
  );
  assert.deepEqual(
    harnessLoopEscalation(read.records).map((state) => [
      state.scope,
      state.key,
      state.consecutiveFailures,
      state.escalated,
    ]),
    [
      ["actor", "agent:claude-code", 3, true],
      ["session", "hook:sess-1", 3, true],
    ],
    "…and both harness scopes see it, sorted byte-stably",
  );
  assertClean(dir);
});

test("an escalated session floors the next autonomous command to the human gate", () => {
  const dir = ready();
  for (const id of ["tu-1", "tu-2", "tu-3"]) toolCall(dir, id, "error");

  // `read.shell` is autonomous under this policy and would have been allowed
  // with nothing appended. Under the floor it is registered, requested and
  // waited on like any manual class — and the human's tap authorizes it.
  const key = "hook:sess-1:tu-4:read.shell";
  grantWhenPending(dir, key);
  const run = runCli(
    ["hook", "claude-code", "--timeout", "40s", "--interval", "200ms"],
    dir,
    bashEvent("ls -la", "tu-4"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "allow", verdict.reason);
  // The decision trace: the verdict says a FLOOR rather than the matched rule
  // decided it, and names the scope and the count, the way `core/execute.ts`
  // names the §7 irreversibility floor beside a resolution's provenance.
  assert.match(verdict.reason, /loop floor \(SPEC\.md §10\.2\)/u);
  assert.match(verdict.reason, /session hook:sess-1 has 3 consecutive failed harness tool calls/u);

  const events = allRecords(dir).map((record) => record["event"]);
  assert.ok(
    events.includes("approval.requested"),
    "the floored class asked a human, which the unfloored class never does",
  );
  assertClean(dir);
});

test("the actor scope backstops a rotated session id", () => {
  // The reason the second scope exists: a session id is authored by the party
  // under oversight, and a scope key the subject can rotate is a streak the
  // subject can shed, which SPEC.md §11.1 invariant 4 forbids.
  const dir = ready();
  toolCall(dir, "tu-1", "error", "sess-a");
  toolCall(dir, "tu-2", "error", "sess-b");
  toolCall(dir, "tu-3", "error", "sess-c");

  const read = readVerifiedRecords(join(dir, LOG));
  assert.equal(read.ok, true);
  if (!read.ok) throw new Error("unreachable");
  const states = harnessLoopEscalation(read.records).filter((state) => state.escalated);
  assert.deepEqual(
    states.map((state) => [state.scope, state.key]),
    [["actor", "agent:claude-code"]],
    "no single session tripped; the actor did",
  );

  // A fourth, fresh session is floored all the same.
  const key = "hook:sess-d:tu-4:read.shell";
  grantWhenPending(dir, key);
  const run = runCli(
    ["hook", "claude-code", "--timeout", "40s", "--interval", "200ms"],
    dir,
    JSON.stringify({
      session_id: "sess-d",
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      tool_use_id: "tu-4",
    }),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "allow", verdict.reason);
  assert.match(verdict.reason, /actor agent:claude-code has 3 consecutive failed harness tool calls/u);
  assertClean(dir);
});

test("an unreadable session id lands in ONE shared bucket, so absence accrues faster", () => {
  const dir = ready();
  // No `session_id` at all: `parseHookInput` substitutes `unknown-session`, and
  // three such tool calls share one bucket rather than opening three.
  for (const id of ["tu-1", "tu-2", "tu-3"]) {
    const pre = runCli(
      ["hook", "claude-code"],
      dir,
      JSON.stringify({
        cwd: "/repo",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
        tool_use_id: id,
      }),
    );
    assert.equal(verdictOf(pre).permission, "allow");
    const post = runCli(
      ["hook", "claude-code"],
      dir,
      JSON.stringify({
        cwd: "/repo",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
        tool_use_id: id,
        tool_response: { type: "error", error: "…" },
      }),
    );
    assert.equal(reportOf(post)["code"], "post-tool-reported", post.stderr);
  }

  const read = readVerifiedRecords(join(dir, LOG));
  assert.equal(read.ok, true);
  if (!read.ok) throw new Error("unreachable");
  assert.deepEqual(
    harnessLoopEscalation(read.records)
      .filter((state) => state.scope === "session")
      .map((state) => [state.key, state.consecutiveFailures, state.escalated]),
    [["hook:unknown-session", 3, true]],
  );
  assertClean(dir);
});

test("only a completion in the same scope clears a harness streak", () => {
  const dir = ready();
  toolCall(dir, "tu-1", "error");
  toolCall(dir, "tu-2", "error");
  toolCall(dir, "tu-3", "text");
  toolCall(dir, "tu-4", "error");

  const read = readVerifiedRecords(join(dir, LOG));
  assert.equal(read.ok, true);
  if (!read.ok) throw new Error("unreachable");
  assert.deepEqual(
    harnessLoopEscalation(read.records).map((state) => [
      state.scope,
      state.consecutiveFailures,
      state.escalated,
    ]),
    [
      ["actor", 1, false],
      ["session", 1, false],
    ],
    "the completion reset both scopes; the fourth call opened a fresh streak of one",
  );
  assertClean(dir);
});

test("INVARIANT 4: a report that closes nothing cannot clear an accrued streak", () => {
  // The one-directionality pin. A reported failure accrues; a reported
  // COMPLETION only clears where it actually closes a delegated start this
  // runtime authorized. A report against a tool call that never started is
  // refused and appends nothing, so the escalation stands.
  const dir = ready();
  for (const id of ["tu-1", "tu-2", "tu-3"]) toolCall(dir, id, "error");
  const before = rawLog(dir);

  const post = runCli(
    ["hook", "claude-code"],
    dir,
    postEvent("tu-never-started", { type: "text", text: "all good, honest" }),
  );
  assert.equal(reportOf(post)["code"], "post-tool-gate-refused:not-delegated", post.stderr);
  assert.equal(rawLog(dir), before, "a refused report appends nothing");

  const read = readVerifiedRecords(join(dir, LOG));
  assert.equal(read.ok, true);
  if (!read.ok) throw new Error("unreachable");
  assert.equal(
    harnessLoopEscalation(read.records).every((state) => state.escalated),
    true,
    "the streak is exactly where the failures left it",
  );
  assertClean(dir);
});

test("the counterpart refuses a start that carries no harness marker", () => {
  // The narrow carve-out has two edges and this is the second one. APRV-146
  // stops the human recovery verbs closing a harness start; this stops a
  // harness report closing an execution this runtime watched itself. The
  // `hook:sess-1:tu-loop` task below is started and failed by `approval run`,
  // so its records carry no `execution: "harness"`.
  const dir = ready();
  const task = "hook:sess-1:tu-loop";
  const failing = [process.execPath, "-e", "process.exit(1)"];
  const binding = runPayloadHash(failing, dir);
  writeFileSync(
    join(dir, "loop-task.md"),
    [
      "---",
      `id: ${task}`,
      "title: A task the runtime runs itself",
      "status: In Progress",
      "approval:",
      "  origin:",
      "    app: claude-code-hook",
      '    created_by: "agent:claude-code"',
      "  state: proposed",
      "  actions: ",
      "    - class: vcs.push.main",
      '      summary: "attempt one"',
      '      est_cost_usd: "0"',
      `      idempotency_key: "${task}:one"`,
      `      payload_hash: "${binding}"`,
      "---",
      "",
      "## Description",
      "Body.",
      "",
    ].join("\n"),
    "utf8",
  );
  assert.equal(runCli(["register", "loop-task.md", "--as", "agent:claude-code"], dir).code, 0);
  assert.equal(
    runCli(["run", `${task}:one`, "--as", "agent:claude-code", "--", ...failing], dir).code,
    1,
  );

  const before = rawLog(dir);
  const post = runCli(
    ["hook", "claude-code"],
    dir,
    postEvent("tu-loop", { type: "text", text: "…" }),
  );
  const report = reportOf(post);
  assert.equal(report["code"], "post-tool-gate-refused:not-delegated");
  assert.match(String(report["detail"]), /none carries execution: "harness"/u);
  assert.equal(rawLog(dir), before, "nothing was appended");
  assertClean(dir);
});

test("an unreadable outcome appends nothing, and a second report is refused", () => {
  const dir = ready();
  assert.equal(verdictOf(runCli(["hook", "claude-code"], dir, bashEvent("ls -la", "tu-x"))).permission, "allow");

  // Unreadable: the pinned readings are text, base64 and error, and nothing else.
  for (const response of [{ type: "diagnostic" }, {}, "a bare string", null]) {
    const before = rawLog(dir);
    const run = runCli(["hook", "claude-code"], dir, postEvent("tu-x", response));
    assert.equal(
      reportOf(run)["code"],
      "post-tool-unreadable-outcome",
      `${JSON.stringify(response)}: ${run.stderr}`,
    );
    assert.equal(rawLog(dir), before, "an unreadable outcome appends nothing");
  }

  // Readable: it closes, once.
  assert.equal(
    reportOf(runCli(["hook", "claude-code"], dir, postEvent("tu-x", { type: "text", text: "" })))[
      "code"
    ],
    "post-tool-reported",
  );
  const settled = rawLog(dir);
  const second = runCli(["hook", "claude-code"], dir, postEvent("tu-x", { type: "error", error: "" }));
  assert.equal(reportOf(second)["code"], "post-tool-gate-refused:already-finished");
  assert.equal(rawLog(dir), settled, "an execution has exactly one outcome");
  assertClean(dir);
});

test("a report with no tool-use id, and one for an ungated tool, append nothing", () => {
  const dir = ready();
  const before = rawLog(dir);

  const anonymous = runCli(
    ["hook", "claude-code"],
    dir,
    JSON.stringify({
      session_id: "sess-1",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      tool_response: { type: "text", text: "" },
    }),
  );
  assert.equal(reportOf(anonymous)["code"], "post-tool-unidentified");

  const ungated = runCli(
    ["hook", "claude-code"],
    dir,
    JSON.stringify({
      session_id: "sess-1",
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: {},
      tool_use_id: "tu-r",
      tool_response: { type: "text", text: "" },
    }),
  );
  assert.equal(reportOf(ungated)["code"], "post-tool-not-gated");
  assert.equal(rawLog(dir), before);
});

test("a report may not be filed by a non-principal actor", () => {
  const dir = ready();
  const before = rawLog(dir);
  const run = runCli(
    ["hook", "claude-code", "--as", "system:clock"],
    dir,
    postEvent("tu-x", { type: "text", text: "" }),
  );
  assert.equal(run.code, 2, run.stderr);
  assert.match(run.stderr, /--as expects agent:<id> or human:<id>/u);
  assert.equal(rawLog(dir), before, "nothing was appended");
});

test("status reports the harness streaks by scope, and counterpart coverage", () => {
  const dir = ready();
  // One start that nobody reports on: it is not debris, it is a tool call with
  // no outcome, and the coverage row is the only place it shows. It runs FIRST,
  // because after the three failures below the floor sends every command to a
  // human and this one would sit there waiting for a tap.
  assert.equal(
    verdictOf(runCli(["hook", "claude-code"], dir, bashEvent("ls -la", "tu-0"))).permission,
    "allow",
  );
  for (const id of ["tu-1", "tu-2", "tu-3"]) toolCall(dir, id, "error");

  const run = runCli(["status", "--json"], dir);
  const body = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.deepEqual(body["loop_escalations"], [
    { task: "agent:claude-code", scope: "actor", consecutive_failures: 3, escalated: true },
    { task: "hook:sess-1", scope: "session", consecutive_failures: 3, escalated: true },
  ]);
  assert.deepEqual(body["harness_outcomes"], { started: 4, reported: 3, unreported: 1 });
  assert.equal(body["healthy"], false, "an escalated scope is not a healthy repo");

  const human = runCli(["status"], dir);
  assert.match(human.stdout, /^loop escalations {2,}2$/mu);
  assert.match(
    human.stdout,
    /hook:sess-1 \(3 consecutive failed tool calls, session\) — escalated to manual/u,
  );
  assert.match(human.stdout, /^harness outcomes {2,}4 started, 3 reported, 1 unreported$/mu);
  assertClean(dir);
});

test("doctor fails its harness check when only the pre-execution hook is registered", () => {
  const dir = ready();
  const settingsDir = join(dir, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  const settings = join(settingsDir, "settings.json");
  const entry = (event: string): Record<string, unknown> => ({
    [event]: [
      {
        matcher: "Bash|Edit|Write",
        hooks: [{ type: "command", command: `approval hook claude-code --dir ${dir}` }],
      },
    ],
  });

  const checkOf = (): Record<string, unknown> => {
    const run = runCli(["doctor", "--json", "--dir", dir, "--log", join(dir, LOG)], dir);
    const body = JSON.parse(run.stdout) as Record<string, unknown>;
    const checks = body["checks"] as Record<string, unknown>[];
    const found = checks.find((check) => check["check"] === "harness-hook-outcomes");
    assert.ok(found !== undefined, "doctor lost the harness check");
    return found;
  };

  // No settings file at all: not a Claude Code checkout, so nothing to report.
  assert.equal(checkOf()["status"], "skip");

  // Registered for the pre-execution event only: the exact configuration in
  // which loop escalation cannot accrue, and the check must say so.
  writeFileSync(settings, JSON.stringify({ hooks: entry("PreToolUse") }, null, 2), "utf8");
  const failing = checkOf();
  assert.equal(failing["status"], "fail");
  assert.match(String(failing["detail"]), /PreToolUse and not for PostToolUse/u);
  assert.match(String(failing["detail"]), /§10\.2/u);
  assert.match(String(failing["fix"]), /^approval /u);

  // Both: the outcome reaches the log, and the check passes.
  writeFileSync(
    settings,
    JSON.stringify({ hooks: { ...entry("PreToolUse"), ...entry("PostToolUse") } }, null, 2),
    "utf8",
  );
  assert.equal(checkOf()["status"], "pass");

  // A file registering no `approval hook` entry at all is not this check's
  // business: doctor reports on a gate that is installed, never on one nobody
  // asked for.
  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2), "utf8");
  assert.equal(checkOf()["status"], "skip");
});

test("an event whose name this runtime does not know still takes the gated path", () => {
  // The strict direction, and the reason the dispatch is not a closed match on
  // "PreToolUse": a harness event this runtime cannot name is a harness about to
  // run a command, and treating an unknown name as a no-op would be an ungated
  // one.
  const dir = ready();
  const run = runCli(
    ["hook", "claude-code"],
    dir,
    JSON.stringify({
      session_id: "sess-1",
      cwd: "/repo",
      hook_event_name: "SomeFutureEvent",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      tool_use_id: "tu-u",
    }),
  );
  assert.equal(verdictOf(run).permission, "allow");
  assert.deepEqual(
    allRecords(dir).map((record) => record["event"]).slice(-1),
    ["execution.started"],
    "it was gated, not ignored",
  );
});

// ===========================================================================
// APRV-141: harness executions are charged and sampleable
// ===========================================================================

test("a harness autonomous action is charged against daily_actions", () => {
  // Red-team F6. Before APRV-141 the hook appended nothing for an autonomous
  // verdict, so `core/budgets.ts` — which reads consumption from
  // approval.granted and execution.started and from nothing else — charged the
  // busiest execution path in the system zero.
  const dir = ready(POLICY_ONE_ACTION);
  const first = runCli(["hook", "claude-code"], dir, bashEvent("ls -la", "tu-one"));
  assert.equal(verdictOf(first).permission, "allow");

  const before = rawLog(dir);
  const second = runCli(["hook", "claude-code"], dir, bashEvent("ls -la", "tu-two"));
  const verdict = verdictOf(second);
  assert.equal(verdict.permission, "deny", verdict.reason);
  assert.match(verdict.reason, /^hook-gate-refused:budget-exceeded: /u);
  assert.match(verdict.reason, /daily_actions/u);
  assert.deepEqual(
    recordsSince(dir, before).map((record) => record["event"]),
    ["budget.exceeded"],
    "the refusal is recorded and the execution is not",
  );
  assertClean(dir);
});

test("a harness supervised action is a candidate the audit sampler can draw", () => {
  // The other half of F6: `core/audit.ts` draws its retrospective sample from
  // execution.started records whose action a task.registered declares, and only
  // for supervised classes. The hook registers the class already; APRV-141 adds
  // the start event, which is what makes the pair a candidate at all.
  const dir = ready();
  const run = runCli(["hook", "claude-code"], dir, bashEvent("git push origin main", "tu-push"));
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "allow", verdict.reason);

  const read = readVerifiedRecords(join(dir, LOG));
  assert.equal(read.ok, true);
  const candidates = supervisedExecutions(
    (read as { ok: true; records: EventRecord[] }).records,
    loadPolicy({ dir }),
  );
  assert.deepEqual(
    candidates.map((candidate) => [candidate.actionKey, candidate.class]),
    [["hook:sess-1:tu-push:vcs.push.main", "vcs.push.main"]],
  );
  assertClean(dir);
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
    bashEvent("curl -X POST https://example.com", "tu-reject"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-rejected: /u);
  assertClean(dir);
});

test("no decision inside --timeout denies with hook-timeout and LEAVES THE REQUEST OPEN", () => {
  // APRV-106 withdrew here, because a retried tool call was a new request with
  // a new key and a late grant therefore authorized nothing. APRV-117 removes
  // that premise (a retry adopts or carries the same question, keyed by the
  // payload hash), so the question stays in front of the human and the answer
  // it gets is worth something. The property APRV-106 was protecting — never
  // solicit a decision nobody can consume — is preserved by carryover rather
  // than by retraction, and the two tests below are what hold it.
  const dir = ready();
  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("npm install left-pad", "tu-timeout"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /u);
  assert.match(verdict.reason, /NOTHING WAS WITHDRAWN/u);
  assert.match(verdict.reason, /authorizes a retry/u);

  // Nothing was retracted, and the request is the hook's own harness request.
  const log = rawLog(dir);
  assert.doesNotMatch(log, /"event":"approval\.withdrawn"/u);
  assert.match(log, /"event":"approval\.requested"/u);
  assert.match(log, /"execution":"harness"/u);
  assert.match(log, /"actor":"agent:claude-code"/u);

  // APRV-106's `wait_until` is gone: under carryover the sentence it rendered
  // ("requester waits until …") is false, and the deadline that governs is the
  // policy's TTL, which the channel line falls back to on its own.
  assert.doesNotMatch(log, /"wait_until"/u);

  // The human's inbox still holds the question, because answering it still does
  // something.
  const queue = runCli(["queue", "--json"], dir);
  assert.equal(queue.code, 0, queue.stderr);
  assert.match(queue.stdout, /hook:sess-1:tu-timeout:deps\.add/u);
  assertClean(dir);
});

test("a grant landing after the wait authorizes an identical retry, with no second prompt", () => {
  // APRV-117 AC#1 and AC#2's converse: the incident of 2026-08-19, replayed and
  // fixed. The hook gives up, the human answers late, and the retried command
  // proceeds on the answer they gave.
  const dir = ready();
  const first = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("npm install left-pad", "tu-late"),
  );
  assert.equal(verdictOf(first).permission, "deny");

  // The late tap. It is accepted now — the request is still pending.
  const late = runCli(
    ["grant", "hook:sess-1:tu-late:deps.add", "--as", "human:carter", "--json"],
    dir,
  );
  assert.equal(late.code, 0, late.stderr);

  // The retry: same bytes, same cwd, a NEW tool-use id, as the harness sends it.
  const retry = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("npm install left-pad", "tu-retry"),
  );
  const verdict = verdictOf(retry);
  assert.equal(verdict.permission, "allow", verdict.reason);
  assert.match(verdict.reason, /^granted: /u);
  assert.match(verdict.reason, /carried: hook:sess-1:tu-late:deps\.add/u);

  // No second question was ever asked: exactly one approval.requested exists,
  // and the retry opened no request of its own.
  const log = rawLog(dir);
  assert.equal(log.match(/"event":"approval\.requested"/gu)?.length, 1);
  assert.doesNotMatch(log, /hook:sess-1:tu-retry/u);

  // The grant was spent, once, through the ordinary execution vocabulary.
  assert.match(log, /"event":"execution\.started"/u);
  assert.doesNotMatch(log, /"event":"execution\.completed"/u);
  assertClean(dir);
});

test("a carried grant is spent exactly once; the next identical command asks again", () => {
  // APRV-117 AC#3. The second retry gets no free ride: it files a fresh request
  // through the ordinary path and waits like anything else.
  const dir = ready();
  runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("npm install left-pad", "tu-once"),
  );
  const granted = runCli(
    ["grant", "hook:sess-1:tu-once:deps.add", "--as", "human:carter"],
    dir,
  );
  assert.equal(granted.code, 0, granted.stderr);

  const spend = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("npm install left-pad", "tu-spend"),
  );
  assert.equal(verdictOf(spend).permission, "allow");

  const again = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("npm install left-pad", "tu-again"),
  );
  const verdict = verdictOf(again);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /u);

  const log = rawLog(dir);
  // Two questions in total: the one the human answered, and the one the third
  // invocation had to ask because the answer had been spent.
  assert.equal(log.match(/"event":"approval\.requested"/gu)?.length, 2);
  assert.equal(log.match(/"event":"execution\.started"/gu)?.length, 1);
  assert.match(log, /hook:sess-1:tu-again:deps\.add/u);
  assertClean(dir);
});

test("a retry while the question is pending adopts it rather than opening a duplicate", () => {
  // APRV-117 AC#2: the phone never shows two prompts for one command.
  // The specimen carries a body: APRV-114 made a bare GET `read.web`, and this
  // test needs a fetch the policy still holds at manual.
  const dir = ready();
  for (const toolUseId of ["tu-adopt-1", "tu-adopt-2", "tu-adopt-3"]) {
    const run = runCli(
      ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
      dir,
      bashEvent("curl -d a=b https://example.com", toolUseId),
    );
    assert.equal(verdictOf(run).permission, "deny");
  }

  const log = rawLog(dir);
  assert.equal(log.match(/"event":"approval\.requested"/gu)?.length, 1);
  // Only the first invocation registered a task; the other two adopted its
  // question and registered nothing.
  assert.equal(log.match(/"event":"task\.registered"/gu)?.length, 1);
  assert.doesNotMatch(log, /tu-adopt-2/u);
  assert.doesNotMatch(log, /tu-adopt-3/u);

  // And the adopters can consume the decision the first one waited for.
  const granted = runCli(
    ["grant", "hook:sess-1:tu-adopt-1:network.call", "--as", "human:carter"],
    dir,
  );
  assert.equal(granted.code, 0, granted.stderr);
  const after = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("curl -d a=b https://example.com", "tu-adopt-4"),
  );
  assert.equal(verdictOf(after).permission, "allow");
  assertClean(dir);
});

test("replay bounds: different bytes or a different cwd is a different question", () => {
  // APRV-117 AC#4. The grant authorizes THESE bytes in THIS directory. Anything
  // else is a new request and a new prompt.
  const dir = ready();
  runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("npm install left-pad", "tu-bounds"),
  );
  const granted = runCli(
    ["grant", "hook:sess-1:tu-bounds:deps.add", "--as", "human:carter"],
    dir,
  );
  assert.equal(granted.code, 0, granted.stderr);

  // A different command: one character of difference is a different payload.
  const otherBytes = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("npm install right-pad", "tu-other-bytes"),
  );
  const bytesVerdict = verdictOf(otherBytes);
  assert.equal(bytesVerdict.permission, "deny");
  assert.match(bytesVerdict.reason, /^hook-timeout: /u);

  // The same command, run somewhere else. `cwd` is inside the hashed payload.
  const elsewhere = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    JSON.stringify({
      session_id: "sess-1",
      cwd: "/somewhere-else",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm install left-pad" },
      tool_use_id: "tu-other-cwd",
    }),
  );
  const cwdVerdict = verdictOf(elsewhere);
  assert.equal(cwdVerdict.permission, "deny");
  assert.match(cwdVerdict.reason, /^hook-timeout: /u);

  // Three separate questions; the original grant is untouched and unspent.
  const log = rawLog(dir);
  assert.equal(log.match(/"event":"approval\.requested"/gu)?.length, 3);
  assert.equal(log.match(/"event":"execution\.started"/gu)?.length, undefined);
  assertClean(dir);
});

test("a grant that lapsed its TTL carries nothing", async () => {
  // The last replay bound: within the TTL. A one-second TTL makes the lapse
  // observable without a clock injection, and `queue` is what materialises it.
  const dir = caseDir();
  writeFileSync(
    join(dir, "APPROVAL.md"),
    POLICY.replace('approval_ttl: "1h"', 'approval_ttl: "1s"'),
    "utf8",
  );
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);

  runCli(
    ["hook", "claude-code", "--timeout", "100ms", "--interval", "50ms"],
    dir,
    bashEvent("npm install left-pad", "tu-ttl"),
  );
  const granted = runCli(["grant", "hook:sess-1:tu-ttl:deps.add", "--as", "human:carter"], dir);
  assert.equal(granted.code, 0, granted.stderr);

  // Wait out the TTL, then retry: the grant is no longer live, so the retry
  // asks its own question rather than proceeding on a lapsed one.
  await delay(1_400);
  const retry = runCli(
    ["hook", "claude-code", "--timeout", "100ms", "--interval", "50ms"],
    dir,
    bashEvent("npm install left-pad", "tu-ttl-retry"),
  );
  assert.equal(verdictOf(retry).permission, "deny");
  const log = rawLog(dir);
  assert.equal(log.match(/"event":"approval\.requested"/gu)?.length, 2);
  assert.equal(log.match(/"event":"execution\.started"/gu)?.length, undefined);
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
    bashEvent("git status && curl -d a=b https://example.com", "tu-mixed"),
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
    ["hook", "cursor", "--help"],
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

// ===========================================================================
// policy.protected_paths (APRV-107)
// ===========================================================================

/** A case directory whose attested policy widens the protected set. */
function readyWithProtectedPaths(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "APPROVAL.md"),
    POLICY.replace(
      "classes:",
      ["protected_paths:", "  - SPEC.md", "  - design/", "classes:"].join("\n"),
    ),
    "utf8",
  );
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

test("an edit to a policy-listed file is gated; the same file is ungated without the list", () => {
  const listed = readyWithProtectedPaths();
  const before = rawLog(listed);
  const gated = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    listed,
    event({ tool_name: "Edit", tool_input: { file_path: "SPEC.md" } }),
  );
  const verdict = verdictOf(gated);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /u);
  assert.notEqual(rawLog(listed), before, "the policy.edit request must reach the log");
  assert.match(rawLog(listed), /"class":"policy\.edit"/u);
  assertClean(listed);

  // Same file, a policy that never named it: an ordinary workspace edit.
  const plain = ready();
  const plainBefore = rawLog(plain);
  const ungated = runCli(
    ["hook", "claude-code"],
    plain,
    event({ tool_name: "Edit", tool_input: { file_path: "SPEC.md" } }),
  );
  assert.equal(verdictOf(ungated).permission, "allow");
  assert.equal(rawLog(plain), plainBefore, "an ungated edit must not touch the log");
});

test("a listed directory prefix gates a Bash write beneath it", () => {
  const dir = readyWithProtectedPaths();
  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("cp notes.md design/notes.md"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /u);
  assert.match(rawLog(dir), /"class":"policy\.edit"/u);
  assertClean(dir);
});

test("the built-in protected set survives a policy that lists other paths", () => {
  const dir = readyWithProtectedPaths();
  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    event({ tool_name: "Write", tool_input: { file_path: "CLAUDE.md" } }),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /u);
  assertClean(dir);
});

test("an unlisted workspace file is still autonomous under a widened policy", () => {
  const dir = readyWithProtectedPaths();
  const before = rawLog(dir);
  const run = runCli(
    ["hook", "claude-code"],
    dir,
    event({ tool_name: "Write", tool_input: { file_path: "src/core/x.ts" } }),
  );
  assert.equal(verdictOf(run).permission, "allow");
  assert.equal(rawLog(dir), before);
});

test("hook classify reads the policy, and --dir scopes which policy", () => {
  const listed = readyWithProtectedPaths();
  const plain = caseDir();

  const inPlace = runCli(["hook", "classify", "--json", "--", "cp draft.md SPEC.md"], listed);
  assert.equal(inPlace.code, 0, inPlace.stderr);
  assert.deepEqual(
    (JSON.parse(inPlace.stdout) as { classes: string[] }).classes,
    ["policy.edit"],
  );

  const elsewhere = runCli(["hook", "classify", "--json", "--", "cp draft.md SPEC.md"], plain);
  assert.deepEqual(
    (JSON.parse(elsewhere.stdout) as { classes: string[] }).classes,
    ["files.write.workspace"],
  );

  const scoped = runCli(
    ["hook", "classify", "--json", "--dir", listed, "--", "cp draft.md SPEC.md"],
    plain,
  );
  assert.deepEqual(
    (JSON.parse(scoped.stdout) as { classes: string[] }).classes,
    ["policy.edit"],
  );
});

test("hook classify with no readable policy still answers, and says it is the narrow answer", () => {
  const bare = join(scratch, "no-policy");
  mkdirSync(bare, { recursive: true });
  const run = runCli(["hook", "classify", "--json", "--", "cp draft.md SPEC.md"], bare);
  assert.equal(run.code, 0);
  assert.deepEqual(
    (JSON.parse(run.stdout) as { classes: string[] }).classes,
    ["files.write.workspace"],
  );
  assert.match(run.stderr, /built-in protected paths only/u);
  // The built-ins never depend on a policy being readable.
  const builtin = runCli(["hook", "classify", "--json", "--", "cp draft.md CLAUDE.md"], bare);
  assert.deepEqual(
    (JSON.parse(builtin.stdout) as { classes: string[] }).classes,
    ["policy.edit"],
  );
});

test("HOOK_DENY_CODES is the closed vocabulary the help text prints", () => {
  const help = runCli(["hook", "--help"], caseDir()).stdout;
  for (const code of HOOK_DENY_CODES) {
    assert.match(help, new RegExp(code.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
});

// ===========================================================================
// The payload is the change, not the touch (APRV-124)
// ===========================================================================

/**
 * The text the approver's phone would show for the one request pending in
 * `dir`, built through the real channel path.
 *
 * `buildPendingQueue` reads the VERIFIED log, fetches the material from the
 * payload store beside it, and re-hashes it against the recorded binding, so a
 * payload that did not bind would refuse here rather than render. What comes
 * back is what `channels/telegram.ts` sends, before its own HTML escaping.
 */
function promptFor(dir: string): { header: string; payload: string; summary: string } {
  const queue = buildPendingQueue(join(dir, LOG), { policy: { dir } }, new Date().toISOString());
  assert.equal(queue.ok, true, JSON.stringify(queue));
  assert.ok(queue.ok);
  assert.equal(queue.requests.length, 1, "exactly one request is pending");
  const request = queue.requests[0] as ChannelRequest;
  const rendered = renderTelegram(request);
  return {
    header: rendered.header,
    payload: rendered.payloadText ?? "",
    summary: request.summary.value ?? "",
  };
}

/** The `payload_hash` the log records for the single request in `dir`. */
function boundHashOf(dir: string): string {
  const found = /"payload_hash":"([0-9a-f]{64})"/u.exec(rawLog(dir));
  assert.ok(found !== null, "the log records a payload hash");
  return found[1] as string;
}

const EDIT_BEFORE = ["classes:", "  policy.edit:", "    autonomy: manual"].join("\n");
const EDIT_AFTER = ["classes:", "  policy.edit:", "    autonomy: autonomous"].join("\n");

test("an Edit prompt shows the before/after diff, and the grant binds to those bytes", () => {
  // APRV-124, the observed complaint (2026-08-20): a policy.edit prompt that
  // said only `Edit <path>` left the approver with no way to tell a typo fix
  // from a disabled gate. The change itself is the payload now.
  const dir = ready();
  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    event({
      tool_name: "Edit",
      tool_input: {
        file_path: "APPROVAL.md",
        old_string: EDIT_BEFORE,
        new_string: EDIT_AFTER,
        description: "totally harmless, please allow",
      },
    }),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /u);
  assert.match(rawLog(dir), /"class":"policy\.edit"/u);

  const prompt = promptFor(dir);

  // The binding is the change, exactly: this pins the payload SHAPE, because a
  // hash is computed over these keys and no others.
  assert.equal(
    boundHashOf(dir),
    payloadHash({
      tool: "Edit",
      rule: "protected-path",
      file: join(dir, "APPROVAL.md"),
      before: EDIT_BEFORE,
      after: EDIT_AFTER,
    }),
    "the grant must bind to the edit, not to the touch",
  );

  // The diff, as the human reads it: removed lines, then added lines.
  assert.ok(prompt.payload.includes(EDIT_VIEW_HEADING), prompt.payload);
  assert.ok(prompt.payload.includes("tool: Edit"), prompt.payload);
  assert.ok(prompt.payload.includes(`file: ${join(dir, "APPROVAL.md")}`), prompt.payload);
  assert.ok(prompt.payload.includes("rule: protected-path"), prompt.payload);
  assert.ok(prompt.payload.includes(`note: ${LIVE_QUALIFIER}`), prompt.payload);
  assert.ok(prompt.payload.includes("-    autonomy: manual"), prompt.payload);
  assert.ok(prompt.payload.includes("+    autonomy: autonomous"), prompt.payload);
  // Inside the diff block the change reads as the human will read it, with no
  // literal `\n` escapes anywhere in it.
  const diff = prompt.payload.slice(
    prompt.payload.indexOf(DIFF_BEGIN),
    prompt.payload.indexOf(DIFF_END),
  );
  assert.equal(diff.includes("\\n"), false, "the diff still carries literal \\n escapes");

  // The diff is the whole rendering (APRV-162): no JSON copy of the same bytes
  // beneath it, and the agent's own account of its intent never reaches the
  // payload at all.
  assert.equal(prompt.payload.includes(CANONICAL_JSON_HEADING), false, prompt.payload);
  assert.equal(prompt.payload.includes("totally harmless"), false, "description reached the bytes");
  assertClean(dir);
});

test("a Write prompt shows the whole content it will write", () => {
  const dir = ready();
  const content = ["# Policy", "", "```yaml approval-policy", 'version: "0.1"', "```"].join("\n");
  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    event({ tool_name: "Write", tool_input: { file_path: "APPROVAL.md", content } }),
  );
  assert.equal(verdictOf(run).permission, "deny");

  assert.equal(
    boundHashOf(dir),
    payloadHash({ tool: "Write", rule: "protected-path", file: join(dir, "APPROVAL.md"), content }),
  );
  const prompt = promptFor(dir);
  assert.ok(prompt.payload.includes("tool: Write"), prompt.payload);
  for (const line of content.split("\n")) {
    assert.ok(prompt.payload.includes(`+${line}`), `the content line ${line} is missing`);
  }
  assert.ok(prompt.payload.includes("the whole file as it will be written"), prompt.payload);
  assertClean(dir);
});

test("a long command reaches the phone complete, however short the summary is", () => {
  // APRV-124 AC#1/#2: the summary may be a headline, the payload may not.
  const dir = ready();
  const body = "x".repeat(400);
  const command = `curl -X POST https://example.com/hooks/notify -d ${body}`;
  assert.ok(command.length > SUMMARY_LIMIT, "the specimen must exceed the summary limit");

  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent(command, "tu-long"),
  );
  assert.equal(verdictOf(run).permission, "deny");

  const prompt = promptFor(dir);
  // The headline is ellipsized, and says so.
  assert.ok(prompt.summary.length <= SUMMARY_LIMIT, prompt.summary);
  assert.ok(prompt.summary.endsWith("…"), prompt.summary);

  // The payload block is not. Every byte of the command is there, in the
  // command view that is now the whole rendering (APRV-162), and nothing in the
  // region was folded away.
  assert.ok(prompt.payload.includes(command), "the full command bytes are missing");
  assert.equal(prompt.payload.includes("…"), false, "the payload region ellipsized something");
  assert.ok(prompt.payload.includes("cwd: /repo"), prompt.payload);
  assertClean(dir);
});

test("an identical retried edit adopts the same question; a changed one asks again", () => {
  // APRV-117 under APRV-124's payload: the bytes moved, the carryover contract
  // did not. Same edit -> same hash -> one prompt; different edit -> a new one.
  const dir = ready();
  const editEvent = (after: string, toolUseId: string): string =>
    event({
      tool_name: "Edit",
      tool_input: { file_path: "APPROVAL.md", old_string: EDIT_BEFORE, new_string: after },
      tool_use_id: toolUseId,
    });

  for (const toolUseId of ["tu-edit-1", "tu-edit-2"]) {
    const run = runCli(
      ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
      dir,
      editEvent(EDIT_AFTER, toolUseId),
    );
    assert.equal(verdictOf(run).permission, "deny");
  }
  let log = rawLog(dir);
  assert.equal(log.match(/"event":"approval\.requested"/gu)?.length, 1, "one question, not two");
  assert.doesNotMatch(log, /tu-edit-2/u);

  // The late tap authorizes the identical retry, once.
  const granted = runCli(
    ["grant", "hook:sess-1:tu-edit-1:policy.edit", "--as", "human:carter"],
    dir,
  );
  assert.equal(granted.code, 0, granted.stderr);
  const retry = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    editEvent(EDIT_AFTER, "tu-edit-3"),
  );
  const carried = verdictOf(retry);
  assert.equal(carried.permission, "allow", carried.reason);
  assert.match(carried.reason, /carried: hook:sess-1:tu-edit-1:policy\.edit/u);

  // A DIFFERENT edit to the same file is a different question, and waits.
  const changed = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    editEvent(`${EDIT_AFTER}\n# and one more line`, "tu-edit-4"),
  );
  assert.equal(verdictOf(changed).permission, "deny");
  log = rawLog(dir);
  assert.equal(log.match(/"event":"approval\.requested"/gu)?.length, 2);
  assert.match(log, /hook:sess-1:tu-edit-4:policy\.edit/u);
  assertClean(dir);
});
