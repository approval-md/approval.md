/**
 * `approval hook`: the policy's tool-name mapping and unmapped-tool default
 * (APRV-499).
 *
 * A call the adapter's own tables leave unclaimed (every MCP tool among them)
 * used to be answered "not a gated tool" with no record. These cases pin what
 * the policy now decides about it, on Claude Code and on Hermes:
 *
 * - an exact entry and a glob entry, first match wins;
 * - the adapter's own tables keep precedence over every entry;
 * - `defaults.unmapped_tool: record` records, `ask` asks, absent changes nothing;
 * - a policy whose mapping does not load fails closed for an unclaimed call.
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

import { commandGate } from "../src/cli/gate-window.js";
import type { Streams } from "../src/cli/main.js";
import type { Prompter, SecretRead } from "../src/cli/prompt.js";
import { startExecution } from "../src/core/execute.js";
import { propose, register, request, startHarnessExecution } from "../src/core/gate.js";
import { appendEvent } from "../src/core/log.js";
import { payloadHash } from "../src/core/payload.js";
import { consumeToken, mintToken, tokenHash } from "../src/core/token.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-tool-map-")));
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
  delete childEnv["HERMES_HOME"];
  delete childEnv["APPROVAL_HERMES_HOME"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
    input,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

const HEAD = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
];

const CLASSES = [
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  files.write.workspace:",
  "    autonomy: autonomous",
  "  exec.local:",
  "    autonomy: autonomous",
  "  marketplace.*:",
  "    autonomy: manual",
  "  marketplace.app.read:",
  "    autonomy: autonomous",
  "  marketplace.contextsling.publish:",
  "    autonomy: human-only",
  "  cron.manage:",
  "    autonomy: human-only",
  "  message.send:",
  "    autonomy: human-only",
];

const TOOLS = [
  "tools:",
  "  - match: mcp__contextsling__publish",
  "    class: marketplace.contextsling.publish",
  '  - match: "mcp__contextsling__*"',
  "    class: marketplace.app.read",
  "  - match: mcp_zzz_post",
  "    class: marketplace.contextsling.publish",
];

function policy(defaultsExtra: string[], rest: string[]): string {
  return [...HEAD, ...defaultsExtra, ...rest, "```", ""].join("\n");
}

function ready(text: string, attest = true): string {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), text, "utf8");
  if (attest) {
    const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
    assert.equal(attested.code, 0, attested.stderr);
  } else {
    mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  }
  return dir;
}

function logRecords(dir: string): Record<string, unknown>[] {
  const path = join(dir, ".approval", "log", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function claude(dir: string, tool: string, input: Record<string, unknown>, id: string, extra: string[] = []): Run {
  const event = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "cc-sess-tools",
    tool_use_id: id,
    cwd: dir,
    tool_name: tool,
    tool_input: input,
  });
  return runCli(["hook", "claude-code", "--as", "agent:cc", "--dir", dir, ...extra], dir, event);
}

function claudePost(dir: string, tool: string, input: Record<string, unknown>, id: string): Run {
  const event = JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "cc-sess-tools",
    tool_use_id: id,
    cwd: dir,
    tool_name: tool,
    tool_input: input,
    tool_response: { ok: true },
  });
  return runCli(["hook", "claude-code", "--as", "agent:cc", "--dir", dir], dir, event);
}

function claudeVerdict(run: Run): { permission: string; reason: string } {
  assert.equal(run.code, 0, run.stderr);
  const parsed = JSON.parse(run.stdout) as { hookSpecificOutput?: Record<string, unknown> };
  const out = parsed.hookSpecificOutput ?? {};
  return { permission: String(out["permissionDecision"]), reason: String(out["permissionDecisionReason"]) };
}

function hermes(dir: string, tool: string, input: Record<string, unknown>, id: string): Run {
  const event = JSON.stringify({
    hook_event_name: "pre_tool_call",
    session_id: "hermes-sess-tools",
    tool_use_id: id,
    cwd: dir,
    profile: "default",
    extra: {},
    tool_name: tool,
    tool_input: input,
  });
  return runCli(["hook", "hermes", "--as", "agent:hermes", "--dir", dir], dir, event);
}

/** Hermes's one dialect: `{}` at 0 is the allow, `{action:"block", message}` at 2 the deny. */
function hermesVerdict(run: Run): { permission: string; message: string } {
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  if (Object.keys(parsed).length === 0) {
    assert.equal(run.code, 0, run.stderr);
    return { permission: "allow", message: run.stderr };
  }
  assert.equal(parsed["action"], "block", run.stdout);
  assert.equal(run.code, 2);
  return { permission: "deny", message: String(parsed["message"]) };
}

function starts(dir: string): Record<string, unknown>[] {
  return logRecords(dir).filter((record) => record["event"] === "execution.started");
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

test("an exact entry maps an MCP tool to its class: a human-only class refuses the call", () => {
  const dir = ready(policy([], [...CLASSES, ...TOOLS]));
  const before = logRecords(dir).length;
  const verdict = claudeVerdict(claude(dir, "mcp__contextsling__publish", { text: "hello" }, "t-exact"));
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-class-human-only: class marketplace\.contextsling\.publish /);
  assert.equal(logRecords(dir).length, before, "a human-only refusal appends nothing");
});

