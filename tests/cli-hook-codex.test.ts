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
  symlinkSync,
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
  "  files.write.workspace: { autonomy: autonomous }",
  "  deps.add: { autonomy: manual }",
  "```",
  "",
].join("\n");

function ready(policy = POLICY): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), policy, "utf8");
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
  const changedTool = codexBinding(
    input({ toolName: "apply_patch", toolInput: { command: "printf one" } }),
    firstDir,
  );
  assert.notEqual(anotherTool.task, baseline.task);
  assert.notEqual(changedBytes.task, baseline.task);
  assert.notEqual(changedSession.task, baseline.task);
  assert.notEqual(changedCwd.task, baseline.task);
  assert.notEqual(changedTool.task, baseline.task);
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

test("Codex apply_patch gates the full raw patch and unions ordinary and protected targets", () => {
  const dir = ready();
  writeFileSync(join(dir, "ordinary.txt"), "old\n");
  mkdirSync(join(dir, ".codex"), { recursive: true });
  const ordinaryPatch = "*** Begin Patch\n*** Update File: ordinary.txt\n@@\n-old\n+new\n*** End Patch";
  const allowed = verdictOf(runCli(
    ["hook", "codex"],
    dir,
    event(dir, { tool_name: "apply_patch", tool_input: { command: ordinaryPatch } }),
  ));
  assert.equal(allowed.permission, "allow");
  assert.match(allowed.reason, /^autonomous: /u);

  const mixedPatch = [
    "*** Begin Patch",
    "*** Update File: ordinary.txt",
    "@@",
    "-old",
    "+newer",
    "*** Add File: .codex/hooks.json",
    "+{}",
    "*** End Patch",
  ].join("\n");
  const denied = verdictOf(runCli(
    ["hook", "codex", "--timeout", "1ms", "--interval", "1ms", "--retry-grace", "1ms"],
    dir,
    event(dir, {
      tool_use_id: "patch-two",
      tool_name: "apply_patch",
      tool_input: { command: mixedPatch },
    }),
  ));
  assert.equal(denied.permission, "deny");
  assert.match(denied.reason, /^hook-timeout: /u);

  const records = rawLog(dir).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const request = records.findLast((record) => record["event"] === "approval.requested");
  assert.ok(request !== undefined);
  const hash = String((request["payload"] as Record<string, unknown>)["payload_hash"]);
  const value = JSON.parse(readFileSync(join(dir, ".approval", "payloads", `${hash}.json`), "utf8"));
  assert.deepEqual(value, { tool: "apply_patch", command: mixedPatch, cwd: dir });
  assert.equal(runCli(["log", "verify"], dir).code, 0);
});

test("Codex apply_patch rejects malformed patches without appending", () => {
  const dir = ready();
  const before = rawLog(dir);
  for (const command of [
    "*** Begin Patch\n*** End Patch",
    "*** Begin Patch\n*** Add File: ../escape\n+x\n*** End Patch",
    "*** Begin Patch\n*** Delete File: missing\n*** End Patch",
  ]) {
    const result = verdictOf(runCli(
      ["hook", "codex"],
      dir,
      event(dir, { tool_name: "apply_patch", tool_input: { command } }),
    ));
    assert.equal(result.permission, "deny");
    assert.match(result.reason, /^hook-io: /u);
  }
  assert.equal(rawLog(dir), before);
});

test("Codex applies supervised and human-only policy to Bash and apply_patch", () => {
  const supervisedPolicy = POLICY.replace(
    "  files.write.workspace: { autonomy: autonomous }",
    "  files.write.workspace: { autonomy: supervised }",
  );
  for (const tool of ["Bash", "apply_patch"] as const) {
    const dir = ready(supervisedPolicy);
    const command = tool === "Bash"
      ? "printf x > ordinary.txt"
      : "*** Begin Patch\n*** Add File: ordinary.txt\n+x\n*** End Patch";
    const result = verdictOf(runCli(
      ["hook", "codex"],
      dir,
      event(dir, { tool_name: tool, tool_input: { command } }),
    ));
    assert.equal(result.permission, "allow", tool);
    assert.match(result.reason, /files\.write\.workspace needs no approval/u, tool);
    assert.doesNotMatch(rawLog(dir), /"event":"approval\.requested"/u);
  }

  const humanOnlyPolicy = POLICY.replace(
    "  deps.add: { autonomy: manual }",
    "  deps.add: { autonomy: manual }\n  policy.core: { autonomy: human-only }\n  log.mutate: { autonomy: human-only }",
  );
  for (const tool of ["Bash", "apply_patch"] as const) {
    const dir = ready(humanOnlyPolicy);
    mkdirSync(join(dir, ".codex"), { recursive: true });
    const before = rawLog(dir);
    const command = tool === "Bash"
      ? "printf x > .codex/config.toml"
      : "*** Begin Patch\n*** Add File: .codex/config.toml\n+x\n*** End Patch";
    const result = verdictOf(runCli(
      ["hook", "codex"],
      dir,
      event(dir, { tool_name: tool, tool_input: { command } }),
    ));
    assert.equal(result.permission, "deny", tool);
    assert.match(result.reason, /^hook-class-human-only: /u, tool);
    assert.equal(rawLog(dir), before, `${tool} human-only refusal appends nothing`);
  }
});

