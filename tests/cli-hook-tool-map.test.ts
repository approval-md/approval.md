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

import { payloadHash } from "../src/core/payload.js";

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
  assert.equal((start?.["payload"] as Record<string, unknown>)["harness_tool"], "web_search");
});

test("unmapped_tool: ask gates an unmapped tool as manual under harness.tool.unmapped", () => {
  const dir = ready(policy(["  unmapped_tool: ask"], [...CLASSES, ...TOOLS]));
  const run = claude(dir, "TodoWrite", { todos: [] }, "t-ask", ["--timeout", "50ms"]);
  const verdict = claudeVerdict(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /);
  const requested = logRecords(dir).filter((record) => record["event"] === "approval.requested");
  assert.equal(requested.length, 1);
  assert.equal(requested[0]?.["action_key"], "hook:cc-sess-tools:t-ask:harness.tool.unmapped");
  assert.equal((requested[0]?.["payload"] as Record<string, unknown>)["class"], "harness.tool.unmapped");
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
