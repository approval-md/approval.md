/**
 * `approval hook claude-code`: the opt-in `defaults.unclassified_command:
 * abstain` key.
 *
 * Absent (or `deny`), a Bash command no built-in rule covers is denied
 * `hook-unclassified`, as every earlier build did. Under an ATTESTED policy
 * declaring `abstain`, the same command gets no verdict at all: empty stdout,
 * exit 0, nothing appended, so Claude Code's own permission flow decides it.
 * Only the no-rule case abstains: `opaque` and `unparseable` stay denied, a
 * command whose other segments are not all autonomous keeps today's deny, and
 * every other harness keeps today's deny.
 *
 * Spawn the compiled CLI; never hand-write log lines. Every path is absolute.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { abstainPolicyRefusal } from "../src/cli/hook.js";
import { loadPolicyText } from "../src/core/policy-load.js";
import { readVerifiedRecords } from "../src/core/state.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-abstain-")));
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
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
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

function policy(key: string | null, top: readonly string[] = [], classes: readonly string[] = []): string {
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    '  approval_ttl: "1h"',
    "  on_expiry: reject",
    ...(key === null ? [] : [`  unclassified_command: ${key}`]),
    ...top,
    "classes:",
    "  read.*:",
    "    autonomy: autonomous",
    "  release.publish:",
    "    autonomy: human-only",
    ...classes,
    "```",
    "",
  ].join("\n");
}

function logPath(dir: string): string {
  return join(dir, ".approval", "log", "events.jsonl");
}

function ready(text: string, attest = true): string {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), text, "utf8");
  if (attest) {
    const attested = runCli(
      ["policy", "attest", "--dir", dir, "--log", logPath(dir), "--as", "human:alice"],
      dir,
    );
    assert.equal(attested.code, 0, attested.stderr);
  } else {
    mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  }
  return dir;
}

function rawLog(dir: string): string {
  return existsSync(logPath(dir)) ? readFileSync(logPath(dir), "utf8") : "";
}

function starts(dir: string): number {
  return rawLog(dir)
    .split("\n")
    .filter((line) => line.includes('"event":"execution.started"')).length;
}

function claude(dir: string, command: string, id: string): Run {
  const event = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "cc-sess-abstain",
    tool_use_id: id,
    cwd: dir,
    tool_name: "Bash",
    tool_input: { command },
  });
  return runCli(["hook", "claude-code", "--as", "agent:cc", "--dir", dir], dir, event);
}

function verdict(run: Run): { permission: string; reason: string } {
  assert.equal(run.code, 0, run.stderr);
  const parsed = JSON.parse(run.stdout) as { hookSpecificOutput?: Record<string, unknown> };
  const out = parsed.hookSpecificOutput ?? {};
  return { permission: String(out["permissionDecision"]), reason: String(out["permissionDecisionReason"]) };
}

/** No verdict: nothing on stdout or stderr, exit 0, and the log byte for byte as it was. */
function assertAbstained(dir: string, run: Run, before: string): void {
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, "", "an abstain prints nothing");
  assert.equal(run.stderr, "");
  assert.equal(rawLog(dir).length, before.length, "nothing was appended");
  assert.equal(rawLog(dir), before);
}

const UNCLASSIFIED = "railway variable set FOO=bar";

test("(a) without the key an unclassified Bash command is denied hook-unclassified, unchanged", () => {
  for (const key of [null, "deny"]) {
    const dir = ready(policy(key));
    const before = rawLog(dir);
    const v = verdict(claude(dir, UNCLASSIFIED, `t-a-${String(key)}`));
    assert.equal(v.permission, "deny");
    assert.match(v.reason, /^hook-unclassified: no rule for railway variable \(segment: railway variable set FOO=bar\)/u);
    assert.equal(rawLog(dir), before);
  }
});

test("(b) under an attested abstain policy an unclassified Bash command gets no verdict and appends nothing", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  assertAbstained(dir, claude(dir, UNCLASSIFIED, "t-b"), before);
});

test("(b2) a cd prefix and a read segment still abstain: every other segment is autonomous", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  assertAbstained(dir, claude(dir, `cd ${dir} && ${UNCLASSIFIED}`, "t-b2-cd"), before);
  assertAbstained(dir, claude(dir, `git status && ${UNCLASSIFIED}`, "t-b2-git"), before);
});

test("(c) under abstain an opaque command is still denied", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  const v = verdict(claude(dir, "timeout 60 echo x", "t-c"));
  assert.equal(v.permission, "deny");
  assert.match(v.reason, /^hook-opaque: /u);
  // An opaque segment AFTER an unclassified one is still read, and still denies.
  const mixed = verdict(claude(dir, `${UNCLASSIFIED} && timeout 60 echo x`, "t-c-mixed"));
  assert.equal(mixed.permission, "deny");
  assert.match(mixed.reason, /^hook-opaque: /u);
  // A substitution running an unclassified command taints the segment as before.
  const substituted = verdict(claude(dir, "echo $(railway variables)", "t-c-subst"));
  assert.equal(substituted.permission, "deny");
  assert.equal(rawLog(dir), before);
});