test("a glob entry maps every tool of a server; an autonomous class records the start with the tool name", () => {
  const dir = ready(policy([], [...CLASSES, ...TOOLS]));
  const input = { query: "agents" };
  const verdict = claudeVerdict(claude(dir, "mcp__contextsling__search", input, "t-glob"));
  assert.equal(verdict.permission, "allow");
  assert.match(verdict.reason, /^autonomous: marketplace\.app\.read /);
  assert.match(verdict.reason, /tools entry 1 \("mcp__contextsling__\*"\)/);
  const [start] = starts(dir);
  assert.ok(start !== undefined, "no execution.started was appended");
  const payload = start["payload"] as Record<string, unknown>;
  assert.equal(payload["class"], "marketplace.app.read");
  assert.equal(payload["harness_tool"], "mcp__contextsling__search");
  assert.equal(payload["payload_hash"], payloadHash({ tool: "mcp__contextsling__search", input }));
  assert.equal(start["action_key"], "hook:cc-sess-tools:t-glob:marketplace.app.read");
  // The arguments are bound by hash and never written to the log.
  assert.equal(JSON.stringify(start).includes("agents"), false);
});

test("the first matching entry decides: the exact publish line wins over the server glob after it", () => {
  const dir = ready(policy([], [...CLASSES, ...TOOLS]));
  assert.equal(claudeVerdict(claude(dir, "mcp__contextsling__publish", {}, "t-first-a")).permission, "deny");
  assert.equal(claudeVerdict(claude(dir, "mcp__contextsling__list", {}, "t-first-b")).permission, "allow");
});

test("the post-execution half closes a mapped tool's start", () => {
  const dir = ready(policy([], [...CLASSES, ...TOOLS]));
  const input = { query: "x" };
  assert.equal(claudeVerdict(claude(dir, "mcp__contextsling__search", input, "t-post")).permission, "allow");
  const post = claudePost(dir, "mcp__contextsling__search", input, "t-post");
  assert.equal(post.stdout, "", "the post half prints no verdict");
  const completed = logRecords(dir).filter((record) => record["event"] === "execution.completed");
  assert.equal(completed.length, 1, post.stderr);
  assert.equal(completed[0]?.["task"], "hook:cc-sess-tools:t-post");
});

test("an entry cannot reclassify the harness's own shell, file or read tools", () => {
  const dir = ready(
    policy([], [...CLASSES, "tools:", '  - match: "*"', "    class: marketplace.contextsling.publish"]),
  );
  // `*` would map these to a human-only class; the adapter's tables answer first.
  const shell = claudeVerdict(claude(dir, "Bash", { command: "ls" }, "t-bash"));
  assert.equal(shell.permission, "allow", shell.reason);
  assert.doesNotMatch(shell.reason, /marketplace/);
  const write = claudeVerdict(claude(dir, "Write", { file_path: join(dir, "a.txt"), content: "x" }, "t-write"));
  assert.equal(write.permission, "allow", write.reason);
  assert.doesNotMatch(write.reason, /marketplace/);
  const read = claudeVerdict(claude(dir, "Read", { file_path: join(dir, "APPROVAL.md") }, "t-read"));
  assert.equal(read.permission, "allow", read.reason);
  // And the catch-all does claim everything else.
  const other = claudeVerdict(claude(dir, "WebFetch", { url: "https://example.com" }, "t-other"));
  assert.equal(other.permission, "deny");
  assert.match(other.reason, /marketplace\.contextsling\.publish/);
});

test("on Hermes the hard-coded rule table keeps precedence over a tools entry naming the same tool", () => {
  const dir = ready(
    policy(
      [],
      [
        ...CLASSES,
        "tools:",
        "  - match: cronjob_manage",
        "    class: marketplace.app.read",
        '  - match: "send_*"',
        "    class: marketplace.app.read",
      ],
    ),
  );
  // marketplace.app.read is autonomous; the rule table's cron.manage and
  // message.send are human-only, and those are what the calls are judged under.
  const cron = hermesVerdict(hermes(dir, "cronjob_manage", { action: "create", script: "job.sh" }, "h-cron"));
  assert.equal(cron.permission, "deny");
  assert.match(cron.message, /class cron\.manage /);
  const send = hermesVerdict(hermes(dir, "send_message", { text: "hi" }, "h-send"));
  assert.equal(send.permission, "deny");
  assert.match(send.message, /class message\.send /);
  // A read the table answers stays a read, whatever an entry says.
  const list = hermesVerdict(hermes(dir, "cronjob_manage", { action: "list" }, "h-list"));
  assert.equal(list.permission, "allow");
});

test("on Hermes an MCP tool the table does not know is answered by the mapping", () => {
  const dir = ready(policy([], [...CLASSES, ...TOOLS]));
  const verdict = hermesVerdict(hermes(dir, "mcp_zzz_post", { body: "x" }, "h-mcp"));
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.message, /class marketplace\.contextsling\.publish /);
});

// ---------------------------------------------------------------------------
// Unmapped
// ---------------------------------------------------------------------------

test("with no unmapped-tool key an unmapped tool is not a gated tool and leaves no record", () => {
  const dir = ready(policy([], [...CLASSES, ...TOOLS]));
  const before = logRecords(dir).length;
  const verdict = claudeVerdict(claude(dir, "TodoWrite", { todos: [] }, "t-absent"));
  assert.equal(verdict.permission, "allow");
  assert.equal(verdict.reason, "TodoWrite is not a gated tool");
  const post = claudePost(dir, "TodoWrite", { todos: [] }, "t-absent");
  assert.match(post.stderr, /post-tool-not-gated/);
  assert.equal(logRecords(dir).length, before);
  // Hermes: the same.
  const hermesRun = hermesVerdict(hermes(dir, "todo", { items: [] }, "h-absent"));
  assert.equal(hermesRun.permission, "allow");
  assert.match(hermesRun.message, /todo is not a gated tool/);
  assert.equal(logRecords(dir).length, before);
});

