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

import {
  codexArgv,
  codexArgvDisagrees,
  codexBinding,
  type CodexHookInput,
} from "../src/cli/hook-codex.js";
import { decide, finishHarnessExecution, register, request } from "../src/core/gate.js";
import { openWindow } from "../src/core/gate-window.js";
import { harnessSessionOf } from "../src/core/loop.js";
import { payloadHash } from "../src/core/payload.js";

/** dist/tests/cli-hook-codex.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
/** dist/tests/ -> the repository root, for the reviewed native evidence. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
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
  updatedInput?: unknown;
}

function verdictOf(run: Run): Verdict {
  assert.equal(run.code, 0, `Codex verdict must exit zero: ${run.stderr}`);
  const body = JSON.parse(run.stdout) as Record<string, unknown>;
  const output = body["hookSpecificOutput"] as Record<string, unknown>;
  assert.equal(output["hookEventName"], "PreToolUse");
  const permission = String(output["permissionDecision"]);
  if (permission === "deny") {
    assert.equal(Object.hasOwn(output, "updatedInput"), false, "a deny must not rewrite input");
  } else if (permission === "allow") {
    assert.equal(typeof (output["updatedInput"] as Record<string, unknown>)?.["command"], "string");
  }
  return {
    permission,
    reason: String(output["permissionDecisionReason"]),
    ...(Object.hasOwn(output, "updatedInput") ? { updatedInput: output["updatedInput"] } : {}),
  };
}

function assertIdentityAllow(verdict: Verdict, command: string): void {
  assert.equal(verdict.permission, "allow");
  assert.deepEqual(verdict.updatedInput, { command });
}

test("Codex apply_patch uses the nested verdict and a harness-namespaced stable task", () => {
  const dir = ready();
  const command = "*** Begin Patch\n*** Add File: ordinary.txt\n+x\n*** End Patch";
  const run = runCli(
    ["hook", "codex"],
    dir,
    event(dir, { tool_name: "apply_patch", tool_input: { command } }),
  );
  const verdict = verdictOf(run);
  assertIdentityAllow(verdict, command);
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

test("APRV-362: an argv is bound only when the command string splits to exactly it", () => {
  const dir = ready();
  const input = (toolInput: Record<string, unknown>): CodexHookInput => ({
    sessionId: "session-1",
    sessionIdPresent: true,
    cwd: dir,
    toolName: "Bash",
    toolInput,
    toolUseId: "call-1",
    hookEventName: "PreToolUse",
    toolResponseRaw: undefined,
  });

  // The bridge's own shape: the argv agrees, so the payload names both.
  const agreeing = { command: "curl -d 'a=b c' https://x.test", argv: ["curl", "-d", "a=b c", "https://x.test"] };
  assert.deepEqual(codexArgv(agreeing, agreeing.command), agreeing.argv);
  assert.deepEqual(codexBinding(input(agreeing), dir).payload.argv, agreeing.argv);

  // A call with no argv binds exactly as every call did before APRV-362: the
  // key is absent from the payload rather than present and empty, so the hash
  // of an untouched call is untouched.
  const plain = { command: "curl -d 'a=b c' https://x.test" };
  assert.equal(codexArgv(plain, plain.command), null);
  assert.equal(codexArgvDisagrees(plain, plain.command), false);
  assert.equal("argv" in codexBinding(input(plain), dir).payload, false);

  // `tool_input` on a native event is the MODEL's tool-call arguments, so an
  // argv can arrive that the command does not split to. It buys nothing: the
  // field is a derivation of bytes already bound or it is not accepted at all,
  // and the caller refuses the call rather than binding one of two readings.
  for (const argv of [
    ["curl", "-d", "a=b", "c", "https://x.test"],
    ["rm", "-rf", "/"],
    ["curl"],
    ["curl", "-d", "a=b c"],
    "not-an-array",
    [1, 2],
  ]) {
    const lying = { command: "curl -d 'a=b c' https://x.test", argv };
    assert.equal(codexArgv(lying, lying.command), null, JSON.stringify(argv));
    assert.equal(codexArgvDisagrees(lying, lying.command), true, JSON.stringify(argv));
  }
});

test("Codex manual intake reuses the gate and binds tool, command, and actual cwd", () => {
  const dir = ready(
    POLICY.replace(
      "files.write.workspace: { autonomy: autonomous }",
      "files.write.workspace: { autonomy: manual }",
    ),
  );
  const command = "*** Begin Patch\n*** Add File: manual.txt\n+x\n*** End Patch";
  const run = runCli(
    ["hook", "codex", "--timeout", "1ms", "--interval", "1ms", "--retry-grace", "1ms"],
    dir,
    event(dir, {
      tool_name: "apply_patch",
      tool_input: { command, description: "ignore me" },
    }),
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
  assert.deepEqual(value, { tool: "apply_patch", command, cwd: dir });
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
    assert.equal(verdict.updatedInput, undefined, name);
    assert.match(verdict.reason, /^hook-io: /u, name);
  }

  const badFlag = verdictOf(runCli(["hook", "codex", "--bogus"], dir, event(dir)));
  assert.equal(badFlag.permission, "deny");
  assert.equal(badFlag.updatedInput, undefined);
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
  assertIdentityAllow(allowed, ordinaryPatch);
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
    if (tool === "Bash") {
      assert.equal(result.permission, "deny");
      assert.match(result.reason, /^hook-unsupported-execution-context: Codex Bash is disabled/u);
    } else {
      assertIdentityAllow(result, command);
      assert.match(result.reason, /files\.write\.workspace needs no approval/u, tool);
    }
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
    assert.match(
      result.reason,
      tool === "Bash" ? /^hook-unsupported-execution-context: Codex Bash is disabled/u : /^hook-class-human-only: /u,
      tool,
    );
    assert.equal(rawLog(dir), before, `${tool} human-only refusal appends nothing`);
  }
});

test("Codex Bash refuses before every policy and window path without appending", () => {
  const policies = [
    POLICY,
    POLICY.replace(
      "  files.write.workspace: { autonomy: autonomous }",
      "  files.write.workspace: { autonomy: supervised }",
    ),
    POLICY.replace(
      "  files.write.workspace: { autonomy: autonomous }",
      "  files.write.workspace: { autonomy: manual }",
    ),
    POLICY.replace(
      "  deps.add: { autonomy: manual }",
      "  deps.add: { autonomy: manual }\n  policy.core: { autonomy: human-only }",
    ),
  ];
  for (const [index, policy] of policies.entries()) {
    const dir = ready(policy);
    const before = rawLog(dir);
    const command = index === 3 ? "printf x > .codex/hooks.json" : "printf x > ordinary.txt";
    const verdict = verdictOf(runCli(
      ["hook", "codex"],
      dir,
      event(dir, { tool_input: { command }, tool_use_id: `bash-policy-${index}` }),
    ));
    assert.equal(verdict.permission, "deny");
    assert.match(verdict.reason, /^hook-unsupported-execution-context: Codex Bash is disabled/u);
    assert.equal(rawLog(dir), before);
  }

  const dir = ready();
  const opened = openWindow(
    join(dir, LOG),
    { durationText: "30m", durationMs: 30 * 60_000, reason: "Bash cwd contract test" },
    "human:alice",
  );
  assert.equal(opened.ok, true, opened.ok ? "" : `${opened.code}: ${opened.message}`);
  const before = rawLog(dir);
  for (const [toolUse, command] of [
    ["gate-open", "npm install left-pad"],
    ["gate-self", "approval status"],
  ]) {
    const verdict = verdictOf(runCli(
      ["hook", "codex"],
      dir,
      event(dir, { tool_input: { command }, tool_use_id: toolUse }),
    ));
    assert.equal(verdict.permission, "deny");
    assert.match(verdict.reason, /^hook-unsupported-execution-context: Codex Bash is disabled/u);
    assert.equal(rawLog(dir), before, `${toolUse} must not append`);
  }
});

test("Codex Bash refusal cannot consume an existing exact grant", () => {
  const dir = ready(
    POLICY.replace(
      "  files.write.workspace: { autonomy: autonomous }",
      "  files.write.workspace: { autonomy: manual }",
    ),
  );
  const command = "printf x > ordinary.txt";
  const nativeInput: CodexHookInput = {
    sessionId: "codex-session-1",
    sessionIdPresent: true,
    cwd: dir,
    toolName: "Bash",
    toolInput: { command },
    toolUseId: "bash-existing-grant",
    hookEventName: "PreToolUse",
    toolResponseRaw: undefined,
  };
  const binding = codexBinding(nativeInput, dir);
  const actionKey = `${binding.task}:files.write.workspace`;
  const hash = payloadHash(binding.payload);
  const options = { policy: { dir } };
  const registered = register(
    join(dir, LOG),
    {
      task: binding.task,
      envelope: {
        origin: { app: "codex-hook", created_by: "agent:codex" },
        state: "proposed",
        actions: [{
          class: "files.write.workspace",
          summary: "Existing Bash grant must stay unspent",
          idempotency_key: actionKey,
          payload_hash: hash,
        }],
      },
    },
    "agent:codex",
    options,
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);
  const requested = request(
    join(dir, LOG),
    {
      task: binding.task,
      actionKey,
      cls: "files.write.workspace",
      summary: "Existing Bash grant must stay unspent",
      payload_hash: hash,
      payload: { value: binding.payload },
      execution: "harness",
    },
    "agent:codex",
    options,
  );
  assert.equal(requested.ok, true, requested.ok ? "" : requested.message);
  const granted = decide(join(dir, LOG), actionKey, "grant", "human:alice", options);
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);

  const before = rawLog(dir);
  const verdict = verdictOf(runCli(
    ["hook", "codex"],
    dir,
    event(dir, { tool_input: { command }, tool_use_id: nativeInput.toolUseId }),
  ));
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-unsupported-execution-context: Codex Bash is disabled/u);
  assert.equal(rawLog(dir), before);
  assert.equal(before.match(/"event":"approval\.granted"/gu)?.length, 1);
  assert.doesNotMatch(before, /"event":"execution\.started"/u);
});

test("Codex duplicate pre delivery refuses a second execution", () => {
  const dir = ready();
  const command = "*** Begin Patch\n*** Add File: duplicate.txt\n+x\n*** End Patch";
  const input = event(dir, { tool_name: "apply_patch", tool_input: { command } });
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
  assert.deepEqual(carried.updatedInput, { command });
  assert.match(carried.reason, /^granted: /u);
  assert.equal(runCli(["log", "verify"], dir).code, 0);
});

test("Codex budgets and unreachable logs fail closed", () => {
  const budgetPolicy = POLICY.replace("```\n", "budgets:\n  global:\n    daily_actions: 1\n```\n");
  const dir = ready(budgetPolicy);
  const command = "*** Begin Patch\n*** Add File: budget.txt\n+x\n*** End Patch";
  const native = (toolUseId: string) => event(dir, {
    tool_name: "apply_patch",
    tool_input: { command },
    tool_use_id: toolUseId,
  });
  assert.equal(verdictOf(runCli(["hook", "codex"], dir, native("budget-one"))).permission, "allow");
  const budget = verdictOf(runCli(
    ["hook", "codex"], dir, native("budget-two"),
  ));
  assert.equal(budget.permission, "deny");
  assert.match(budget.reason, /^hook-gate-refused:/u);

  const unreachableDir = ready();
  const before = rawLog(unreachableDir);
  const unreachableCommand = "*** Begin Patch\n*** Add File: unreachable.txt\n+x\n*** End Patch";
  const unavailable = verdictOf(runCli(
    ["hook", "codex", "--log", join(unreachableDir, "missing", "events.jsonl")],
    unreachableDir,
    event(unreachableDir, {
      tool_name: "apply_patch",
      tool_input: { command: unreachableCommand },
    }),
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
    event(unreachableDir, {
      tool_name: "apply_patch",
      tool_input: { command: unreachableCommand },
      tool_use_id: "corrupt-log",
    }),
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

// ===========================================================================
// APRV-311: the post-execution phase, and the ids that join it to the pre one
// ===========================================================================

interface PostReport {
  code: string;
  detail: string;
  task?: string;
}

/** The one machine-readable line the post-execution half prints on stderr. */
function reportOf(run: Run): PostReport {
  const line = run.stderr.trimEnd().split("\n").at(-1) ?? "";
  const body = JSON.parse(line) as Record<string, unknown>;
  const approval = body["approval"] as Record<string, unknown>;
  assert.equal(approval["hook"], "post-tool-use", "a post-execution line names its phase");
  return {
    code: String(approval["code"]),
    detail: String(approval["detail"]),
    ...(approval["task"] === undefined ? {} : { task: String(approval["task"]) }),
  };
}

