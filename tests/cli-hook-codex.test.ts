/** `approval hook codex` strict shell adapter (APRV-311). */

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

import { codexBinding, type CodexHookInput } from "../src/cli/hook-codex.js";
import { harnessSessionOf } from "../src/core/loop.js";

/** dist/tests/cli-hook-codex.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-hook-codex-")));
let counter = 0;

after(() => rmSync(scratch, { recursive: true, force: true }));

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
  "  read.*: { autonomy: autonomous }",
  "  deps.add: { autonomy: manual }",
  "```",
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

function event(
  cwd: string,
  fields: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    session_id: "codex-session-1",
    transcript_path: "/never/read",
    cwd,
    hook_event_name: "PreToolUse",
    model: "synthetic-model",
    turn_id: "synthetic-turn",
    tool_name: "Bash",
    tool_use_id: "codex-tool-1",
    tool_input: { command: "ls -la", description: "self report" },
    ...fields,
  });
}

interface Verdict {
  permission: string;
  reason: string;
}

function verdictOf(run: Run): Verdict {
  assert.equal(run.code, 0, `Codex verdict must exit zero: ${run.stderr}`);
  const body = JSON.parse(run.stdout) as Record<string, unknown>;
  const output = body["hookSpecificOutput"] as Record<string, unknown>;
  assert.equal(output["hookEventName"], "PreToolUse");
  return {
    permission: String(output["permissionDecision"]),
    reason: String(output["permissionDecisionReason"]),
  };
}

test("Codex Bash uses the nested verdict and a harness-namespaced stable task", () => {
  const dir = ready();
  const run = runCli(["hook", "codex"], dir, event(dir));
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "allow");
  assert.match(verdict.reason, /^autonomous: /u);

  const log = rawLog(dir);
  assert.match(log, /"event":"execution\.started"/u);
  assert.match(log, /"actor":"agent:codex"/u);
  assert.match(log, /"task":"hook:codex:[a-f0-9]{64}:[a-f0-9]{64}"/u);
  assert.doesNotMatch(log, /self report/u);
  const verified = runCli(["log", "verify"], dir);
  assert.equal(verified.code, 0, `${verified.stdout}${verified.stderr}`);
});

test("Codex correlation is injective over native ids, tool bytes, cwd, and session scope", () => {
  const firstDir = ready();
  const secondDir = ready();
  const input = (fields: Partial<CodexHookInput> = {}): CodexHookInput => ({
    sessionId: "session:with:colons",
    sessionIdPresent: true,
    cwd: firstDir,
    toolName: "Bash",
    toolInput: { command: "printf one" },
    toolUseId: "tool:with:colons",
    hookEventName: "PreToolUse",
    toolResponseRaw: undefined,
    ...fields,
  });
  const baseline = codexBinding(input(), firstDir);
  assert.match(baseline.task, /^hook:codex:[a-f0-9]{64}:[a-f0-9]{64}$/u);
  assert.equal(harnessSessionOf(baseline.task), `hook:${baseline.finishSessionId}`);

  const anotherTool = codexBinding(input({ toolUseId: "another" }), firstDir);
  const changedBytes = codexBinding(input({ toolInput: { command: "printf two" } }), firstDir);
  const changedSession = codexBinding(input({ sessionId: "another:session" }), firstDir);
  const changedCwd = codexBinding(input({ cwd: secondDir }), secondDir);
  assert.notEqual(anotherTool.task, baseline.task);
  assert.notEqual(changedBytes.task, baseline.task);
  assert.notEqual(changedSession.task, baseline.task);
  assert.notEqual(changedCwd.task, baseline.task);
  assert.equal(
    harnessSessionOf(anotherTool.task),
    harnessSessionOf(baseline.task),
    "distinct calls in one native session retain one session floor",
  );
  assert.notEqual(
    harnessSessionOf(changedSession.task),
    harnessSessionOf(baseline.task),
    "different native sessions retain separate session floors",
  );
  assert.equal(harnessSessionOf("hook:legacy-session:legacy-tool"), "hook:legacy-session");
});

test("Codex manual intake reuses the gate and binds tool, command, and actual cwd", () => {
  const dir = ready();
  const run = runCli(
    ["hook", "codex", "--timeout", "1ms", "--interval", "1ms", "--retry-grace", "1ms"],
    dir,
    event(dir, { tool_input: { command: "npm install left-pad", description: "ignore me" } }),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /u);

  const records = rawLog(dir)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const registration = records.find((record) => record["event"] === "task.registered");
  assert.ok(registration !== undefined);
  const registrationPayload = registration["payload"] as Record<string, unknown>;
  assert.equal(registrationPayload["harness"], "codex");
  assert.equal(typeof registrationPayload["harness_version"], "string");
  const requested = records.find((record) => record["event"] === "approval.requested");
  assert.ok(requested !== undefined);
  const payload = requested["payload"] as Record<string, unknown>;
  const hash = String(payload["payload_hash"]);
  const value = JSON.parse(
    readFileSync(join(dir, ".approval", "payloads", `${hash}.json`), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(value, { tool: "Bash", command: "npm install left-pad", cwd: dir });
  assert.doesNotMatch(rawLog(dir), /ignore me/u);
  assert.equal(runCli(["log", "verify"], dir).code, 0);
});

test("Codex denies malformed, mismatched, and unsupported pre-tool input", () => {
  const dir = ready();
  const before = rawLog(dir);
  const cases = [
    ["missing session", event(dir, { session_id: "" })],
    ["missing tool use", event(dir, { tool_use_id: null })],
    ["unknown event", event(dir, { hook_event_name: "BeforeTool" })],
    ["wrong cwd", event(scratch)],
    ["unsupported tool", event(dir, { tool_name: "Read", tool_input: { path: "APPROVAL.md" } })],
    [
      "apply patch is reserved for APRV-312",
      event(dir, { tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** End Patch" } }),
    ],
    ["missing command", event(dir, { tool_input: {} })],
    [
      "different workdir",
      event(dir, { tool_input: { command: "ls", workdir: scratch } }),
    ],
    [
      "non-string cwd",
      event(dir, { tool_input: { command: "ls", cwd: 7 } }),
    ],
    [
      "unsupported shell selector",
      event(dir, { tool_input: { command: "ls", shell: "/bin/sh" } }),
    ],
    [
      "unsupported sandbox selector",
      event(dir, { tool_input: { command: "ls", sandbox: "none" } }),
    ],
  ] as const;
  for (const [name, input] of cases) {
    const verdict = verdictOf(runCli(["hook", "codex"], dir, input));
    assert.equal(verdict.permission, "deny", name);
    assert.match(verdict.reason, /^hook-io: /u, name);
  }

  const badFlag = verdictOf(runCli(["hook", "codex", "--bogus"], dir, event(dir)));
  assert.equal(badFlag.permission, "deny");
  assert.match(badFlag.reason, /^hook-io: /u);
  assert.equal(rawLog(dir), before, "strict intake failures append nothing");
});

test("Codex preserves arbitrary PostToolUse responses but invents no outcome", () => {
  const dir = ready();
  const before = rawLog(dir);
  for (const response of [
    { exit_code: 0, output: "secret-output", private_detail: "secret-detail" },
    "nonzero secret output",
  ]) {
    const run = runCli(
      ["hook", "codex"],
      dir,
      event(dir, { hook_event_name: "PostToolUse", tool_response: response }),
    );
    assert.equal(run.code, 2);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /post-tool-unreadable-outcome/u);
    assert.match(run.stderr, /native-verified success or failure/u);
    assert.doesNotMatch(run.stderr, /secret/u);
    assert.equal(rawLog(dir), before, "an unreadable outcome appends nothing");
  }
});