test("unmapped_tool: record allows an unmapped tool and records a start under harness.tool.unmapped", () => {
  const dir = ready(policy(["  unmapped_tool: record"], [...CLASSES, ...TOOLS]));
  const input = { todos: [{ content: "secret-ish text" }] };
  const verdict = claudeVerdict(claude(dir, "TodoWrite", input, "t-record"));
  assert.equal(verdict.permission, "allow");
  assert.match(verdict.reason, /^autonomous: harness\.tool\.unmapped /);
  assert.match(verdict.reason, /defaults\.unmapped_tool: record/);
  const [start] = starts(dir);
  assert.ok(start !== undefined);
  const payload = start["payload"] as Record<string, unknown>;
  assert.equal(payload["class"], "harness.tool.unmapped");
  assert.equal(payload["harness_tool"], "TodoWrite");
  assert.equal(payload["payload_hash"], payloadHash({ tool: "TodoWrite", input }));
  assert.equal(JSON.stringify(logRecords(dir)).includes("secret-ish"), false);
  // The post half closes it.
  claudePost(dir, "TodoWrite", input, "t-record");
  assert.equal(logRecords(dir).filter((record) => record["event"] === "execution.completed").length, 1);
  // A mapped tool still takes its own class, not the unmapped one.
  claudeVerdict(claude(dir, "mcp__contextsling__list", {}, "t-record-mapped"));
  const classes = starts(dir).map((record) => (record["payload"] as Record<string, unknown>)["class"]);
  assert.deepEqual(classes, ["harness.tool.unmapped", "marketplace.app.read"]);
});

test("unmapped_tool: record on Hermes allows with {} and records the tool name", () => {
  const dir = ready(policy(["  unmapped_tool: record"], [...CLASSES]));
  const verdict = hermesVerdict(hermes(dir, "web_search", { query: "x" }, "h-record"));
  assert.equal(verdict.permission, "allow");
  const [start] = starts(dir);
  assert.ok(start !== undefined, "no execution.started was appended");
  assert.equal((start["payload"] as Record<string, unknown>)["harness_tool"], "web_search");
});

test("unmapped_tool: ask gates an unmapped tool as manual under harness.tool.unmapped", () => {
  const dir = ready(policy(["  unmapped_tool: ask"], [...CLASSES, ...TOOLS]));
  const run = claude(dir, "TodoWrite", { todos: [] }, "t-ask", ["--timeout", "50ms"]);
  const verdict = claudeVerdict(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /);
  const requested = logRecords(dir).filter((record) => record["event"] === "approval.requested");
  assert.equal(requested.length, 1);
  const [request] = requested;
  assert.ok(request !== undefined);
  assert.equal(request["action_key"], "hook:cc-sess-tools:t-ask:harness.tool.unmapped");
  assert.equal((request["payload"] as Record<string, unknown>)["class"], "harness.tool.unmapped");
  assert.equal(starts(dir).length, 0);
});

test("a classes line for harness.tool.unmapped decides over the unmapped-tool default", () => {
  const dir = ready(
    policy(
      ["  unmapped_tool: record"],
      [...CLASSES, "  harness.tool.unmapped:", "    autonomy: human-only"],
    ),
  );
  const verdict = claudeVerdict(claude(dir, "TodoWrite", {}, "t-rule"));
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-class-human-only: class harness\.tool\.unmapped /);
});

// ---------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------

test("a tools entry naming an undeclared class fails the policy closed: an unclaimed call is refused", () => {
  const dir = ready(
    policy([], [...CLASSES, "tools:", "  - match: mcp__zzz__post", "    class: communicate.zzz.post"]),
    false,
  );
  const mapped = claudeVerdict(claude(dir, "mcp__zzz__post", {}, "t-undeclared-a"));
  assert.equal(mapped.permission, "deny");
  assert.match(mapped.reason, /^hook-policy-unavailable: schema-invalid: /);
  // An unrelated unclaimed tool is refused too: the mapping cannot be read, so
  // it is not evidence that this tool is unmapped.
  const other = claudeVerdict(claude(dir, "TodoWrite", {}, "t-undeclared-b"));
  assert.equal(other.permission, "deny");
  assert.match(other.reason, /^hook-policy-unavailable: /);
});

test("a malformed glob fails the policy closed", () => {
  const dir = ready(
    policy([], [...CLASSES, "tools:", '  - match: "mcp__**"', "    class: marketplace.app.read"]),
    false,
  );
  const verdict = claudeVerdict(claude(dir, "mcp__anything", {}, "t-glob-bad"));
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-policy-unavailable: schema-invalid: /);
});

// ---------------------------------------------------------------------------
// Fix round 1 (APRV-499 refutation A10)
// ---------------------------------------------------------------------------

function rewrite(dir: string, text: string): void {
  writeFileSync(join(dir, "APPROVAL.md"), text, "utf8");
}

function attest(dir: string): void {
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
}

function claudeFailedPost(dir: string, tool: string, input: Record<string, unknown>, id: string): Run {
  const event = JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "cc-sess-tools",
    tool_use_id: id,
    cwd: dir,
    tool_name: tool,
    tool_input: input,
    tool_response: { type: "error", error: "it did not work" },
  });
  return runCli(["hook", "claude-code", "--as", "agent:cc", "--dir", dir], dir, event);
}

/** Open the gate window in this process with a scripted terminal, as `cli-gate-window.test.ts` does. */
function openWindow(dir: string): void {
  let err = "";
  const streams: Streams = {
    out: () => undefined,
    err: (text) => {
      err += text;
    },
  };
  const prompter: Prompter = {
    readLine: () => "understood",
    readSecret: (): SecretRead => {
      throw new Error("gate open must never ask for a secret");
    },
    confirm: () => {
      throw new Error("gate open must never use a y/N confirmation");
    },
  };
  const code = commandGate(
    ["open", "--for", "5m", "--reason", "repair the policy", "--as", "human:alice"],
    streams,
    dir,
    { prompter },
  );
  assert.equal(code, 0, err);
}