/** The binding the adapter mints for a native call, rebuilt from its fields. */
function bindingFor(
  dir: string,
  toolName: "Bash" | "apply_patch",
  command: string,
  toolUseId: string,
  sessionId = "codex-session-1",
): ReturnType<typeof codexBinding> {
  const input: CodexHookInput = {
    sessionId,
    sessionIdPresent: true,
    cwd: dir,
    toolName,
    toolInput: { command },
    toolUseId,
    hookEventName: "PreToolUse",
    toolResponseRaw: undefined,
  };
  return codexBinding(input, dir);
}

/**
 * A malformed PostToolUse event used to print a PreToolUse permission verdict.
 *
 * The call it describes has already run, so there is no permission left to
 * decide, and the verdict it printed was indistinguishable from the refusal the
 * pre-execution phase prints for the same malformed shape. The strict answer is
 * the one the rest of the post path gives: a machine-readable line on stderr at
 * the exit code that shows it, no verdict on stdout, and nothing appended.
 */
test("Codex post-phase input rejection reports and never prints a permission verdict", () => {
  const dir = ready();
  const elsewhere = join(scratch, "not-this-process");
  mkdirSync(elsewhere, { recursive: true });
  const before = rawLog(dir);
  const malformed: [string, Record<string, unknown>][] = [
    ["an unsupported tool", { tool_name: "WebFetch" }],
    ["an unstable tool_use_id", { tool_use_id: "not a stable id" }],
    ["an unstable session_id", { session_id: "not a stable id" }],
    ["a cwd that is not the hook process", { cwd: elsewhere }],
    ["an execution-affecting field the adapter does not know", {
      tool_input: { command: "ls -la", timeout_ms: 1000 },
    }],
  ];
  for (const [name, fields] of malformed) {
    const post = runCli(
      ["hook", "codex"],
      dir,
      event(dir, { hook_event_name: "PostToolUse", tool_response: "", ...fields }),
    );
    assert.equal(post.code, 2, `${name}: the line must be visible`);
    assert.equal(post.stdout, "", `${name}: a finished call gets no verdict`);
    assert.equal(reportOf(post).code, "post-tool-io", name);
    assert.match(reportOf(post).detail, /nothing was appended/u, name);
    assert.equal(rawLog(dir), before, `${name}: a rejected post event appends nothing`);

    // The same malformed shape before execution is still a deny, in the
    // pre-execution vocabulary, with the verdict object Codex reads.
    const pre = verdictOf(runCli(["hook", "codex"], dir, event(dir, fields)));
    assert.equal(pre.permission, "deny", name);
    assert.match(pre.reason, /^hook-io: /u, name);
    assert.equal(rawLog(dir), before, `${name}: the pre refusal appends nothing either`);
  }
});

