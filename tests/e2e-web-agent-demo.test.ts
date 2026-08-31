/**
 * The web-agent demo, rehearsed without a model, a phone, or a network
 * (APRV-158) — the twin of `examples/web-agent-demo/server.mjs`.
 *
 * `tests/e2e-mcp-demo.test.ts` (APRV-88) walks the MCP transport with a real
 * client and a mock Bot API. This file walks the demo that sits on top of it:
 * `examples/web-agent-demo/server.mjs` is spawned as a real child process, an
 * attendee submits a curated task over `POST /api/task`, and the agent the
 * server starts drives the real gate — register, request, wait, run — while a
 * human on a mock Telegram decides in the middle.
 *
 * Three rules shape it, and each is the sibling's.
 *
 * **The gate is real; only the model is not.** Every record in the demo
 * instance's log is written by `dist/src/cli/main.js` through the real append
 * path: nothing here fabricates a log line, and the assertions read the log
 * back through `approval log tail --json`, the same command the runbook tells
 * an operator to run. What stands in for `claude -p` is a small script this
 * test writes into the scratch directory and hands to the server through its
 * documented `CLAUDE_BIN` seam. That script is not a stub of the gate: it
 * shells out to the same CLI a real agent reaches through the MCP wrapper, and
 * it discovers the task file, the action key and the payload from the prompt
 * the server generated, so a change to the seeded envelope or the prompt breaks
 * this test rather than passing it.
 *
 * **The human's authority never touches the server.** The demo server holds no
 * identity (it is started with `APPROVAL_HUMAN` and every credential stripped
 * out) and the fake agent is handed none either. The grant arrives the only way
 * it can: `approval channel telegram listen` running under the human's own
 * identity against `tests/telegram-mock.ts` on loopback, asserted local by
 * {@link assertLocal}.
 *
 * **The server appends nothing.** Hop (c) pins that directly, by holding the
 * log still across several `/api/state` reads, and the sweep at the end pins
 * the other half: the raw execution token that unblocked the agent appears in
 * nothing this server served, because sealed delivery opened it inside the
 * agent child and it never crossed the API.
 *
 * One flat test rather than ordered subtests, for the reason
 * `tests/e2e-mcp-demo.test.ts` gives at its own flat walk: a `t.test()` awaited
 * from a parent that has already awaited something else does not reliably hold
 * this Node version's runner. The hops are marked by comment.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { assertLocal, callbackUpdate, startMockBotApi, type MockBotApi } from "./telegram-mock.js";

/** dist/tests/e2e-web-agent-demo.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
/** dist/tests/… -> <repo>/examples/web-agent-demo/server.mjs (not built; run as-is). */
const SERVER_ENTRY = fileURLToPath(
  new URL("../../examples/web-agent-demo/server.mjs", import.meta.url),
);

const HUMAN = "human:carter";
/** Pinned by the server itself; asserted, never configured from here. */
const AGENT = "agent:demo";
/** The curated template this walk submits. */
const TEMPLATE = "run_a_command";
/** The command that template declares, and the one the fake finally spawns. */
const COMMAND = ["echo", "hello from the demo agent"];

const BOT_TOKEN = "7654321:AA-approval-md-fake-token-for-the-web-agent-demo-DO-NOT-USE";
const CHAT = "9922";

/**
 * The demo gate's policy, trimmed from `examples/web-agent-demo/provisioning.md`
 * to the classes this walk touches. `token_delivery: sealed` is the load-bearing
 * line: it is why the agent's `wait` can unblock with a usable token without a
 * human pasting one into a terminal, and therefore why no token ever has to
 * travel through the demo server.
 */