test("B1: an unattested edit removing a tools entry does not loosen the gate; the call is refused policy-not-attested, as Bash is", () => {
  const dir = ready(policy([], [...CLASSES, ...TOOLS]));
  const attested = claudeVerdict(claude(dir, "mcp__contextsling__publish", { text: "x" }, "t-b1-before"));
  assert.equal(attested.permission, "deny");
  assert.match(attested.reason, /^hook-class-human-only: /);

  // The entry that made the call human-only is removed on disk, and nobody attests.
  rewrite(dir, policy([], [...CLASSES]));
  const before = logRecords(dir).length;

  const mcp = claudeVerdict(claude(dir, "mcp__contextsling__publish", { text: "x" }, "t-b1-mcp"));
  assert.equal(mcp.permission, "deny");
  assert.match(mcp.reason, /^hook-gate-refused:policy-not-attested: /);
  // Bash under the same edited file gets the same answer.
  const bash = claudeVerdict(claude(dir, "Bash", { command: "ls" }, "t-b1-bash"));
  assert.equal(bash.permission, "deny");
  assert.match(bash.reason, /^hook-gate-refused:policy-not-attested: /);
  // Hermes, the same.
  const hermesRun = hermesVerdict(hermes(dir, "mcp_zzz_post", { body: "x" }, "h-b1"));
  assert.equal(hermesRun.permission, "deny");
  assert.match(hermesRun.message, /policy-not-attested/);
  // The post half does not call it ungated either: it goes on to the close,
  // which finds no start.
  const post = claudePost(dir, "mcp__contextsling__publish", { text: "x" }, "t-b1-mcp");
  assert.doesNotMatch(post.stderr, /post-tool-not-gated/);
  assert.equal(logRecords(dir).length, before, "nothing was appended");
});

test("B1: an unattested edit removing unmapped_tool: ask refuses TodoWrite and Hermes todo until a human re-attests", () => {
  const dir = ready(policy(["  unmapped_tool: ask"], [...CLASSES]));
  rewrite(dir, policy([], [...CLASSES]));
  const before = logRecords(dir).length;

  const todo = claudeVerdict(claude(dir, "TodoWrite", { todos: [] }, "t-b1-ask"));
  assert.equal(todo.permission, "deny");
  assert.match(todo.reason, /^hook-gate-refused:policy-not-attested: /);
  assert.match(todo.reason, /an edited policy is inoperative until a human re-attests it/);
  const hermesRun = hermesVerdict(hermes(dir, "todo", { items: [] }, "h-b1-ask"));
  assert.equal(hermesRun.permission, "deny");
  assert.match(hermesRun.message, /policy-not-attested/);
  const post = claudePost(dir, "TodoWrite", { todos: [] }, "t-b1-ask");
  assert.doesNotMatch(post.stderr, /post-tool-not-gated/);
  assert.equal(logRecords(dir).length, before, "nothing was appended");

  // Re-attesting the edit is what puts it in force.
  attest(dir);
  const after = claudeVerdict(claude(dir, "TodoWrite", { todos: [] }, "t-b1-ask-after"));
  assert.equal(after.permission, "allow");
  assert.equal(after.reason, "TodoWrite is not a gated tool");
  const afterHermes = hermesVerdict(hermes(dir, "todo", { items: [] }, "h-b1-ask-after"));
  assert.equal(afterHermes.permission, "allow");
});

test("B1: a policy that was never attested leaves no unclaimed call ungated", () => {
  const dir = ready(policy([], [...CLASSES]), false);
  const verdict = claudeVerdict(claude(dir, "TodoWrite", { todos: [] }, "t-b1-never"));
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-gate-refused:policy-not-attested: /);
  assert.equal(logRecords(dir).length, 0);
});

test("S1: under an open window a policy that does not load still records an unclaimed call as gate.bypassed", () => {
  const dir = ready(policy(["  unmapped_tool: ask"], [...CLASSES]));
  openWindow(dir);
  rewrite(dir, policy([], [...CLASSES, "tools:", "  - match: mcp__zzz__post", "    class: communicate.zzz.post"]));
  const before = logRecords(dir).length;

  const verdict = claudeVerdict(claude(dir, "TodoWrite", { todos: [] }, "t-s1"));
  assert.equal(verdict.permission, "allow");
  assert.match(verdict.reason, /^gate-open: harness\.tool\.unmapped bypassed /);
  const bypassed = logRecords(dir).slice(before);
  assert.equal(bypassed.length, 1);
  assert.equal(bypassed[0]?.["event"], "gate.bypassed");
  const payload = bypassed[0]?.["payload"] as Record<string, unknown>;
  assert.equal(payload["tool"], "TodoWrite");
  assert.deepEqual(payload["classes"], ["harness.tool.unmapped"]);

  // Hermes, the same.
  const hermesRun = hermesVerdict(hermes(dir, "todo", { items: [] }, "h-s1"));
  assert.equal(hermesRun.permission, "allow");
  assert.equal(logRecords(dir).slice(before).filter((record) => record["event"] === "gate.bypassed").length, 2);
});

test("S1: under an open window an unattested policy that maps nothing still records an unclaimed call", () => {
  const dir = ready(policy(["  unmapped_tool: ask"], [...CLASSES]));
  openWindow(dir);
  rewrite(dir, policy([], [...CLASSES]));
  const before = logRecords(dir).length;
  const verdict = claudeVerdict(claude(dir, "TodoWrite", { todos: [] }, "t-s1-drift"));
  assert.equal(verdict.permission, "allow");
  assert.match(verdict.reason, /^gate-open: harness\.tool\.unmapped bypassed /);
  const bypassed = logRecords(dir).slice(before);
  assert.deepEqual(bypassed.map((record) => record["event"]), ["gate.bypassed"]);
});