/**
 * The correlation, read off the REVIEWED NATIVE EVIDENCE rather than off a
 * hand-written pair (APRV-310 native v6, Codex CLI 0.152.1).
 *
 * It also pins the fact that keeps native Bash refused: every Bash event in
 * that run carried `command` and nothing else, and neither the event cwd nor
 * the hook process cwd moved with the directory the command actually ran in.
 */
test("Codex derives one stable id for the Pre and Post of the same native call", () => {
  const rows = readFileSync(
    join(REPO_ROOT, "tests", "fixtures", "codex-hook", "native-v6.sanitized.jsonl"),
    "utf8",
  )
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(rows.length, 18, "the reviewed native v6 run recorded 18 events");

  const dir = ready();
  const bindingOf = (row: Record<string, unknown>): ReturnType<typeof codexBinding> => {
    const toolInput = row["tool_input"] as Record<string, unknown>;
    return bindingFor(
      dir,
      row["tool_name"] as "Bash" | "apply_patch",
      String(toolInput["command"]),
      String(row["tool_use_id"]),
      String(row["session_id"]),
    );
  };

  for (const scenario of ["allow", "patch-allow"]) {
    const pair = rows.filter((row) => row["scenario"] === scenario);
    assert.equal(pair.length, 2, `${scenario} recorded exactly one Pre and one Post`);
    const pre = pair.find((row) => row["hook_event_name"] === "PreToolUse");
    const post = pair.find((row) => row["hook_event_name"] === "PostToolUse");
    assert.ok(pre !== undefined && post !== undefined, `${scenario} has both phases`);
    assert.equal(
      bindingOf(post).task,
      bindingOf(pre).task,
      `${scenario}: the post half reconstructs the task the pre half minted`,
    );
  }

  // Distinct native calls stay distinct, so one report cannot close another
  // call's start.
  const distinct = new Set(
    rows.filter((row) => row["hook_event_name"] === "PreToolUse").map((row) => bindingOf(row).task),
  );
  const preCount = rows.filter((row) => row["hook_event_name"] === "PreToolUse").length;
  assert.equal(distinct.size, preCount, "every observed Pre event has its own task id");

  for (const row of rows.filter((row) => row["tool_name"] === "Bash")) {
    assert.deepEqual(
      row["tool_input_keys"],
      ["command"],
      "native Bash tool_input carried only the command",
    );
    assert.equal(row["tool_input_cwd_type"], "missing");
    assert.equal(row["tool_input_workdir_type"], "missing");
  }
  const nested = rows.find((row) => row["scenario"] === "nested");
  assert.ok(nested !== undefined, "the directory control is in the reviewed run");
  assert.equal(nested["cwd_matches_nested"], false);
  assert.equal(nested["hook_process_cwd_matches_nested"], false);
});

