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
  return spawnSync(
    process.execPath,
    [SCRIPT, "hook", "--log", join(out, "events.jsonl"), "--scratch", out],
    { encoding: "utf8", input: `${JSON.stringify(fixture(name))}\n` },
  );
}

test("native-shaped Bash and apply_patch inputs select only explicit probe scenarios", () => {
  assert.equal(scenarioForEvent(fixture("pre-bash-deny.json")), "deny");
  assert.equal(scenarioForEvent(fixture("pre-apply-patch.json")), "patch");
  assert.equal(scenarioForEvent({ tool_input: { command: "printf unrelated" } }), "unknown");
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
  const evidence = readFileSync(join(out, "events.jsonl"), "utf8");
  assert.doesNotMatch(evidence, /synthetic\/transcript|synthetic-session|synthetic-model|synthetic description/u);
  assert.match(evidence, /codex-hook-probe:deny/u);
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
  assert.match(readFileSync(prepared.prompt, "utf8"), /Run exactly the seven shell commands/u);
  assert.equal(prepared.codex_argv.includes("--dangerously-bypass-hook-trust"), false);
  assert.equal(prepared.codex_argv.some((arg) => arg.startsWith("hooks.PreToolUse=")), true);
  assert.equal(existsSync(join(out, ".codex", "hooks.json")), false);
  const second = spawnSync(process.execPath, [SCRIPT, "prepare", "--out", out], { encoding: "utf8" });
  assert.equal(second.status, 1);
  assert.match(second.stderr, /refusing non-empty/u);
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