test("S2: a tools mapping that will not load is refused with its per-entry errors and the repair", () => {
  const dir = ready(
    policy([], [...CLASSES, "tools:", "  - match: mcp__zzz__post", "    class: nope.nope"]),
    false,
  );
  const claudeRun = claudeVerdict(claude(dir, "mcp__zzz__post", {}, "t-s2"));
  assert.equal(claudeRun.permission, "deny");
  assert.match(claudeRun.reason, /^hook-policy-unavailable: schema-invalid: /);
  assert.match(claudeRun.reason, /\/tools\/0\/class: class "nope\.nope" is not declared/);
  assert.match(claudeRun.reason, /approval policy attest/);
  const hermesRun = hermesVerdict(hermes(dir, "todo", {}, "h-s2"));
  assert.equal(hermesRun.permission, "deny");
  assert.match(hermesRun.message, /\/tools\/0\/class: class "nope\.nope" is not declared/);
  assert.match(hermesRun.message, /approval policy attest/);
});

test("S3: a supervised-retro mapped start carries harness_tool", () => {
  const dir = ready(
    policy(
      [],
      [
        ...CLASSES,
        "  marketplace.retro.post:",
        "    autonomy: supervised-retro",
        "tools:",
        '  - match: "mcp__r__*"',
        "    class: marketplace.retro.post",
      ],
    ),
  );
  const verdict = claudeVerdict(claude(dir, "mcp__r__post", { body: "x" }, "t-s3-retro"));
  assert.equal(verdict.permission, "allow", verdict.reason);
  const [start] = starts(dir);
  assert.ok(start !== undefined, "no execution.started was appended");
  const payload = start["payload"] as Record<string, unknown>;
  assert.equal(payload["class"], "marketplace.retro.post");
  assert.equal(payload["harness_tool"], "mcp__r__post");
});

test("S3: a start that spends a human's grant carries harness_tool", () => {
  const dir = ready(policy(["  unmapped_tool: ask"], [...CLASSES]));
  const input = { todos: [] };
  const asked = claudeVerdict(claude(dir, "TodoWrite", input, "t-s3-ask", ["--timeout", "50ms"]));
  assert.equal(asked.permission, "deny");
  const granted = runCli(
    ["grant", "hook:cc-sess-tools:t-s3-ask:harness.tool.unmapped", "--as", "human:alice"],
    dir,
  );
  assert.equal(granted.code, 0, granted.stderr);
  const spent = claudeVerdict(claude(dir, "TodoWrite", input, "t-s3-spend", ["--timeout", "1s"]));
  assert.equal(spent.permission, "allow", spent.reason);
  const [start] = starts(dir);
  assert.ok(start !== undefined, "no execution.started was appended");
  const payload = start["payload"] as Record<string, unknown>;
  assert.equal(payload["class"], "harness.tool.unmapped");
  assert.equal(payload["harness_tool"], "TodoWrite");
});

test("S4: a tool name a tools entry could not name is refused by name before anything is appended", () => {
  const dir = ready(policy(["  unmapped_tool: record"], [...CLASSES]));
  const before = logRecords(dir).length;
  for (const [name, id] of [
    ["Todo Write", "t-s4-space"],
    ["café", "t-s4-accent"],
    ["x".repeat(300), "t-s4-long"],
  ] as const) {
    const verdict = claudeVerdict(claude(dir, name, {}, id));
    assert.equal(verdict.permission, "deny", name);
    assert.match(verdict.reason, /^hook-io: tool-name-invalid: /, name);
    assert.doesNotMatch(verdict.reason, /append-failed/, name);
  }
  assert.equal(logRecords(dir).length, before, "nothing was appended");
});

test("H1: record-only unmapped starts are not charged to daily_actions, and a spent budget does not refuse them", () => {
  const dir = ready(
    policy(["  unmapped_tool: record"], [...CLASSES, "budgets:", "  global:", "    daily_actions: 1"]),
  );
  for (const id of ["t-h1-a", "t-h1-b", "t-h1-c"]) {
    const verdict = claudeVerdict(claude(dir, "TodoWrite", { todos: [] }, id));
    assert.equal(verdict.permission, "allow", verdict.reason);
  }
  assert.equal(starts(dir).length, 3, "each record-only call still writes its start");
  // The one action the budget allows is still there for real work.
  const first = claudeVerdict(claude(dir, "Bash", { command: "ls" }, "t-h1-bash-1"));
  assert.equal(first.permission, "allow", first.reason);
  // The budget is live: a second action is refused.
  const second = claudeVerdict(claude(dir, "Bash", { command: "ls" }, "t-h1-bash-2"));
  assert.equal(second.permission, "deny");
  assert.match(second.reason, /budget-exceeded/);
  // And a record-only call is not refused by the spent budget.
  const after = claudeVerdict(claude(dir, "TodoWrite", { todos: [] }, "t-h1-d"));
  assert.equal(after.permission, "allow", after.reason);
});

test("H1: failed record-only unmapped calls do not trip the loop floor", () => {
  const dir = ready(policy(["  unmapped_tool: record"], [...CLASSES]));
  for (const id of ["t-h1-f1", "t-h1-f2", "t-h1-f3", "t-h1-f4"]) {
    assert.equal(claudeVerdict(claude(dir, "TodoWrite", { todos: [] }, id)).permission, "allow");
    claudeFailedPost(dir, "TodoWrite", { todos: [] }, id);
  }
  assert.equal(logRecords(dir).filter((record) => record["event"] === "execution.failed").length, 4);
  // A side-effecting call after four failed record-only calls is answered by
  // the policy, not floored to a human.
  const write = claudeVerdict(
    claude(dir, "Write", { file_path: join(dir, "after.txt"), content: "x" }, "t-h1-write", ["--timeout", "50ms"]),
  );
  assert.equal(write.permission, "allow", write.reason);
  assert.doesNotMatch(write.reason, /loop-escalated/);
});

