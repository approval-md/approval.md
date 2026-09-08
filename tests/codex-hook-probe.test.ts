import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// The production artifact is intentionally plain Node ESM so operators can run
// it before a build; its exports are exercised here without adding a .d.ts.
// @ts-expect-error no declaration file for the standalone probe script
import { sanitizeEvent, scenarioForEvent } from "../../scripts/codex-hook-probe.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "codex-hook-probe.mjs");
const FIXTURES = join(ROOT, "tests", "fixtures", "codex-hook");
const scratch = mkdtempSync(join(tmpdir(), "approval-codex-hook-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>;
}

function runHook(name: string, out: string) {
  return runHookEvent(fixture(name), out);
}

function runHookEvent(input: Record<string, unknown>, out: string) {
  return spawnSync(
    process.execPath,
    [SCRIPT, "hook", "--log", join(out, "events.jsonl"), "--scratch", out],
    { encoding: "utf8", input: `${JSON.stringify(input)}\n` },
  );
}

test("native-shaped Bash and apply_patch inputs select only explicit probe scenarios", () => {
  assert.equal(scenarioForEvent(fixture("pre-bash-deny.json")), "deny");
  assert.equal(scenarioForEvent(fixture("pre-apply-patch.json")), "patch-allow");
  assert.equal(scenarioForEvent(fixture("pre-apply-patch-deny.json")), "patch-deny");
  assert.equal(scenarioForEvent({ tool_input: { command: "printf unrelated" } }), "unknown");
  const patchBody = "*** Begin Patch\n*** Add File: patch-workdir.txt\n+patch workdir # codex-hook-probe:patch-workdir\n*** End Patch";
  assert.equal(scenarioForEvent({ tool_input: { command: patchBody } }), "patch-workdir");
  assert.equal(
    scenarioForEvent({ tool_input: { command: `apply_patch <<'PATCH'\n${patchBody}\nPATCH` } }),
    "patch-workdir",
  );
});

test("sanitizer retains contract shape while removing transcript and arbitrary text", () => {
  const event = fixture("post-bash-success-object.json");
  const sanitized = sanitizeEvent(event, "/tmp/codex-hook-fixture");
  const encoded = JSON.stringify(sanitized);
  assert.equal(sanitized.tool_response_type, "object");
  assert.equal((sanitized.tool_response as Record<string, unknown>).exit_code, 0);
  assert.equal((sanitized.tool_response as Record<string, unknown>).private_detail, "<redacted-string>");
  assert.doesNotMatch(encoded, /synthetic\/transcript|synthetic-session|synthetic-model|synthetic private detail/u);
  assert.match(encoded, /codex-hook-probe:success/u);
  assert.deepEqual(sanitized.top_level_field_types, {
    cwd: "string",
    hook_event_name: "string",
    model: "string",
    session_id: "string",
    tool_input: "object",
    tool_name: "string",
    tool_response: "object",
    tool_use_id: "string",
    transcript_path: "string",
    turn_id: "string",
  });
});

test("sanitizer preserves identifier relationships with domain-separated pseudonyms", () => {
  const source = fixture("post-bash-success-object.json");
  const first = sanitizeEvent(source);
  const again = sanitizeEvent({ ...source, hook_event_name: "PreToolUse" });
  const another = sanitizeEvent({ ...source, tool_use_id: "another-tool-use" });
  assert.match(String(first.session_id), /^<session:[a-f0-9]{24}>$/u);
  assert.match(String(first.tool_use_id), /^<tool-use:[a-f0-9]{24}>$/u);
  assert.equal(first.session_id, again.session_id);
  assert.equal(first.tool_use_id, again.tool_use_id);
  assert.notEqual(first.tool_use_id, another.tool_use_id);
  assert.doesNotMatch(JSON.stringify(first), /synthetic-session|synthetic-tool-use/u);
});

test("sanitizer relates event cwd to the hook process and controlled nested directory", () => {
  const root = "/tmp/codex-hook-fixture";
  const nested = join(root, "nested-cwd");
  const source = fixture("pre-bash-deny.json");
  const sanitized = sanitizeEvent({ ...source, cwd: nested }, root, nested);
  assert.equal(sanitized.cwd_matches_scratch, false);
  assert.equal(sanitized.cwd_matches_nested, true);
  assert.equal(sanitized.cwd_matches_hook_process, true);
  assert.equal(sanitized.hook_process_cwd_matches_nested, true);
});

test("sanitizer records a string tool_response without treating it as a stable schema", () => {
  const sanitized = sanitizeEvent(fixture("post-bash-nonzero-string.json"));
  assert.equal(sanitized.tool_response_type, "string");
  assert.equal(sanitized.tool_response, "nonzero");
});

test("hook mode emits the documented deny decision and writes only sanitized evidence", () => {
  const out = join(scratch, "deny-hook");
  mkdirSync(out);
  const result = runHook("pre-bash-deny.json", out);
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout) as {
    hookSpecificOutput: { hookEventName: string; permissionDecision: string };
  };
  assert.equal(decision.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(Object.hasOwn(decision.hookSpecificOutput, "updatedInput"), false);
  const evidence = readFileSync(join(out, "events.jsonl"), "utf8");
  assert.doesNotMatch(evidence, /synthetic\/transcript|synthetic-session|synthetic-model|synthetic description/u);
  assert.match(evidence, /codex-hook-probe:deny/u);
});

test("hook mode allows with an identity updatedInput preserving exact command bytes", () => {
  const out = join(scratch, "allow-hook");
  mkdirSync(out);
  const source = fixture("pre-bash-deny.json");
  const command = "printf 'success\\n' > shell-success.txt # codex-hook-probe:success";
  const result = runHookEvent({ ...source, tool_input: { command } }, out);
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout) as {
    hookSpecificOutput: {
      permissionDecision: string;
      updatedInput: { command: string };
    };
  };
  assert.equal(decision.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(decision.hookSpecificOutput.updatedInput.command, command);
});

test("prepare is scratch-only, refuses overwrite, and never invokes Codex", () => {
  const out = join(scratch, "prepared");
  const first = spawnSync(process.execPath, [SCRIPT, "prepare", "--out", out], { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const prepared = JSON.parse(first.stdout) as {
    hooks_example: string;
    prompt: string;
    log: string;
    codex_argv: string[];
  };
  assert.match(readFileSync(prepared.hooks_example, "utf8"), /PreToolUse/u);
  assert.match(readFileSync(prepared.hooks_example, "utf8"), /PostToolUse/u);
  const prompt = readFileSync(prepared.prompt, "utf8");
  assert.match(prompt, /Run exactly the eight shell commands/u);
  assert.match(prompt, /nested-cwd/u);
  assert.match(prompt, /patch-denied\.txt/u);
  assert.equal(prepared.codex_argv.includes("--dangerously-bypass-hook-trust"), false);
  assert.equal(prepared.codex_argv.some((arg) => arg.startsWith("hooks.PreToolUse=")), true);
  assert.equal(existsSync(join(out, ".codex", "hooks.json")), false);
  const second = spawnSync(process.execPath, [SCRIPT, "prepare", "--out", out], { encoding: "utf8" });
  assert.equal(second.status, 1);
  assert.match(second.stderr, /refusing non-empty/u);
});

test("patch-workdir focus prepares one exact bounded call and fails without evidence", () => {
  const out = join(scratch, "patch-workdir-focus");
  const prepare = spawnSync(
    process.execPath,
    [SCRIPT, "prepare", "--out", out, "--focus", "patch-workdir"],
    { encoding: "utf8" },
  );
  assert.equal(prepare.status, 0, prepare.stderr);
  const prepared = JSON.parse(prepare.stdout) as { prompt: string; focus: string };
  assert.equal(prepared.focus, "patch-workdir");
  const prompt = readFileSync(prepared.prompt, "utf8");
  assert.match(prompt, /Run exactly one exec_command tool call/u);
  assert.match(prompt, /apply_patch <<'PATCH'/u);
  assert.match(prompt, /workdir exactly .*nested-cwd/u);

  const verify = spawnSync(
    process.execPath,
    [SCRIPT, "verify", "--out", out, "--focus", "patch-workdir"],
    { encoding: "utf8" },
  );
  assert.equal(verify.status, 1);
  const report = JSON.parse(verify.stdout) as { ok: boolean; focus: string };
  assert.equal(report.ok, false);
  assert.equal(report.focus, "patch-workdir");
});

test("reviewed v5 native evidence keeps observed responses separate from synthetic fixtures", () => {
  const rows = readFileSync(join(FIXTURES, "native-v5.sanitized.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(rows.length, 15);
  const posts = rows.filter((row) => row["hook_event_name"] === "PostToolUse");
  const success = posts.find((row) => row["scenario"] === "success");
  const nonzero = posts.find((row) => row["scenario"] === "nonzero");
  assert.deepEqual(success?.["tool_response"], nonzero?.["tool_response"]);
  assert.equal(success?.["tool_use_id"], "<tool-use>");
});

test("reviewed v6 native evidence exposes identity while revealing the cwd binding gap", () => {
  const rows = readFileSync(join(FIXTURES, "native-v6.sanitized.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(rows.length, 18);
  const nested = rows.find(
    (row) => row["hook_event_name"] === "PreToolUse" && row["scenario"] === "nested",
  );
  assert.deepEqual(nested?.["tool_input_keys"], ["command"]);
  assert.equal(nested?.["cwd_matches_scratch"], true);
  assert.equal(nested?.["cwd_matches_nested"], false);
  assert.equal(nested?.["hook_process_cwd_matches_scratch"], true);
  assert.equal(nested?.["tool_input_cwd_type"], "missing");
  assert.equal(nested?.["tool_input_workdir_type"], "missing");

  const allowPre = rows.find(
    (row) => row["hook_event_name"] === "PreToolUse" && row["scenario"] === "allow",
  );
  const allowPost = rows.find(
    (row) => row["hook_event_name"] === "PostToolUse" && row["scenario"] === "allow",
  );
  assert.equal(allowPre?.["tool_use_id"], allowPost?.["tool_use_id"]);
  assert.match(String(allowPre?.["tool_use_id"]), /^<tool-use:[a-f0-9]{24}>$/u);
  assert.equal(
    rows.some(
      (row) => row["scenario"] === "patch-deny" && row["hook_event_name"] === "PostToolUse",
    ),
    false,
  );
});

test("reviewed v7 patch-workdir evidence remains Bash with a hidden directory", () => {
  const rows = readFileSync(
    join(FIXTURES, "native-v7-patch-workdir.sanitized.jsonl"),
    "utf8",
  ).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(rows.length, 1);
  const event = rows[0];
  assert.ok(event !== undefined);
  assert.equal(event["hook_event_name"], "PreToolUse");
  assert.equal(event["tool_name"], "Bash");
  assert.equal(event["scenario"], "patch-workdir");
  assert.deepEqual(event["tool_input_keys"], ["command"]);
  assert.equal(event["cwd_matches_scratch"], true);
  assert.equal(event["cwd_matches_nested"], false);
  assert.match(
    String((event["tool_input"] as Record<string, unknown>)["command"]),
    /^apply_patch <<'PATCH'\n\*\*\* Begin Patch/u,
  );
});

test("verify fails closed when no native evidence exists", () => {
  const out = join(scratch, "empty");
  const prepare = spawnSync(process.execPath, [SCRIPT, "prepare", "--out", out], { encoding: "utf8" });
  assert.equal(prepare.status, 0, prepare.stderr);
  const verify = spawnSync(process.execPath, [SCRIPT, "verify", "--out", out], { encoding: "utf8" });
  assert.equal(verify.status, 1);
  const report = JSON.parse(verify.stdout) as { ok: boolean; checks: Record<string, boolean> };
  assert.equal(report.ok, false);
  assert.equal(report.checks.denied_effect_absent, true);
  assert.equal(report.checks.pre_deny, false);
});