test("(d) under abstain a built-in autonomous class is allowed as before, with one execution.started", () => {
  const dir = ready(policy("abstain"));
  const v = verdict(claude(dir, "echo hello", "t-d"));
  assert.equal(v.permission, "allow");
  assert.equal(v.reason, "autonomous: read.shell");
  assert.equal(starts(dir), 1);
});

test("(e) under abstain a human-only class is denied as before, alone or beside an unclassified segment", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  const v = verdict(claude(dir, "npm publish", "t-e"));
  assert.equal(v.permission, "deny");
  assert.match(v.reason, /^hook-class-human-only: /u);
  // The unclassified segment does not hand the human-only one to the harness.
  for (const command of [`${UNCLASSIFIED} && npm publish`, `npm publish; ${UNCLASSIFIED}`]) {
    const mixed = verdict(claude(dir, command, `t-e-${String(command.length)}`));
    assert.equal(mixed.permission, "deny", command);
    assert.match(mixed.reason, /^hook-unclassified: no rule for railway variable/u, command);
  }
  // Nor a class that would wait for a human (deps.add resolves manual here).
  const manual = verdict(claude(dir, `${UNCLASSIFIED} && npm install left-pad`, "t-e-manual"));
  assert.equal(manual.permission, "deny");
  assert.match(manual.reason, /^hook-unclassified: /u);
  assert.equal(rawLog(dir), before);
});

test("(f) the schema admits deny and abstain and rejects any other value", () => {
  assert.equal(loadPolicyText("APPROVAL.md", policy("abstain")).ok, true);
  assert.equal(loadPolicyText("APPROVAL.md", policy("deny")).ok, true);
  for (const value of ["allow", "ask", "Abstain", "true"]) {
    const loaded = loadPolicyText("APPROVAL.md", policy(value));
    assert.equal(loaded.ok, false, value);
  }
  const dir = ready(policy("allow"), false);
  const v = verdict(claude(dir, UNCLASSIFIED, "t-f"));
  assert.equal(v.permission, "deny");
  assert.match(v.reason, /^hook-policy-unavailable: /u);
});

test("(g) the key cannot slip past attestation: an unattested policy carrying it is refused policy-not-attested", () => {
  // Attested WITHOUT the key, then the key is added on disk and nobody attests.
  const dir = ready(policy(null));
  writeFileSync(join(dir, "APPROVAL.md"), policy("abstain"), "utf8");
  const before = rawLog(dir);
  const v = verdict(claude(dir, UNCLASSIFIED, "t-g-edit"));
  assert.equal(v.permission, "deny");
  assert.match(v.reason, /^hook-gate-refused:policy-not-attested: /u);
  assert.equal(rawLog(dir), before);

  // A policy that was never attested at all.
  const never = ready(policy("abstain"), false);
  const n = verdict(claude(never, UNCLASSIFIED, "t-g-never"));
  assert.equal(n.permission, "deny");
  assert.match(n.reason, /^hook-gate-refused:policy-not-attested: /u);

  // Re-attesting the edit is what puts it in force.
  const attested = runCli(
    ["policy", "attest", "--dir", dir, "--log", logPath(dir), "--as", "human:alice"],
    dir,
  );
  assert.equal(attested.code, 0, attested.stderr);
  const afterAttest = rawLog(dir);
  assertAbstained(dir, claude(dir, UNCLASSIFIED, "t-g-after"), afterAttest);
});

test("(h) another harness keeps today's deny under an abstain policy", () => {
  const dir = ready(policy("abstain"));
  const event = JSON.stringify({
    hookEventName: "PreToolUse",
    sessionId: "grok-sess-abstain",
    cwd: dir,
    workspaceRoot: dir,
    toolName: "Bash",
    toolInput: { command: UNCLASSIFIED },
  });
  const run = runCli(["hook", "grok", "--dir", dir], dir, event);
  assert.equal(run.code, 2);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(parsed["decision"], "deny");
  assert.match(String(parsed["reason"]), /^hook-unclassified: /u);
});

test("(i) hook classify is unchanged by the key: it still reports unclassified", () => {
  const dir = ready(policy("abstain"));
  const run = runCli(["hook", "classify", "--json", "--dir", dir, "--", UNCLASSIFIED], dir);
  assert.equal(run.code, 0, run.stderr);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(parsed["ok"], false);
  assert.equal(parsed["code"], "unclassified");
});

function claudePost(dir: string, command: string, id: string): Run {
  const event = JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "cc-sess-abstain",
    tool_use_id: id,
    cwd: dir,
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { stdout: "", stderr: "", interrupted: false, isImage: false },
  });
  return runCli(["hook", "claude-code", "--as", "agent:cc", "--dir", dir], dir, event);
}