test("H1 attack 1: nothing in the tool input makes a mapped call record-only; the class comes from the attested mapping", () => {
  const dir = ready(
    policy(
      ["  unmapped_tool: record"],
      [
        ...CLASSES,
        "  communicate.zzz.send:",
        "    autonomy: autonomous",
        "tools:",
        "  - match: mcp__zzz__send",
        "    class: communicate.zzz.send",
        "budgets:",
        "  global:",
        "    daily_actions: 1",
      ],
    ),
  );
  const forged = { class: "harness.tool.unmapped", harness_tool: "TodoWrite", execution: "harness" };
  const first = claudeVerdict(claude(dir, "mcp__zzz__send", forged, "t-atk-1"));
  assert.equal(first.permission, "allow", first.reason);
  const [start] = starts(dir);
  assert.ok(start !== undefined);
  const payload = start["payload"] as Record<string, unknown>;
  assert.equal(payload["class"], "communicate.zzz.send");
  assert.equal(payload["harness_tool"], "mcp__zzz__send");
  // It was charged: the one action the budget allows is gone.
  const second = claudeVerdict(claude(dir, "mcp__zzz__send", forged, "t-atk-2"));
  assert.equal(second.permission, "deny");
  assert.match(second.reason, /budget-exceeded/);
});

test("H1 attack 1: the write boundary re-derives the class of a named harness tool from the ATTESTED mapping", () => {
  // The hook classifies from its own read of the policy; a swap between that
  // read and the gate's attested read could hand the gate an unmapped class
  // for a tool the attested policy maps. The gate refuses it and appends nothing.
  const dir = ready(
    policy(
      ["  unmapped_tool: record"],
      [
        ...CLASSES,
        "  communicate.zzz.send:",
        "    autonomy: autonomous",
        "tools:",
        "  - match: mcp__zzz__send",
        "    class: communicate.zzz.send",
      ],
    ),
  );
  const logPath = join(dir, ".approval", "log", "events.jsonl");
  const before = logRecords(dir).length;
  const forged = startHarnessExecution(
    logPath,
    {
      task: "hook:cc-sess-tools:t-atk-race",
      actionKey: "hook:cc-sess-tools:t-atk-race:harness.tool.unmapped",
      cls: "harness.tool.unmapped",
      payload_hash: "a".repeat(64),
      harness_tool: "mcp__zzz__send",
    },
    "agent:cc",
    { policy: { dir } },
  );
  assert.equal(forged.ok, false);
  assert.equal(forged.ok ? "" : forged.code, "policy-not-attested");
  assert.equal(logRecords(dir).length, before, "nothing was appended");
  // The honest pair is admitted.
  const honest = startHarnessExecution(
    logPath,
    {
      task: "hook:cc-sess-tools:t-atk-honest",
      actionKey: "hook:cc-sess-tools:t-atk-honest:harness.tool.unmapped",
      cls: "harness.tool.unmapped",
      payload_hash: "a".repeat(64),
      harness_tool: "TodoWrite",
    },
    "agent:cc",
    { policy: { dir } },
  );
  assert.equal(honest.ok, true, honest.ok ? "" : honest.message);
});

test("H1 attack 2: a refused unmapped call writes no start, and failed side-effecting calls still trip the floor", () => {
  const dir = ready(policy(["  unmapped_tool: record"], [...CLASSES]));
  // A refused unmapped call (an unrecordable name) leaves nothing for the
  // floor to exempt.
  const refused = claudeVerdict(claude(dir, "Todo Write", {}, "t-atk-refused"));
  assert.equal(refused.permission, "deny");
  assert.equal(starts(dir).length, 0);
  // Three failed side-effecting calls, with record-only calls between them,
  // floor the session exactly as before.
  for (const index of [1, 2, 3]) {
    const todo = `t-atk-todo${String(index)}`;
    const recorded = claudeVerdict(claude(dir, "TodoWrite", { todos: [] }, todo, ["--timeout", "50ms"]));
    assert.equal(recorded.permission, "allow", recorded.reason);
    claudePost(dir, "TodoWrite", { todos: [] }, todo);
    const id = `t-atk-w${String(index)}`;
    const write = { file_path: join(dir, `w${String(index)}.txt`), content: "x" };
    assert.equal(claudeVerdict(claude(dir, "Write", write, id, ["--timeout", "50ms"])).permission, "allow");
    claudeFailedPost(dir, "Write", write, id);
  }
  const floored = claudeVerdict(
    claude(dir, "Write", { file_path: join(dir, "w4.txt"), content: "x" }, "t-atk-w4", ["--timeout", "50ms"]),
  );
  assert.equal(floored.permission, "deny");
  assert.match(floored.reason, /loop-escalated/);
  // The floor still ROUTES an unmapped call to a human (it is not known to
  // only look); H1 exempts it from accruing, not from the floor.
  const routed = claudeVerdict(claude(dir, "TodoWrite", { todos: [] }, "t-atk-todo4", ["--timeout", "50ms"]));
  assert.equal(routed.permission, "deny");
  assert.match(routed.reason, /loop-escalated/);
});

// ---------------------------------------------------------------------------
// Ruling (claude-edge): harness.tool.unmapped is reserved to the hook
// ---------------------------------------------------------------------------

function envelopeDeclaring(cls: string, key: string): Record<string, unknown> {
  return {
    origin: { app: "claude-code", created_by: "agent:cc" },
    state: "proposed",
    actions: [{ class: cls, summary: "x", idempotency_key: key, payload_hash: "a".repeat(64) }],
  };
}