test("Codex Bash protects hook organs across a simple cwd change", () => {
  const humanOnlyPolicy = POLICY.replace(
    "  deps.add: { autonomy: manual }",
    "  deps.add: { autonomy: manual }\n  policy.core: { autonomy: human-only }\n  log.mutate: { autonomy: human-only }",
  );
  for (const command of [
    "cd ./.codex && printf x > hooks.json",
    "cd ./.codex/foo && printf x > ../config.toml",
    "cd ./.codex/hooks && printf x > script.sh",
    "cd ./.codex && > hooks.json",
  ]) {
    const dir = ready(humanOnlyPolicy);
    mkdirSync(join(dir, ".codex", "foo"), { recursive: true });
    mkdirSync(join(dir, ".codex", "hooks"), { recursive: true });
    const before = rawLog(dir);
    const result = verdictOf(runCli(["hook", "codex"], dir, event(dir, { tool_input: { command } })));
    assert.equal(result.permission, "deny", command);
    assert.match(result.reason, /^hook-class-human-only: /u, command);
    assert.equal(rawLog(dir), before, command);
  }

  const dir = ready(humanOnlyPolicy);
  const nested = join(dir, ".codex");
  mkdirSync(nested, { recursive: true });
  for (const [tool, command] of [
    ["Bash", "printf x > hooks.json"],
    ["apply_patch", "*** Begin Patch\n*** Add File: hooks.json\n+x\n*** End Patch"],
  ] as const) {
    const result = verdictOf(runCli(
      ["hook", "codex", "--dir", dir],
      nested,
      event(nested, { tool_name: tool, tool_input: { command }, tool_use_id: `nested-${tool}` }),
    ));
    assert.equal(result.permission, "deny", tool);
    assert.match(result.reason, /^hook-class-human-only: /u, tool);
  }

  for (const [index, command] of [
    "> hooks.json",
    "cd /tmp > hooks.json",
    "true || cd /tmp; printf x > hooks.json",
  ].entries()) {
    const result = verdictOf(runCli(
      ["hook", "codex", "--dir", dir],
      nested,
      event(nested, { tool_input: { command }, tool_use_id: `nested-shell-${index}` }),
    ));
    assert.equal(result.permission, "deny", command);
    assert.match(result.reason, /^hook-class-human-only: /u, command);
  }

  const redirectedCd = verdictOf(runCli(
    ["hook", "codex", "--dir", dir],
    dir,
    event(dir, {
      tool_input: { command: "cd ./.codex > ordinary.txt; printf x > hooks.json" },
      tool_use_id: "redirected-cd",
    }),
  ));
  assert.equal(redirectedCd.permission, "deny");
  assert.match(redirectedCd.reason, /^hook-(?:io|class-human-only):/u);

  for (const [index, operand] of ["-", ".foo", ".codex"].entries()) {
    const unsupportedCd = verdictOf(runCli(
      ["hook", "codex"],
      dir,
      event(dir, {
        tool_input: { command: `cd ${operand}; printf x > ordinary.txt` },
        tool_use_id: `unsupported-cd-${index}`,
      }),
    ));
    assert.equal(unsupportedCd.permission, "deny", operand);
    assert.match(unsupportedCd.reason, /^hook-io:/u, operand);
  }

  mkdirSync(join(dir, "ordinary"), { recursive: true });
  symlinkSync(join(dir, "ordinary"), join(nested, "alias"));
  const logicalParent = verdictOf(runCli(
    ["hook", "codex"],
    dir,
    event(dir, {
      tool_input: { command: "cd ./.codex/alias; cd ..; printf x > hooks.json" },
      tool_use_id: "logical-parent",
    }),
  ));
  assert.equal(logicalParent.permission, "deny");
  assert.match(logicalParent.reason, /^hook-class-human-only:/u);

  const logCwd = join(dir, ".approval", "log");
  const logWrite = verdictOf(runCli(
    ["hook", "codex", "--dir", dir],
    logCwd,
    event(logCwd, { tool_input: { command: "printf x > events.jsonl" }, tool_use_id: "log-cwd" }),
  ));
  assert.equal(logWrite.permission, "deny");
  assert.match(logWrite.reason, /^hook-class-human-only:/u);
});