/**
 * The outcome stays open, and the line that says so says WHICH start it left
 * open.
 *
 * Codex 0.152.1 returns the same empty-string `tool_response` for an exit 0 and
 * an exit 7 Bash call, emits no separate failure event, and exposes no status
 * field, so there is no reading to take. Appending either outcome would
 * manufacture it. What this adapter can honestly do is name the delegated
 * execution nobody closed.
 */
test("Codex leaves the outcome open and names the execution.started it did not close", () => {
  const dir = ready();
  const command = "*** Begin Patch\n*** Add File: outcome.txt\n+x\n*** End Patch";
  const fields = { tool_name: "apply_patch", tool_input: { command }, tool_use_id: "outcome-1" };
  assert.equal(verdictOf(runCli(["hook", "codex"], dir, event(dir, fields))).permission, "allow");
  const started = rawLog(dir);
  assert.equal(started.match(/"event":"execution\.started"/gu)?.length, 1);

  const binding = bindingFor(dir, "apply_patch", command, "outcome-1");
  for (const delivery of ["first", "second"]) {
    const post = runCli(
      ["hook", "codex"],
      dir,
      event(dir, { ...fields, hook_event_name: "PostToolUse", tool_response: "" }),
    );
    assert.equal(post.code, 2, delivery);
    assert.equal(post.stdout, "", delivery);
    const reported = reportOf(post);
    assert.equal(reported.code, "post-tool-unreadable-outcome", delivery);
    assert.equal(reported.task, binding.task, `${delivery}: the report names the open start`);
    assert.equal(rawLog(dir), started, `${delivery}: an unreadable outcome appends nothing`);
  }
  assert.equal(runCli(["log", "verify"], dir).code, 0);
});