test("reserved: a task envelope declaring harness.tool.unmapped is refused and nothing is appended", () => {
  const dir = ready(policy(["  unmapped_tool: record"], [...CLASSES]));
  const logPath = join(dir, ".approval", "log", "events.jsonl");
  const before = logRecords(dir).length;
  const refusedRun = register(
    logPath,
    { task: "task-reserved", envelope: envelopeDeclaring("harness.tool.unmapped", "task-reserved:a") },
    "agent:cc",
    { policy: { dir } },
  );
  assert.equal(refusedRun.ok, false);
  assert.equal(refusedRun.ok ? "" : refusedRun.code, "envelope-invalid");
  assert.match(refusedRun.ok ? "" : refusedRun.message, /reserved to the harness hook/);
  assert.equal(logRecords(dir).length, before, "nothing was appended");
  // The same envelope under an ordinary class registers, so the refusal is the class.
  const control = register(
    logPath,
    { task: "task-control", envelope: envelopeDeclaring("exec.local", "task-control:a") },
    "agent:cc",
    { policy: { dir } },
  );
  assert.equal(control.ok, true, control.ok ? "" : control.message);
});

test("reserved: approval propose of harness.tool.unmapped is refused and nothing is appended", () => {
  const dir = ready(
    policy(
      ["  unmapped_tool: ask"],
      [...CLASSES, "  harness.tool.unmapped:", "    autonomy: manual", "    agent_may_request: true"],
    ),
  );
  const logPath = join(dir, ".approval", "log", "events.jsonl");
  const before = logRecords(dir).length;
  const proposed = propose(
    logPath,
    { cls: "harness.tool.unmapped", actionKey: "harness.tool.unmapped:p-1", summary: "x", payload: { tool: "TodoWrite" } },
    "agent:cc",
    { policy: { dir } },
  );
  assert.equal(proposed.ok, false);
  assert.match(proposed.ok ? "" : proposed.message, /reserved to the harness hook/);
  assert.equal(logRecords(dir).length, before, "nothing was appended");
});

test("reserved: approval run cannot start a key the hook registered under harness.tool.unmapped", () => {
  const dir = ready(policy(["  unmapped_tool: ask"], [...CLASSES]));
  const asked = claudeVerdict(claude(dir, "TodoWrite", { todos: [] }, "t-res-run", ["--timeout", "50ms"]));
  assert.equal(asked.permission, "deny");
  const key = "hook:cc-sess-tools:t-res-run:harness.tool.unmapped";
  const before = logRecords(dir).length;
  const started = startExecution(
    join(dir, ".approval", "log", "events.jsonl"),
    key,
    { policy: { dir }, presentedPayloadHash: payloadHash({ tool: "TodoWrite", input: { todos: [] } }) },
    "agent:cc",
  );
  assert.equal(started.ok, false);
  assert.equal(started.ok ? "" : started.code, "harness-executed");
  // The CLI verb, the same.
  const cli = runCli(["run", key, "--as", "agent:cc", "--", "true"], dir);
  assert.notEqual(cli.code, 0);
  assert.match(cli.stdout + cli.stderr, /harness-executed/);
  assert.equal(logRecords(dir).length, before, "nothing was appended");
});

test("reserved: a policy-path start of harness.tool.unmapped without harness_tool is refused", () => {
  const dir = ready(policy(["  unmapped_tool: record"], [...CLASSES]));
  const before = logRecords(dir).length;
  const started = startHarnessExecution(
    join(dir, ".approval", "log", "events.jsonl"),
    {
      task: "hook:cc-sess-tools:t-res-noname",
      actionKey: "hook:cc-sess-tools:t-res-noname:harness.tool.unmapped",
      cls: "harness.tool.unmapped",
      payload_hash: "a".repeat(64),
    },
    "agent:cc",
    { policy: { dir } },
  );
  assert.equal(started.ok, false);
  assert.equal(started.ok ? "" : started.code, "not-granted");
  assert.equal(logRecords(dir).length, before);
});

test("reserved: the hook still registers and records under the class (a supervised-retro rule), and asks under ask", () => {
  const dir = ready(
    policy(
      ["  unmapped_tool: record"],
      [...CLASSES, "  harness.tool.unmapped:", "    autonomy: supervised-retro"],
    ),
  );
  const verdict = claudeVerdict(claude(dir, "TodoWrite", { todos: [] }, "t-res-retro"));
  assert.equal(verdict.permission, "allow", verdict.reason);
  const registered = logRecords(dir).filter((record) => record["event"] === "task.registered");
  assert.equal(registered.length, 1);
  const [start] = starts(dir);
  assert.ok(start !== undefined, "no execution.started was appended");
  assert.equal((start["payload"] as Record<string, unknown>)["harness_tool"], "TodoWrite");

  const askDir = ready(policy(["  unmapped_tool: ask"], [...CLASSES]));
  const asked = claudeVerdict(claude(askDir, "TodoWrite", { todos: [] }, "t-res-ask", ["--timeout", "50ms"]));
  assert.match(asked.reason, /^hook-timeout: /);
  assert.equal(logRecords(askDir).filter((record) => record["event"] === "approval.requested").length, 1);
});

// ---------------------------------------------------------------------------
// Fix round 2 (recheck SF2): the reservation holds at request and at consume
// ---------------------------------------------------------------------------

const SF2_TASK = "hook:cc-sess-tools:t-sf2";
const SF2_KEY = `${SF2_TASK}:harness.tool.unmapped`;

/**
 * Steps 1 and 2 of the recheck's flow (S5): the hook registers and asks for
 * TodoWrite under `unmapped_tool: ask`, then the agent withdraws the hook's
 * own request. Returns the directory and the hook's request record.
 */