test("(j) the PostToolUse half of an abstained call is silent: exit 0, nothing printed, nothing appended", () => {
  const dir = ready(policy("abstain"));
  const before = rawLog(dir);
  assertAbstained(dir, claude(dir, UNCLASSIFIED, "t-j"), before);
  assertAbstained(dir, claudePost(dir, UNCLASSIFIED, "t-j"), before);

  // Without the key nothing ran, and a report for it still says no start was written (exit 2, shown).
  const plain = ready(policy(null));
  const run = claudePost(plain, UNCLASSIFIED, "t-j-plain");
  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /post-tool-gate-refused:not-delegated/u);

  // Under the key, a gated call's missing start is still reported: only an abstained command is silent.
  const gated = claudePost(dir, "echo hello", "t-j-gated");
  assert.equal(gated.code, 2);
  assert.match(gated.stderr, /post-tool-gate-refused:not-delegated/u);
  assert.equal(rawLog(dir), before);
});

/** The rule: abstain ONLY when every segment other than the no-rule one(s) is a read (`read`, `read.*`). */
test("(k) a no-rule segment beside a side-effecting segment keeps today's deny, even when that segment is autonomous", () => {
  const dir = ready(policy("abstain", [], ["  vcs.push.branch:", "    autonomy: autonomous", "  vcs.commit.branch:", "    autonomy: autonomous"]));
  const before = rawLog(dir);
  for (const command of [
    `git push origin feature-x && ${UNCLASSIFIED}`,
    `${UNCLASSIFIED}; git push origin feature-x`,
    `git commit -m wip && ${UNCLASSIFIED}`,
  ]) {
    const v = verdict(claude(dir, command, `t-k-${String(command.length)}`));
    assert.equal(v.permission, "deny", command);
    assert.match(v.reason, /^hook-unclassified: no rule for railway variable/u, command);
  }
  // Alone, the autonomous push is still allowed and recorded as before.
  assert.equal(verdict(claude(dir, "git push origin feature-x", "t-k-alone")).permission, "allow");
  assert.equal(starts(dir), 1);
  assert.notEqual(rawLog(dir), before);
});

test("(l) a no-rule segment that names a protected path or a credential keeps the refusal", () => {
  // The protected and credential families human-only, so a refusal is immediate rather than a wait.
  const dir = ready(policy("abstain", [], ["  policy.*:", "    autonomy: human-only", "  log.*:", "    autonomy: human-only", "  account.*:", "    autonomy: human-only"]));
  const before = rawLog(dir);
  for (const command of [
    `${UNCLASSIFIED} > APPROVAL.md`,
    "railway up APPROVAL.md",
    "railway up --config=.approval/log/events.jsonl",
    "railway up .approval/env",
  ]) {
    const run = claude(dir, command, `t-l-${String(command.length)}`);
    assert.notEqual(run.stdout, "", `${command} must not abstain`);
    assert.equal(verdict(run).permission, "deny", command);
  }
  assert.equal(rawLog(dir), before);
});

test("(m) an exec.code segment beside a no-rule segment keeps the deny", () => {
  const dir = ready(policy("abstain", ["exec:", "  code:", "    custody: attested"], ["  exec.code:", "    autonomy: autonomous"]));
  const before = rawLog(dir);
  const v = verdict(claude(dir, `python3 -c 'print(1)' && ${UNCLASSIFIED}`, "t-m"));
  assert.equal(v.permission, "deny");
  assert.match(v.reason, /^hook-unclassified: /u);
  assert.equal(rawLog(dir), before);
});

test("(n) the abstain is believed only of the bytes attested: an edit between the two reads refuses", () => {
  const dir = ready(policy("abstain"));
  const path = join(dir, "APPROVAL.md");
  const attestedText = policy("abstain");
  const loaded = loadPolicyText(path, attestedText);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const read = readVerifiedRecords(logPath(dir));
  assert.equal(read.ok, true);
  if (!read.ok) return;
  // The same bytes: no refusal.
  assert.equal(abstainPolicyRefusal(loaded, { path, bytes: Buffer.from(attestedText, "utf8") }, read.records), null);
  // The decision was made on the attested policy, the file read for the attestation is an edit.
  const edited = policy("abstain", [], ["  vcs.*:", "    autonomy: autonomous"]);
  const swapped = abstainPolicyRefusal(loaded, { path, bytes: Buffer.from(edited, "utf8") }, read.records);
  assert.notEqual(swapped, null);
  // The decision was made on an edit, the bytes read back are the attested ones.
  const loadedEdit = loadPolicyText(path, edited);
  assert.equal(loadedEdit.ok, true);
  if (!loadedEdit.ok) return;
  const back = abstainPolicyRefusal(loadedEdit, { path, bytes: Buffer.from(attestedText, "utf8") }, read.records);
  assert.notEqual(back, null);
  // No file at all to read back.
  assert.notEqual(abstainPolicyRefusal(loaded, null, read.records), null);
});