test("Codex duplicate pre delivery refuses a second execution", () => {
  const dir = ready();
  const input = event(dir);
  assert.equal(verdictOf(runCli(["hook", "codex"], dir, input)).permission, "allow");
  const duplicate = verdictOf(runCli(["hook", "codex"], dir, input));
  assert.equal(duplicate.permission, "deny");
  assert.match(duplicate.reason, /^hook-gate-refused:/u);
  assert.equal(rawLog(dir).match(/"event":"execution\.started"/gu)?.length, 1);
});

test("Codex carryover binds the exact patch bytes", () => {
  const command = "*** Begin Patch\n*** Add File: ordinary.txt\n+x\n*** End Patch";
  const dir = ready(
    POLICY.replace("files.write.workspace: { autonomy: autonomous }", "files.write.workspace: { autonomy: manual }"),
  );
  const native = event(dir, { tool_name: "apply_patch", tool_input: { command }, tool_use_id: "carry-a" });
  const timedOut = verdictOf(runCli(
    ["hook", "codex", "--timeout", "1ms", "--interval", "1ms", "--retry-grace", "1m"],
    dir,
    native,
  ));
  assert.match(timedOut.reason, /^hook-timeout:/u);
  const binding = codexBinding({
    sessionId: "codex-session-1", sessionIdPresent: true, cwd: dir,
    toolName: "apply_patch", toolInput: { command }, toolUseId: "carry-a",
    hookEventName: "PreToolUse", toolResponseRaw: undefined,
  }, dir);
  const grant = runCli(["grant", `${binding.task}:files.write.workspace`, "--as", "human:alice"], dir);
  assert.equal(grant.code, 0, grant.stderr);

  const changed = command.replace("+x", "+changed");
  const wrong = verdictOf(runCli(
    ["hook", "codex", "--timeout", "1ms", "--interval", "1ms", "--retry-grace", "1ms"],
    dir,
    event(dir, { tool_name: "apply_patch", tool_input: { command: changed }, tool_use_id: "carry-a" }),
  ));
  assert.match(wrong.reason, /^hook-timeout:/u);

  const carried = verdictOf(runCli(
    ["hook", "codex", "--timeout", "10ms", "--interval", "1ms"],
    dir,
    event(dir, { tool_name: "apply_patch", tool_input: { command }, tool_use_id: "carry-b" }),
  ));
  assert.equal(carried.permission, "allow");
  assert.match(carried.reason, /^granted: /u);
  assert.equal(runCli(["log", "verify"], dir).code, 0);
});

test("Codex budgets and unreachable logs fail closed", () => {
  const budgetPolicy = POLICY.replace("```\n", "budgets:\n  global:\n    daily_actions: 1\n```\n");
  const dir = ready(budgetPolicy);
  assert.equal(verdictOf(runCli(["hook", "codex"], dir, event(dir))).permission, "allow");
  const budget = verdictOf(runCli(
    ["hook", "codex"], dir, event(dir, { tool_use_id: "budget-two" }),
  ));
  assert.equal(budget.permission, "deny");
  assert.match(budget.reason, /^hook-gate-refused:/u);

  const unreachableDir = ready();
  const before = rawLog(unreachableDir);
  const unavailable = verdictOf(runCli(
    ["hook", "codex", "--log", join(unreachableDir, "missing", "events.jsonl")],
    unreachableDir,
    event(unreachableDir),
  ));
  assert.equal(unavailable.permission, "deny");
  assert.match(unavailable.reason, /^hook-log-unreachable:/u);
  assert.equal(rawLog(unreachableDir), before);

  // An existing non-log file is a static corrupt input; the test does not
  // fabricate or mutate an event record.
  const packageJson = fileURLToPath(new URL("../../package.json", import.meta.url));
  const corrupt = verdictOf(runCli(
    ["hook", "codex", "--log", packageJson],
    unreachableDir,
    event(unreachableDir, { tool_use_id: "corrupt-log" }),
  ));
  assert.equal(corrupt.permission, "deny");
  assert.match(corrupt.reason, /^hook-io:/u);
  assert.equal(rawLog(unreachableDir), before);
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