function hookAskedThenWithdrawn(): { dir: string; asked: Record<string, unknown> } {
  const dir = ready(policy(["  unmapped_tool: ask"], [...CLASSES]));
  const verdict = claudeVerdict(claude(dir, "TodoWrite", { todos: [] }, "t-sf2", ["--timeout", "50ms"]));
  assert.equal(verdict.permission, "deny");
  const requested = logRecords(dir).filter((record) => record["event"] === "approval.requested");
  assert.equal(requested.length, 1);
  const [asked] = requested;
  assert.ok(asked !== undefined);
  assert.equal(asked["action_key"], SF2_KEY);
  const withdrawn = runCli(["withdraw", SF2_TASK, "--action", SF2_KEY, "--as", "agent:cc"], dir);
  assert.equal(withdrawn.code, 0, withdrawn.stderr);
  return { dir, asked };
}

test("SF2: after withdrawing the hook's request, `approval request` on the reserved class is refused and nothing is appended", () => {
  const { dir } = hookAskedThenWithdrawn();
  const before = logRecords(dir).length;
  // Step 3 of the recheck's flow, the CLI verb an agent reaches.
  const cli = runCli(
    ["request", SF2_TASK, "--action", SF2_KEY, "--payload", "-", "--as", "agent:cc", "--json"],
    dir,
    JSON.stringify({ tool: "TodoWrite", input: { todos: [] } }),
  );
  assert.equal(cli.code, 1, cli.stdout + cli.stderr);
  assert.match(cli.stdout + cli.stderr, /envelope-invalid/);
  assert.match(cli.stdout + cli.stderr, /reserved to the harness hook/);
  // The core function, the same: no in-process caller can mint a token here.
  const core = request(
    join(dir, ".approval", "log", "events.jsonl"),
    { task: SF2_TASK, actionKey: SF2_KEY, cls: "harness.tool.unmapped", summary: "x", payload_hash: "a".repeat(64) },
    "agent:cc",
    { policy: { dir } },
  );
  assert.equal(core.ok, false);
  assert.equal(core.ok ? "" : core.code, "envelope-invalid");
  assert.equal(logRecords(dir).length, before, "nothing was appended");
  assert.equal(
    logRecords(dir).filter((record) => record["event"] === "approval.granted").length,
    0,
    "no grant can follow: there is no token-minting request to grant",
  );
});

test("SF2: a token grant on the reserved class (a log an earlier runtime wrote) cannot be spent by `approval consume` or `approval run`", () => {
  // Steps 3 and 4 of the recheck's flow as the runtime BEFORE this fix wrote
  // them: a token-minting re-request of the hook's key and a human's grant of
  // it. No verb of this runtime can write them any more (the test above), so
  // they are appended at the log layer, exactly as tests/token.test.ts writes
  // a pre-APRV-17 grant, and they pass the same write-boundary validation.
  const { dir, asked } = hookAskedThenWithdrawn();
  const logPath = join(dir, ".approval", "log", "events.jsonl");
  const askedPayload = { ...(asked["payload"] as Record<string, unknown>) };
  delete askedPayload["execution"];
  delete askedPayload["harness_cap_ms"];
  const boundHash = askedPayload["payload_hash"];
  assert.equal(typeof boundHash, "string");
  const now = new Date().toISOString();
  const rerequested = appendEvent(logPath, {
    ts: now,
    event: "approval.requested",
    actor: "agent:cc",
    task: SF2_TASK,
    action_key: SF2_KEY,
    payload: askedPayload,
  });
  assert.equal(rerequested.ok, true, rerequested.ok ? "" : rerequested.error.message);
  const token = mintToken();
  const grantPayload: Record<string, unknown> = {
    class: "harness.tool.unmapped",
    est_cost_usd: askedPayload["est_cost_usd"] ?? "0",
    payload_hash: boundHash,
    token_sha256: tokenHash(token),
  };
  if (typeof askedPayload["policy_sha256"] === "string") grantPayload["policy_sha256"] = askedPayload["policy_sha256"];
  const grantedRecord = appendEvent(logPath, {
    ts: now,
    event: "approval.granted",
    actor: "human:alice",
    task: SF2_TASK,
    action_key: SF2_KEY,
    payload: grantPayload,
  });
  assert.equal(grantedRecord.ok, true, grantedRecord.ok ? "" : grantedRecord.error.message);
  const before = logRecords(dir).length;

  // Step 5: `approval run` refuses the class (fix round 1).
  const run = runCli(["run", SF2_KEY, "--token", token, "--as", "agent:cc", "--", "true"], dir);
  assert.notEqual(run.code, 0);
  assert.match(run.stdout + run.stderr, /harness-executed/);

  // Step 6: `approval consume` refuses it too, with the same code (fix round 2).
  const consumed = runCli(
    ["consume", SF2_KEY, "--token", token, "--payload-hash", String(boundHash), "--as", "agent:cc", "--json"],
    dir,
  );
  assert.equal(consumed.code, 1, consumed.stdout + consumed.stderr);
  assert.match(consumed.stdout + consumed.stderr, /harness-executed/);
  assert.match(consumed.stdout + consumed.stderr, /reserved to the harness hook/);

  // The core spend, the same: the refusal lives in the shared verification.
  const core = consumeToken(logPath, SF2_KEY, token, "agent:cc", {
    policyDir: dir,
    presentedPayloadHash: String(boundHash),
  });
  assert.equal(core.ok, false);
  assert.equal(core.ok ? "" : core.code, "harness-executed");
  // The reservation's words, not verifyToken's "granted as a harness-executed
  // request": the token itself verified (live, unspent, bound), and only the
  // class refused it.
  assert.match(core.ok ? "" : core.message, /reserved to the harness hook/);
  assert.doesNotMatch(core.ok ? "" : core.message, /no execution token was minted/);

  assert.equal(logRecords(dir).length, before, "nothing was appended");
  assert.equal(starts(dir).length, 0, "no execution.started under the reserved class");
  const verified = runCli(["log", "verify"], dir);
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
});