/**
 * Correlation and duplicate refusal for Codex ids, on the real append path.
 *
 * WHAT THIS PROVES: the ids the Codex adapter mints address exactly the
 * delegated execution its own pre half started, one report closes it, and a
 * second is refused by the gate rather than appended twice.
 *
 * WHAT IT DOES NOT PROVE: that a native Codex PostToolUse event can reach this
 * path. On CLI 0.152.1 it cannot, because no reading of that event
 * distinguishes success from failure (see the test above). The outcome is
 * supplied here by the test, exactly as `approval report` supplies one, and the
 * adapter still refuses to infer it from an event.
 */
test("Codex stable ids close their own delegated execution once, and a duplicate refuses", () => {
  const dir = ready();
  const command = "*** Begin Patch\n*** Add File: finish.txt\n+x\n*** End Patch";
  const fields = { tool_name: "apply_patch", tool_input: { command }, tool_use_id: "finish-1" };
  assert.equal(verdictOf(runCli(["hook", "codex"], dir, event(dir, fields))).permission, "allow");

  const binding = bindingFor(dir, "apply_patch", command, "finish-1");
  const logPath = join(dir, LOG);
  const finish = (outcome: "completed" | "failed"): ReturnType<typeof finishHarnessExecution> =>
    finishHarnessExecution(
      logPath,
      {
        sessionId: binding.finishSessionId,
        toolUseId: binding.finishToolUseId,
        outcome,
        reportedBy: "post-tool-use",
      },
      "agent:codex",
      { policy: { dir } },
    );

  const first = finish("completed");
  assert.equal(first.ok, true, first.ok ? "" : `${first.code}: ${first.message}`);
  assert.equal(first.ok && first.task, binding.task);
  assert.equal(first.ok && first.records.length, 1);

  const duplicate = finish("failed");
  assert.equal(duplicate.ok, false, "a second report of the same call is refused");
  assert.equal(duplicate.ok ? "" : duplicate.code, "already-finished");
  assert.equal(rawLog(dir).match(/"event":"execution\.completed"/gu)?.length, 1);

  // A different call's ids close nothing: there is no start under that task.
  const other = bindingFor(dir, "apply_patch", command, "finish-2");
  const stranger = finishHarnessExecution(
    logPath,
    {
      sessionId: other.finishSessionId,
      toolUseId: other.finishToolUseId,
      outcome: "completed",
      reportedBy: "post-tool-use",
    },
    "agent:codex",
    { policy: { dir } },
  );
  assert.equal(stranger.ok, false, "an unrelated task id closes nothing");
  assert.equal(rawLog(dir).match(/"event":"execution\.completed"/gu)?.length, 1);
  assert.equal(runCli(["log", "verify"], dir).code, 0);
});
