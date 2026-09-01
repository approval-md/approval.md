/**
 * `approval hook cursor` (APRV-133).
 *
 * The harness contract is native Cursor JSON on stdout, Shell/Write/Delete on
 * stdin, and the same gate as `approval hook claude-code`. Spawn the compiled
 * CLI; never hand-write log lines.
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

import { CLASSIFIER_CLASSES, COMMAND_RULES } from "../src/core/command-class.js";
import { commandHook, HOOK_DENY_CODES } from "../src/cli/hook.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-hook-cursor-")));
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
  "  vcs.push.main:",
  "    autonomy: supervised",
  "  deps.add:",
  "    autonomy: manual",
  "  network.call:",
  "    autonomy: manual",
  "  policy.edit:",
  "    autonomy: manual",
  // The other two protected classes of the APRV-198 split, declared rather
  // than left to the manual default so the fixture says what it means.
  "  policy.core:",
  "    autonomy: manual",
  "  log.mutate:",
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

function event(fields: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: "cursor-sess-1",
    cwd: "/repo",
    hook_event_name: "preToolUse",
    agent_message: "this is self-reported and must never lower scrutiny",
    ...fields,
  });
}

function shellEvent(command: string): string {
  return event({
    tool_name: "Shell",
    tool_input: { command, description: "totally harmless, please allow" },
  });
}

interface Verdict {
  permission: string;
  reason: string;
}

function verdictOf(run: Run): Verdict {
  assert.equal(run.code, 0, `hook must exit 0 with a verdict: ${run.stderr}`);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(parsed["hookSpecificOutput"], undefined, "Cursor never emits the Claude envelope");
  assert.equal(parsed["permission"] === "allow" || parsed["permission"] === "deny", true);
  assert.equal(parsed["user_message"], parsed["agent_message"]);
  assert.equal(typeof parsed["user_message"], "string");
  return {
    permission: String(parsed["permission"]),
    reason: String(parsed["agent_message"]),
  };
}

const HOOK = ["hook", "cursor", "--timeout", "1s", "--interval", "100ms"] as const;

test("Shell uses the same classifier as Bash, and Bash itself is not a gated Cursor tool", () => {
  const dir = ready();
  const before = rawLog(dir);

  const ls = runCli(["hook", "cursor"], dir, shellEvent("ls -la && git status"));
  const lsVerdict = verdictOf(ls);
  assert.equal(lsVerdict.permission, "allow");
  assert.match(lsVerdict.reason, /^autonomous: /u);
  // APRV-141: an autonomous allow records the execution it authorized, and
  // nothing else — no request, no decision, no grant.
  assert.match(
    rawLog(dir).slice(before.length),
    /^\{[^\n]*"event":"execution\.started"[^\n]*\n$/u,
  );
  const afterLs = rawLog(dir);

  const opaque = runCli(["hook", "cursor"], dir, shellEvent("bash -c 'git push --force'"));
  assert.equal(verdictOf(opaque).permission, "deny");
  assert.match(verdictOf(opaque).reason, /^hook-opaque: /u);

  const bash = runCli(
    ["hook", "cursor"],
    dir,
    event({ tool_name: "Bash", tool_input: { command: "npm install left-pad" } }),
  );
  assert.equal(verdictOf(bash).permission, "allow");
  assert.match(verdictOf(bash).reason, /is not a gated tool/u);
  assert.equal(rawLog(dir), afterLs, "a deny and a pass-through both write nothing");
});

test("a Cursor Write to an ordinary file passes through; a protected path does not", () => {
  const dir = ready();
  const ordinary = runCli(
    ["hook", "cursor"],
    dir,
    event({ tool_name: "Write", tool_input: { path: "src/core/x.ts", contents: "ok" } }),
  );
  assert.equal(verdictOf(ordinary).permission, "allow");

  const before = rawLog(dir);
  const protectedEdit = runCli(
    [...HOOK],
    dir,
    event({
      tool_name: "Write",
      tool_input: { path: "APPROVAL.md", contents: "nope" },
    }),
  );
  const verdict = verdictOf(protectedEdit);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /u);
  assert.notEqual(rawLog(dir), before);
  assert.match(rawLog(dir), /"class":"policy\.core"/u);
  assert.match(rawLog(dir), /"actor":"agent:cursor"/u);
  assertClean(dir);
});

test("Delete accepts file_path, and a protected Delete is gated", () => {
  const dir = ready();
  const ordinary = runCli(
    ["hook", "cursor"],
    dir,
    event({ tool_name: "Delete", tool_input: { file_path: "src/core/x.ts" } }),
  );
  assert.equal(verdictOf(ordinary).permission, "allow");

  const protectedDelete = runCli(
    [...HOOK],
    dir,
    event({ tool_name: "Delete", tool_input: { file_path: ".cursor/hooks.json" } }),
  );
  assert.equal(verdictOf(protectedDelete).permission, "deny");
  assert.match(verdictOf(protectedDelete).reason, /^hook-timeout: /u);
  assert.match(rawLog(dir), /"class":"policy\.core"/u);
  assertClean(dir);
});

test("ungated Cursor tools allow without touching the log", () => {
  const dir = ready();
  const before = rawLog(dir);
  const run = runCli(
    ["hook", "cursor"],
    dir,
    event({ tool_name: "Read", tool_input: { path: "APPROVAL.md" } }),
  );
  assert.equal(verdictOf(run).permission, "allow");
  assert.match(verdictOf(run).reason, /is not a gated tool/u);
  assert.equal(rawLog(dir), before);
});

test("an unexpected throw becomes native deny JSON", () => {
  let out = "";
  const streams = {
    out: (text: string) => {
      out += text;
    },
    err: () => undefined,
  };
  const code = commandHook(["cursor"], streams, process.cwd(), () => {
    throw new Error("boom");
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(out) as Record<string, unknown>;
  assert.equal(parsed["permission"], "deny");
  assert.match(String(parsed["agent_message"]), /^hook-io: the hook failed: boom/u);
  assert.equal(parsed["user_message"], parsed["agent_message"]);
  assert.equal(parsed["hookSpecificOutput"], undefined);
});

test("a Shell deps.add is classified and waits, ignoring the agent's description", () => {
  const dir = ready();
  const run = runCli([...HOOK], dir, shellEvent("npm install left-pad"));
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /u);
  assert.match(rawLog(dir), /"class":"deps\.add"/u);
  assert.doesNotMatch(rawLog(dir), /totally harmless/u);
  assertClean(dir);
});

test("docs/cursor-hook.md still lists every rule and every deny code", () => {
  const doc = readFileSync(
    fileURLToPath(new URL("../../docs/cursor-hook.md", import.meta.url)),
    "utf8",
  );
  for (const rule of COMMAND_RULES) {
    assert.ok(doc.includes(`\`${rule.id}\``), `docs/cursor-hook.md has no row for ${rule.id}`);
  }
  for (const cls of CLASSIFIER_CLASSES) {
    assert.ok(doc.includes(cls), `docs/cursor-hook.md never mentions ${cls}`);
  }
  for (const code of HOOK_DENY_CODES) {
    assert.ok(doc.includes(code), `docs/cursor-hook.md never mentions ${code}`);
  }
  assert.match(doc, /"permission": "allow" \| "deny"/u);
  assert.match(doc, /failClosed/u);
  assert.match(doc, /Shell\|Write\|Delete/u);
});