const POLICY = [
  "# Approval policy — web-agent demo gate (test twin)",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  "  channel: telegram",
  '  approval_ttl: "10m"',
  "  on_expiry: reject",
  "  token_delivery: sealed",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  exec.local:",
  "    autonomy: manual",
  "channels:",
  "  telegram:",
  "    token_env: APPROVAL_TG_TOKEN",
  "    chat_id_env: APPROVAL_TG_CHAT",
  "```",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// The fake agent binary
// ---------------------------------------------------------------------------

/**
 * The script `CLAUDE_BIN` points at: a stand-in for `claude -p` that emits
 * plausible stream-json and drives the REAL CLI between the lines it emits.
 *
 * How it finds its work is deliberate. The server scrubs the child's
 * environment down to PATH/HOME/SHELL/NO_COLOR and the `ANTHROPIC_*`/`CLAUDE_*`
 * names, so nothing about the instance can be smuggled in through the
 * environment; the CLI's absolute path is baked into the generated file
 * instead, and everything else (task file, task id, action key, payload file,
 * trailing argv) is parsed out of the prompt the server wrote, exactly as a
 * model would have to read it. The instance itself is the child's cwd, which
 * the server sets.
 *
 * It writes to fd 1 synchronously. `spawnSync` for the blocking `wait` would
 * otherwise hold the event loop with the `wait` tool_use still buffered, and
 * the moment this test cares most about — the agent visibly stopped, waiting
 * for a person — would never reach `/api/task/:id`.
 *
 * It never prints the raw token: it passes it to `run` in a flag the server
 * seals, and elides it from the `wait` result it narrates, which is what the
 * server's own system contract tells the real agent to do.
 */
function fakeAgentSource(): string {
  return [
    "#!/usr/bin/env node",
    "// Written by tests/e2e-web-agent-demo.test.ts. Not a stub of the gate: it",
    "// runs the real CLI as agent:demo against the demo instance.",
    'import { spawnSync } from "node:child_process";',
    'import { writeSync } from "node:fs";',
    "",
    `const CLI = ${JSON.stringify(CLI_ENTRY)};`,
    `const AGENT = ${JSON.stringify(AGENT)};`,
    "",
    "const argv = process.argv.slice(2);",
    'const prompt = argv[argv.indexOf("-p") + 1] ?? "";',
    "",
    "function emit(event) {",
    "  writeSync(1, `${JSON.stringify(event)}\\n`);",
    "}",
    "function say(text) {",
    '  emit({ type: "assistant", message: { content: [{ type: "text", text }] } });',
    "}",
    "let uses = 0;",
    "function toolUse(name, input) {",
    "  uses += 1;",
    "  const id = `toolu_${uses}`;",
    "  emit({",
    '    type: "assistant",',
    "    message: {",
    '      content: [{ type: "tool_use", id, name: `mcp__approval__${name}`, input }],',
    "    },",
    "  });",
    "  return id;",
    "}",
    "function toolResult(id, text, isError) {",
    "  emit({",
    '    type: "user",',
    "    message: {",
    "      content: [",
    "        {",
    '          type: "tool_result",',
    "          tool_use_id: id,",
    '          content: [{ type: "text", text }],',
    "          is_error: isError === true,",
    "        },",
    "      ],",
    "    },",
    "  });",
    "}",
    "function cli(args) {",
    "  const result = spawnSync(process.execPath, [CLI, ...args], {",
    "    cwd: process.cwd(),",
    '    encoding: "utf8",',
    '    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NO_COLOR: "1" },',
    "  });",
    '  return { code: result.status ?? -1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };',
    "}",
    "function need(pattern, what) {",
    "  const found = pattern.exec(prompt);",
    "  if (found === null) {",
    "    writeSync(2, `fake-agent: the prompt names no ${what}\\n`);",
    "    process.exit(3);",
    "  }",
    "  return found;",
    "}",
    "function stop(text) {",
    '  emit({ type: "result", subtype: "error", result: text, is_error: true });',
    "  process.exit(1);",
    "}",
    "",
    'const registerLine = need(/`register` with positionals \\["([^"]+)"\\]/u, "task file");',
    "const requestLine = need(",
    '  /`request` with positionals \\["([^"]+)"\\] and flags \\{"--action": "([^"]+)", "--payload": "([^"]+)"/u,',
    '  "request step",',
    ");",
    'const trailingLine = need(/trailing \\[("[^\\]]*")\\]/u, "trailing argv");',
    "const taskFile = registerLine[1];",
    "const taskId = requestLine[1];",
    "const actionKey = requestLine[2];",
    "const payloadFile = requestLine[3];",
    "const trailing = JSON.parse(`[${trailingLine[1]}]`);",
    "",
    'emit({ type: "system", subtype: "init", session_id: "fake-agent" });',
    'say("Registering the task file the demo server seeded for me.");',
    'const registerId = toolUse("register", { positionals: [taskFile], flags: { "--json": true } });',
    'const registered = cli(["register", taskFile, "--as", AGENT, "--json"]);',
    "toolResult(registerId, registered.stdout.trim() || registered.stderr.trim(), registered.code !== 0);",
    'if (registered.code !== 0) stop("register was refused");',
    "",
    'say("Asking the gate whether I may take the declared action.");',
    'const requestId = toolUse("request", {',
    "  positionals: [taskId],",
    '  flags: { "--action": actionKey, "--payload": payloadFile, "--json": true },',
    "});",
    "const requested = cli([",
    '  "request",',
    "  taskId,",
    '  "--action",',
    "  actionKey,",
    '  "--payload",',
    "  payloadFile,",
    '  "--as",',
    "  AGENT,",
    '  "--json",',
    "]);",
    "toolResult(requestId, requested.stdout.trim() || requested.stderr.trim(), requested.code !== 0);",
    'if (requested.code !== 0) stop("request was refused");',
    "",
    'say("The gate says a human must decide. I am blocked until then.");',
    'const waitId = toolUse("wait", { positionals: [taskId], flags: { "--timeout": "8m", "--json": true } });',
    'const waited = cli(["wait", taskId, "--timeout", "300s", "--as", AGENT, "--json"]);',
    "let answer = null;",
    "try {",
    "  answer = JSON.parse(waited.stdout);",
    "} catch {",
    "  answer = null;",
    "}",
    "if (answer === null) {",
    "  toolResult(waitId, waited.stderr.trim(), true);",
    '  stop("wait produced no JSON");',
    "}",
    "const entry = (answer.actions ?? []).find((action) => action.action_key === actionKey);",
    "// Narrate the answer with the token taken out: it goes to `run` in a flag,",
    "// and never onto a transcript a projector might show.",
    "toolResult(",
    "  waitId,",
    "  JSON.stringify({",
    "    ...answer,",
    "    actions: (answer.actions ?? []).map((action) =>",
    '      action.token === undefined ? action : { ...action, token: "<elided by the agent>" },',
    "    ),",
    "  }),",
    "  false,",
    ");",
    'if (answer.status !== "granted" || typeof entry?.token !== "string") {',
    '  say(`The answer was ${answer.status}. Stopping.`);',
    '  emit({ type: "result", subtype: "success", result: `not granted: ${answer.status}`, is_error: false });',
    "  process.exit(0);",
    "}",
    "",
    'say("A human approved it. Spending the token now.");',
    'const runId = toolUse("run", {',
    "  positionals: [actionKey],",
    '  flags: { "--token": entry.token, "--json": true },',
    "  trailing,",
    "});",
    "const executed = cli([",
    '  "run",',
    "  actionKey,",
    '  "--token",',
    "  entry.token,",
    '  "--as",',
    "  AGENT,",
    '  "--json",',
    '  "--",',
    "  ...trailing,",
    "]);",
    "toolResult(",
    "  runId,",
    "  `child stdout:\\n${executed.stdout.trim()}\\nsummary:\\n${executed.stderr.trim()}`,",
    "  executed.code !== 0,",
    ");",
    'if (executed.code !== 0) stop(`run exited ${executed.code}`);',
    'emit({ type: "result", subtype: "success", result: "The command ran, after a human approved it.", is_error: false });',
    "process.exit(0);",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The scratch demo instance
// ---------------------------------------------------------------------------

/** realpath: macOS hands out /var/… symlinks, and the command binding is a path. */
const demo = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-e2e-web-agent-")));
const fakeAgent = join(demo, "fake-agent.mjs");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Every byte anything printed or served, swept for the token at the end. */
const captured: { label: string; text: string }[] = [];

/**
 * The environment children get: this process's, minus every variable that could
 * hand one of them an identity or a credential by accident.
 */
function cliEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const name of [
    "APPROVAL_HUMAN",
    "APPROVAL_AGENT",
    "APPROVAL_TG_TOKEN",
    "APPROVAL_TG_CHAT",
    "APPROVAL_VAULT_PASSPHRASE",
  ]) {
    if (extra[name] === undefined) delete env[name];
  }
  return env;
}

function runCli(args: string[], env: Record<string, string> = {}): Run {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: demo,
    encoding: "utf8",
    env: cliEnv(env),
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  const run = { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  captured.push({ label: `cli ${args[0] ?? "?"} stdout`, text: run.stdout });
  captured.push({ label: `cli ${args[0] ?? "?"} stderr`, text: run.stderr });
  return run;
}

function json(run: Run): Record<string, unknown> {
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

interface LogRecord {
  seq: number;
  event: string;
  actor: string;
  action_key?: string;
  payload?: Record<string, unknown>;
}

/** The log as `approval log tail --json` reports it: the sanctioned reader. */
function tail(count = 20): LogRecord[] {
  const run = runCli(["log", "tail", "-n", String(count), "--json"]);
  assert.equal(run.code, 0, run.stderr);
  const parsed = json(run) as { status: string; records: LogRecord[] };
  assert.equal(parsed.status, "ok", "the chain is not intact");
  return parsed.records;
}

function events(): string[] {
  return tail().map((record) => record.event);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(predicate: () => boolean, label: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await pause(25);
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function untilAsync(
  predicate: () => Promise<boolean>,
  label: string,
  ms = 60_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(100);
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** A port nothing is listening on. The server refuses port 0 by design. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

/** One `approval channel telegram listen --once` pass against the mock. */
function spawnListener(pollTimeoutSeconds: number): { done: Promise<Run> } {
  const child = spawn(
    process.execPath,
    [
      CLI_ENTRY,
      "channel",
      "telegram",
      "listen",
      "--once",
      "--api-base",
      assertLocal(mock.url),
      "--poll-timeout",
      String(pollTimeoutSeconds),
    ],
    {
      cwd: demo,
      env: cliEnv({
        APPROVAL_TG_TOKEN: BOT_TOKEN,
        APPROVAL_TG_CHAT: CHAT,
        APPROVAL_HUMAN: HUMAN,
      }),
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<Run>((resolve) => {
    child.on("exit", (status) => {
      resolve({ code: status ?? -1, stdout, stderr });
    });
  });
  return { done };
}

let mock: MockBotApi;
let base = "";

/** One GET against the demo server, recorded for the sweep. */
async function get(path: string): Promise<{ code: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  captured.push({ label: `GET ${path}`, text });
  return { code: response.status, body: JSON.parse(text) as Record<string, unknown> };
}

async function post(path: string, body: unknown): Promise<{ code: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  captured.push({ label: `POST ${path}`, text });
  return { code: response.status, body: JSON.parse(text) as Record<string, unknown> };
}

// ===========================================================================
// The walk
// ===========================================================================

test("the web-agent demo: an attendee submits, the gate holds, a phone decides", async () => {
  mock = await startMockBotApi(BOT_TOKEN);
  let executionToken = "";
  let serverOut = "";
  let serverErr = "";
  let server: ReturnType<typeof spawn> | null = null;

  try {
    // -----------------------------------------------------------------------
    // (a) the world: a scratch instance, the demo policy, and an attestation.
    // Every record from here on is written by the CLI through the real append
    // path; nothing in this file writes to events.jsonl.
    const scaffolded = runCli(["init", "--json"]);
    assert.equal(scaffolded.code, 0, scaffolded.stderr);
    writeFileSync(join(demo, "APPROVAL.md"), POLICY, "utf8");

    const attested = runCli(["policy", "attest", "--as", HUMAN, "--json"]);
    assert.equal(attested.code, 0, attested.stderr);
    assert.deepEqual(events(), ["policy.updated"]);

    writeFileSync(fakeAgent, fakeAgentSource(), "utf8");
    chmodSync(fakeAgent, 0o755);

    // -----------------------------------------------------------------------
    // (b) the server: the real file, spawned the way the runbook spawns it,
    // with no identity and no credential, and CLAUDE_BIN pointed at the fake.
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [SERVER_ENTRY, "--dir", demo, "--port", String(port)], {
      cwd: demo,
      env: cliEnv({ CLAUDE_BIN: fakeAgent }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.setEncoding("utf8");
    server.stderr?.setEncoding("utf8");
    server.stdout?.on("data", (chunk: string) => {
      serverOut += chunk;
    });
    server.stderr?.on("data", (chunk: string) => {
      serverErr += chunk;
    });
    await until(() => serverOut.includes("task desk on http://"), "the demo server to listen");
    assert.match(serverOut, new RegExp(`agent: +${fakeAgent} as ${AGENT}`, "u"));
    assert.equal(serverErr, "", `the server warned at startup: ${serverErr}`);

    // -----------------------------------------------------------------------
    // (c) AC3: the server appends NOTHING. The log is held still across three
    // aggregate reads, spaced past the server's own 2s cache so each one really
    // forks the read verbs rather than replaying a cached answer.
    const before = tail();
    assert.equal(before.length, 1);
    for (let i = 0; i < 3; i += 1) {
      const state = await get("/api/state");
      assert.equal(state.code, 200);
      assert.equal((state.body["log_verify"] as Record<string, unknown>)["status"], "clean");
      assert.deepEqual((state.body["queue"] as Record<string, unknown>)["pending"], []);
      if (i < 2) await pause(2100);
    }
    const stillOnlyTheAttestation = tail();
    assert.equal(stillOnlyTheAttestation.length, 1, "the demo server appended to the log");
    assert.deepEqual(
      stillOnlyTheAttestation.map((record) => record.seq),
      before.map((record) => record.seq),
    );

    // -----------------------------------------------------------------------
    // (d) the submission desk: one attendee, one curated task, 202 and no
    // decision of any kind.
    const submitted = await post("/api/task", { template_id: TEMPLATE });
    assert.equal(submitted.code, 202, JSON.stringify(submitted.body));
    const taskId = String(submitted.body["id"]);
    assert.equal(submitted.body["template_id"], TEMPLATE);
    assert.equal(submitted.body["class"], "exec.local");
    assert.ok(["queued", "running"].includes(String(submitted.body["state"])));

    // A second submission from the same address inside the throttle window is a
    // 429 and enqueues nothing: the desk's only power is refusal. Probed HERE,
    // milliseconds after the first 202, because the window is 15s of wall clock
    // and a probe placed after the granted flow sits right at that edge — green
    // serially and 202 under a loaded parallel suite. That it enqueued nothing
    // is carried by (g), which sees exactly one task, and by the final tail of
    // exactly six events.
    const throttled = await post("/api/task", { template_id: TEMPLATE });
    assert.equal(throttled.code, 429, JSON.stringify(throttled.body));

    // -----------------------------------------------------------------------
    // (e) the seeded files: the envelope and the payload the server wrote, and
    // the hash it declared, recomputed by the CLI that owns that arithmetic.
    const taskFile = join(demo, "tasks", `${taskId}.task.md`);
    const payloadFile = join(demo, "tasks", `${taskId}.payload.json`);
    await until(() => existsSync(taskFile) && existsSync(payloadFile), "the seeded task envelope");
    const hashed = runCli(["payload", "hash", payloadFile, "--json"]);
    assert.equal(hashed.code, 0, hashed.stderr);
    const payloadHash = String(json(hashed)["hash"]);
    const envelope = readFileSync(taskFile, "utf8");
    assert.match(envelope, new RegExp(`payload_hash: "${payloadHash}"`, "u"));
    assert.match(envelope, /class: exec\.local/u);
    assert.deepEqual(JSON.parse(readFileSync(payloadFile, "utf8")), {
      argv: COMMAND,
      cwd: demo,
    });
    const actionKey = `${taskId}:greet`;

    // -----------------------------------------------------------------------
    // (f) the request: appended by the AGENT through the CLI, not by the server,
    // and carrying the class from the registered record and the hash above.
    await untilAsync(
      async () => events().includes("approval.requested"),
      "the agent to register and request",
    );
    const afterRequest = tail();
    assert.deepEqual(
      afterRequest.map((record) => record.event),
      ["policy.updated", "task.registered", "approval.requested"],
    );
    assert.equal(afterRequest[1]?.actor, AGENT, "task.registered is not the demo agent's");
    assert.equal(afterRequest[2]?.actor, AGENT, "approval.requested is not the demo agent's");
    assert.equal(afterRequest[2]?.action_key, actionKey);
    assert.equal((afterRequest[2]?.payload ?? {})["class"], "exec.local");
    assert.equal((afterRequest[2]?.payload ?? {})["payload_hash"], payloadHash);

    // -----------------------------------------------------------------------
    // (g) the pause, seen from the page: the gate holds a pending decision and
    // the task says out loud that it is waiting on a person.
    await untilAsync(async () => {
      const state = await get("/api/state");
      const pending = (state.body["queue"] as { pending?: { action_key?: string }[] }).pending ?? [];
      return pending.some((item) => item.action_key === actionKey);
    }, "/api/state to show the pending decision");
    await untilAsync(async () => {
      const view = await get(`/api/task/${taskId}`);
      return view.body["awaiting_approval"] === true;
    }, "/api/task/:id to report the agent blocked on a human");
    const blocked = await get(`/api/task/${taskId}`);
    assert.equal(blocked.body["state"], "running");
    const tasksList = await get("/api/tasks");
    assert.equal(tasksList.body["running"], taskId);

    // -----------------------------------------------------------------------
    // (h) telegram, pass one: the request reaches a phone. Nothing is decided
    // by a delivery.
    const firstPass = spawnListener(1);
    const delivered = await firstPass.done;
    captured.push({ label: "listener 1 stdout", text: delivered.stdout });
    captured.push({ label: "listener 1 stderr", text: delivered.stderr });
    assert.equal(delivered.code, 0, delivered.stderr);
    const messages = mock.sentTexts().join("\n");
    assert.match(messages, /APPROVAL REQUIRED/u);
    assert.match(messages, new RegExp(`<code>${actionKey}</code>`, "u"));
    assert.match(messages, /echo/u, "the approver was not shown the command");
    assert.match(messages, new RegExp(`CLAIMED by ${AGENT}`, "u"));
    const firstKeyboard = mock.callbackDataFor(actionKey, "grant");
    assert.equal(events().length, 3, "a delivery decided something");

    // -----------------------------------------------------------------------
    // (i) telegram, pass two: the tap. The grant is the human's, recorded under
    // the human's identity, and the raw token is printed on this terminal only.
    const secondPass = spawnListener(10);
    await until(
      () => mock.callbackDataFor(actionKey, "grant") !== firstKeyboard,
      "the second pass to re-send the request with its own keyboard",
    );
    mock.queueUpdate(
      callbackUpdate({ data: mock.callbackDataFor(actionKey, "grant"), chatId: CHAT }),
    );
    const granted = await secondPass.done;
    captured.push({ label: "listener 2 stderr", text: granted.stderr });
    assert.equal(granted.code, 0, granted.stderr);
    assert.match(granted.stdout, new RegExp(`granted ${actionKey} .*by ${HUMAN} via telegram`, "u"));
    const printed = /execution token +\S+\n {2}(\S+)/u.exec(granted.stdout);
    assert.ok(printed !== null, `no execution token on the listener's stdout: ${granted.stdout}`);
    executionToken = printed[1] as string;
    assert.match(executionToken, /^[a-f0-9]{64}$/u);

    const afterGrant = tail();
    assert.equal(afterGrant[3]?.event, "approval.granted");
    assert.equal(afterGrant[3]?.actor, HUMAN, "the grant is not recorded against the human");
    assert.equal(
      (afterGrant[3]?.payload ?? {})["token_sha256"],
      createHash("sha256").update(executionToken, "utf8").digest("hex"),
    );

    // -----------------------------------------------------------------------
    // (j) the unblock and the execution: the agent's sealed `wait` returned a
    // usable token WITHOUT one crossing this server, and the command ran.
    await untilAsync(async () => {
      const view = await get(`/api/task/${taskId}`);
      return view.body["state"] === "done" || view.body["state"] === "failed";
    }, "the agent run to finish");
    const finished = await get(`/api/task/${taskId}`);
    assert.equal(finished.body["state"], "done", JSON.stringify(finished.body["note"]));
    assert.equal(finished.body["exit_code"], 0);
    assert.equal(finished.body["awaiting_approval"], false);

    assert.deepEqual(events(), [
      "policy.updated",
      "task.registered",
      "approval.requested",
      "approval.granted",
      "execution.started",
      "execution.completed",
    ]);
    const afterRun = tail();
    assert.equal(afterRun[4]?.actor, AGENT);
    assert.equal(afterRun[5]?.actor, AGENT);
    assert.deepEqual(afterRun[5]?.payload, { exit_code: 0 });

    // The transcript the page serves: the gate tools are named, the token flag
    // is sealed rather than shortened, and the child's output came back.
    const entries = finished.body["entries"] as {
      kind: string;
      text: string;
      tool?: string;
      gate?: boolean;
    }[];
    const toolUses = entries.filter((entry) => entry.kind === "tool_use");
    assert.deepEqual(
      toolUses.map((entry) => entry.tool),
      [
        "mcp__approval__register",
        "mcp__approval__request",
        "mcp__approval__wait",
        "mcp__approval__run",
      ],
    );
    assert.ok(toolUses.every((entry) => entry.gate === true), "a gate tool was not marked as one");
    const runUse = toolUses[3];
    assert.match(String(runUse?.text), /--token <sealed>/u, "the token flag was not sealed");
    assert.ok(
      entries.some((entry) => entry.kind === "result"),
      "the run's final result never reached the page",
    );

    // -----------------------------------------------------------------------
    // (k) the aggregate, after: the pending decision is gone, the log the page
    // shows has grown to the six records above, and the chain is clean.
    await pause(2100);
    const afterState = await get("/api/state");
    assert.deepEqual((afterState.body["queue"] as Record<string, unknown>)["pending"], []);
    assert.equal((afterState.body["log_verify"] as Record<string, unknown>)["status"], "clean");
    assert.equal((afterState.body["log_verify"] as Record<string, unknown>)["records"], 6);
    const shownTail = (afterState.body["log_tail"] as { records: LogRecord[] }).records;
    assert.deepEqual(
      shownTail.map((record) => record.event),
      [
        "policy.updated",
        "task.registered",
        "approval.requested",
        "approval.granted",
        "execution.started",
        "execution.completed",
      ],
    );

    // (The throttle 429 itself is probed back at hop (d), inside a guaranteed
    // window; this six-event tail is the proof the refusal appended nothing.)

    // -----------------------------------------------------------------------
    // (l) the sweep: nothing the server SERVED or printed carries the raw
    // execution token. `captured` holds every response body of this walk and
    // both of the server's own streams; the listener's stdout, where the
    // runtime prints the token on purpose, is where it is allowed to be.
    //
    // The transcript tee is deliberately NOT swept, and hop (m) says why.
    captured.push({ label: "server stdout", text: serverOut });
    captured.push({ label: "server stderr", text: serverErr });
    for (const { label, text } of captured) {
      assert.equal(text.includes(executionToken), false, `the raw token appeared in ${label}`);
      assert.equal(text.includes(BOT_TOKEN), false, `the bot token appeared in ${label}`);
    }
    const bytes = readFileSync(join(demo, ".approval", "log", "events.jsonl"), "utf8");
    assert.equal(bytes.includes(executionToken), false, "the raw token reached the log");
    assert.equal(bytes.includes(BOT_TOKEN), false, "the bot token reached the log");
    for (const entry of mock.requests) {
      assert.equal(
        entry.raw.includes(executionToken),
        false,
        `the execution token appeared in a ${entry.method} body`,
      );
    }

    // -----------------------------------------------------------------------
    // (m) the tee, pinned as the header describes it: "what it serves is
    // shortened; what it tees is not". The agent handed the token to `run` in a
    // tool_use input, so the verbatim `.jsonl` under tasks/ holds it — which is
    // exactly why that directory is documented as local, unpublished and thrown
    // away with the instance. The assertion is here rather than absent so that
    // a future edit which quietly starts publishing that file has to argue with
    // this line first.
    const tee = readFileSync(join(demo, "tasks", `${taskId}.jsonl`), "utf8");
    assert.equal(
      tee.includes(executionToken),
      true,
      "the tee is documented as verbatim; if it no longer is, this walk's sweep is testing less than it claims",
    );
    assert.equal(tee.includes(BOT_TOKEN), false, "the bot token reached the transcript tee");
    // And the same transcript, as the page shows it, carries neither the token
    // nor a shortened prefix of one: the server sealed the flag before serving.
    const served = await get(`/api/task/${taskId}`);
    const servedText = JSON.stringify(served.body);
    assert.equal(servedText.includes(executionToken), false);
    assert.equal(servedText.includes(executionToken.slice(0, 16)), false);
    assert.match(servedText, /--token <sealed>/u);
  } finally {
    server?.kill("SIGKILL");
    await mock.close();
    rmSync(demo, { recursive: true, force: true });
  }
});
