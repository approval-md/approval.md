/**
 * The M8 end-to-end demo (APRV-88) — an MCP client reaches the gate, a phone
 * decides, and the tool call proceeds.
 *
 * `tests/e2e-demo.test.ts` (APRV-27) walked this story through the CLI and
 * `tests/e2e-email-demo.test.ts` (APRV-70) walked it to a real send. This one
 * walks it through the wrapper of SPEC.md §10.5: a real MCP client speaks
 * JSON-RPC over stdio to a real `approval mcp serve` child process, calls
 * `register`, `request`, `wait` and `run` as tools, and the decision in the
 * middle arrives from Telegram exactly as it does for every other surface.
 *
 * The rules are APRV-27's, and two that belong to this transport.
 *
 * **The server is a REAL child process.** `tests/mcp-server.test.ts` proves the
 * wrapper's contract in memory, which is the right shape for a contract suite.
 * A runbook tells a human to register a command in an MCP client's config, so
 * the demo spawns that command: `node dist/src/cli/main.js mcp serve --as
 * agent:claude-mcp`, connected through the SDK's own `StdioClientTransport`. A
 * regression that only shows up once stdout is a pipe shows up here.
 *
 * **The tool surface is the assertion, not a detail.** `tools/list` is checked
 * for the four verbs the walk uses and for the absence of `grant`, `attest` and
 * `vault_set`, and a `tools/call` of `grant` is asserted to be an unknown tool.
 * The human's authority does not travel over this transport, so the grant in
 * hop (f) arrives by the only route there is: a thumb on a phone, recorded by
 * `approval channel telegram listen` under the human's own identity.
 *
 * Nothing touches a network. The Bot API is `tests/telegram-mock.ts` on
 * loopback, asserted so by {@link assertLocal}, and the only child the demo
 * executes is `echo`.
 *
 * The real-client twin of this script is `examples/mcp-demo.md`, which a human
 * runs once against Claude Code and a real bot. What that run adds is the two
 * things a script cannot stand in for: an MCP client nobody here wrote speaking
 * to this server, and a person deciding.
 *
 * One flat test rather than ordered subtests, for the reason
 * `tests/e2e-email-demo.test.ts` states at its own flat walk: a `t.test()`
 * awaited from a parent that has already awaited something else does not
 * reliably hold this Node version's runner. The hops are marked by comment and
 * every assertion names what it is about.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { runPayloadHash } from "../src/core/payload.js";
import { canonicalRender } from "../src/core/wysiwys.js";
import {
  assertLocal,
  callbackUpdate,
  startMockBotApi,
  type MockBotApi,
} from "./telegram-mock.js";
import { fakeClaudeEnv } from "./fake-claude.js";

/** dist/tests/e2e-mcp-demo.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const HUMAN = "human:carter";
/** The identity the operator pinned when starting the server. */
const AGENT = "agent:claude-mcp";
const TASK = "task-mcp-demo";
const ACTION = "task-mcp-demo:greet";

/** A fake bot token, distinctive enough that the sweep cannot pass by accident. */
const BOT_TOKEN = "7654321:AA-approval-md-fake-token-for-the-m8-demo-DO-NOT-USE";
const CHAT = "9911";

/**
 * The command the agent proposes.
 *
 * `approval run` binds to SPEC.md §6.2's command payload, `{argv, cwd}`, and
 * computes the hash itself from the argv it is about to spawn, so the envelope
 * below declares the hash of THIS argv in THIS directory. A tool call that
 * asked to run anything else is a `payload-mismatch`, which is the property the
 * whole transport rests on: the agent chose the command before a human saw it.
 */
const COMMAND = ["echo", "hello"];

/**
 * `exec.local` is autonomous by default in SPEC.md §7's developer-workstation
 * table. The demo policy tightens it to manual, which is the honest way to make
 * a one-line command worth a human's attention: the gravity is the policy's
 * decision, not a property of `echo`, and tightening is always allowed.
 */
const POLICY = [
  "# Approval policy (MCP demo)",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "  channel: telegram",
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
// The scratch demo home
// ---------------------------------------------------------------------------

/** realpath: macOS hands out /var/… symlinks, and the command binding is a path. */
const demo = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-e2e-mcp-")));
const payloadPath = join(demo, "payload.json");

/** The binding the envelope declares and `approval run` will recompute. */
const PAYLOAD = { argv: COMMAND, cwd: demo };
const PAYLOAD_HASH = runPayloadHash(COMMAND, demo);

const TASK_FILE = [
  "---",
  `id: ${TASK}`,
  "title: Greet the operator from inside the gate",
  "status: In Progress",
  "approval:",
  "  origin:",
  "    app: mcp-demo",
  `    created_by: "${AGENT}"`,
  "  state: proposed",
  "  actions:",
  "    - class: exec.local",
  '      summary: "Run `echo hello` in the demo directory"',
  "      reversible: true",
  '      est_cost_usd: "0"',
  `      idempotency_key: "${ACTION}"`,
  `      payload_hash: "${PAYLOAD_HASH}"`,
  "---",
  "",
  "## Description",
  "",
  "The smallest command worth gating: the demo's point is the route the request",
  "takes, not the blast radius of the command at the end of it.",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Every byte a child printed, swept for the token in the last hop. */
const captured: { label: string; text: string }[] = [];

/**
 * The child's environment is stripped of every variable the demo supplies
 * itself, so a developer who exports `APPROVAL_HUMAN` or `APPROVAL_AGENT` in
 * their own shell cannot make an identity-dependent step pass by accident.
 */
function cliEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  // APRV-197: a fake `claude` first on PATH, because this demo spawns the real
  // listener and the listener glosses by default. See tests/fake-claude.ts.
  const env: NodeJS.ProcessEnv = { ...process.env, ...fakeClaudeEnv(demo), ...extra };
  for (const name of [
    "APPROVAL_HUMAN",
    "APPROVAL_AGENT",
    "APPROVAL_TG_TOKEN",
    "APPROVAL_TG_CHAT",
  ]) {
    if (extra[name] === undefined) delete env[name];
  }
  return env;
}

/** The CLI as a child process: the demo's neutral observer of the log. */
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

/**
 * The log as `approval log tail` reports it — the surface a human reads, and
 * deliberately not a direct read of `events.jsonl`: every hop below is asserted
 * against the same command the runbook tells the human to run at the end.
 */
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

async function until(predicate: () => boolean, label: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** One `approval channel telegram listen --once` pass against the mock. */
function spawnListener(pollTimeoutSeconds: number): {
  done: Promise<Run>;
  read: () => string;
} {
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
  return { done, read: () => stdout };
}

/** One tool call, flattened the way `tests/mcp-server.test.ts` flattens them. */
interface ToolAnswer {
  structured: Record<string, unknown> | undefined;
  text: string;
  isError: boolean;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolAnswer> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
  const answer = { structured: result.structuredContent, text, isError: result.isError === true };
  captured.push({ label: `tool ${name} result`, text });
  return answer;
}

let mock: MockBotApi;

// ===========================================================================
// The walk
// ===========================================================================

test("the MCP demo: a client requests, a phone grants, the tool call proceeds", async () => {
  mock = await startMockBotApi(BOT_TOKEN);
  /** Filled in at hop (f), spent at hop (g). */
  let executionToken = "";
  /** The MCP server child's own stderr, swept at the end with everything else. */
  let serverStderr = "";

  try {
    // -----------------------------------------------------------------------
    // (a) the world: init, the demo policy, attest, and the task file on disk.
    // Every one of these is a human's or an operator's step. None of them is
    // reachable from the MCP server, and hop (b) asserts that.
    const scaffolded = runCli(["init", "--json"]);
    assert.equal(scaffolded.code, 0, scaffolded.stderr);
    writeFileSync(join(demo, "APPROVAL.md"), POLICY, "utf8");
    writeFileSync(join(demo, `${TASK}.md`), TASK_FILE, "utf8");
    writeFileSync(payloadPath, `${JSON.stringify(PAYLOAD, null, 2)}\n`, "utf8");

    const attested = runCli(["policy", "attest", "--as", HUMAN, "--json"]);
    assert.equal(attested.code, 0, attested.stderr);
    assert.equal(json(attested)["seq"], 1);
    assert.deepEqual(events(), ["policy.updated"]);

    // -----------------------------------------------------------------------
    // (b) the server: a real child process, spoken to by a real MCP client over
    // stdio. This is the command a runbook puts in an MCP client's config.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY, "mcp", "serve", "--as", AGENT],
      cwd: demo,
      env: cliEnv({}) as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "e2e-mcp-demo", version: "1" });
    await client.connect(transport);
    // The SDK types this as the base `Stream`; it is the child's piped stderr.
    const serverErr = transport.stderr as unknown as NodeJS.ReadableStream | null;
    serverErr?.setEncoding("utf8");
    serverErr?.on("data", (chunk: string) => {
      serverStderr += chunk;
    });

    try {
      const tools = (await client.listTools()).tools;
      const names = tools.map((tool) => tool.name);
      for (const wanted of ["register", "request", "wait", "run"]) {
        assert.ok(names.includes(wanted), `the walk needs the "${wanted}" tool`);
      }
      // The negative half is the design (SPEC.md §11): an MCP client is an
      // agent's harness, so the overseer's verbs are not on it.
      for (const withheld of ["grant", "reject", "revoke", "policy_attest", "vault_set"]) {
        assert.ok(!names.includes(withheld), `"${withheld}" must not be a tool`);
      }
      // And the tool descriptions are the registry's purposes, which is what
      // `approval instructions --schemas` prints: one source, two surfaces.
      const registerTool = tools.find((tool) => tool.name === "register");
      assert.ok(registerTool !== undefined);
      assert.match(String(registerTool.description), /approval:` envelope/u);
      assert.ok(
        !JSON.stringify(registerTool.inputSchema).includes("--as"),
        "a published schema offers the caller an identity",
      );

      // ---------------------------------------------------------------------
      // (c) register: the envelope becomes a log record, under the SERVER's
      // identity. Nothing in the call names an actor; nothing could.
      const registered = await call(client, "register", { positionals: [`${TASK}.md`] });
      assert.equal(registered.isError, false, registered.text);
      assert.deepEqual(registered.structured, { ok: true, seq: 2, task: TASK, actions: 1 });

      // ---------------------------------------------------------------------
      // (d) request: the class comes from the registered record, the bytes come
      // from the payload file, and a manual class does not proceed.
      const requested = await call(client, "request", {
        positionals: [TASK],
        flags: { "--action": ACTION, "--payload": "payload.json" },
      });
      assert.equal(requested.isError, false, requested.text);
      assert.deepEqual(requested.structured, {
        ok: true,
        task: TASK,
        action_key: ACTION,
        class: "exec.local",
        autonomy: "manual",
        proceed: false,
        requested: true,
        seq: 3,
      });

      const afterRequest = tail();
      assert.deepEqual(
        afterRequest.map((record) => record.event),
        ["policy.updated", "task.registered", "approval.requested"],
      );
      assert.equal(afterRequest[1]?.actor, AGENT, "task.registered is not the server's agent");
      assert.equal(afterRequest[2]?.actor, AGENT, "approval.requested is not the server's agent");
      assert.deepEqual(afterRequest[2]?.payload, {
        class: "exec.local",
        est_cost_usd: "0",
        payload_hash: PAYLOAD_HASH,
        summary: "Run `echo hello` in the demo directory",
        reversible: true,
        // APRV-118: the attested policy this request was routed by, stamped by
        // the runtime and never named by the MCP client.
        policy_sha256: createHash("sha256")
          .update(readFileSync(join(demo, "APPROVAL.md")))
          .digest("hex"),
        // APRV-119 (WYSIWYS): the digest of the canonical rendering every
        // channel presents for these bytes. Stamped by the runtime, never
        // named by the MCP client, for the same reason the policy hash is.
        display_hash: canonicalRender(PAYLOAD, "exec.local").display_hash,
      });

      // ---------------------------------------------------------------------
      // (e) telegram, pass one: the listener delivers the request to the phone.
      // The client cannot do this and cannot answer it.
      const firstPass = spawnListener(1);
      const delivered = await firstPass.done;
      captured.push({ label: "listener 1 stdout", text: delivered.stdout });
      captured.push({ label: "listener 1 stderr", text: delivered.stderr });
      assert.equal(delivered.code, 0, delivered.stderr);
      assert.match(delivered.stdout, new RegExp(`notified ${ACTION}`, "u"));

      const messages = mock.sentTexts().join("\n");
      assert.match(messages, /APPROVAL REQUIRED/u);
      assert.match(messages, new RegExp(`<code>${ACTION}</code>`, "u"));
      assert.match(messages, /PAYLOAD — the canonical rendering/u);
      assert.match(messages, /echo/u, "the approver was not shown the command");
      assert.match(messages, new RegExp(PAYLOAD_HASH, "u"));
      assert.match(
        messages,
        new RegExp(`WHAT THIS DOES — CLAIMED by ${AGENT}, NOT verified`, "u"),
        "the phone does not name the agent that asked",
      );
      const firstKeyboard = mock.callbackDataFor(ACTION, "grant");

      // No decision was recorded by a delivery.
      assert.deepEqual(events(), [
        "policy.updated",
        "task.registered",
        "approval.requested",
      ]);

      // ---------------------------------------------------------------------
      // (f) telegram, pass two: the tap. A restarted listener re-sends what is
      // still pending with a FRESH nonce (the "already sent" set lives only in
      // the process, SPEC.md §10.3), so the button this pass answers is the one
      // this pass issued. The grant is recorded against the human.
      const secondPass = spawnListener(5);
      await until(
        () => mock.callbackDataFor(ACTION, "grant") !== firstKeyboard,
        "the second pass to re-send the request with its own keyboard",
      );
      mock.queueUpdate(
        callbackUpdate({ data: mock.callbackDataFor(ACTION, "grant"), chatId: CHAT }),
      );
      const granted = await secondPass.done;
      captured.push({ label: "listener 2 stderr", text: granted.stderr });
      assert.equal(granted.code, 0, granted.stderr);
      assert.match(granted.stdout, new RegExp(`granted ${ACTION} .*by ${HUMAN} via telegram`, "u"));

      const printed = /execution token +\S+\n {2}(\S+)/u.exec(granted.stdout);
      assert.ok(printed !== null, `no execution token on the listener's stdout: ${granted.stdout}`);
      executionToken = printed[1] as string;
      assert.match(executionToken, /^[a-f0-9]{64}$/u);
      assert.match(granted.stdout, /not sent to Telegram/u);
      // The listener's stdout is the one sanctioned appearance, and it is
      // deliberately NOT in `captured`: the sweep at hop (j) asserts that it is
      // the only one by scanning everything else.

      const afterGrant = tail();
      assert.deepEqual(afterGrant.map((record) => record.event), [
        "policy.updated",
        "task.registered",
        "approval.requested",
        "approval.granted",
      ]);
      assert.equal(afterGrant[3]?.actor, HUMAN, "the grant is not recorded against the human");
      assert.equal(
        (afterGrant[3]?.payload ?? {})["token_sha256"],
        createHash("sha256").update(executionToken, "utf8").digest("hex"),
        "the log holds the token's digest and only its digest",
      );
      assert.equal(
        (afterGrant[3]?.payload ?? {})["payload_hash"],
        PAYLOAD_HASH,
        "the human approved a different binding from the one the agent declared",
      );

      // ---------------------------------------------------------------------
      // (g) wait, through the tool: the harness asks whether it may proceed and
      // is told, by the log, that it may.
      const waited = await call(client, "wait", {
        positionals: [TASK],
        flags: { "--timeout": "10s" },
      });
      assert.equal(waited.isError, false, waited.text);
      assert.equal((waited.structured ?? {})["status"], "granted");
      assert.deepEqual((waited.structured ?? {})["actions"], [
        { action_key: ACTION, state: "granted", seq: 4 },
      ]);

      // ---------------------------------------------------------------------
      // (h) run, through the tool: the token is spent and the child executes.
      // The child's stdio is PIPED rather than inherited — on a stdio server,
      // inheriting would hand the child the JSON-RPC stream — so what the child
      // said comes back as tool content.
      const executed = await call(client, "run", {
        positionals: [ACTION],
        flags: { "--token": executionToken },
        trailing: COMMAND,
      });
      assert.equal(executed.isError, false, executed.text);
      assert.deepEqual(executed.structured, {
        ok: true,
        action_key: ACTION,
        task: TASK,
        class: "exec.local",
        autonomy: "manual",
        started_seq: 5,
        outcome: "execution.completed",
        outcome_seq: 6,
        exit_code: 0,
        payload_hash: PAYLOAD_HASH,
      });
      assert.match(executed.text, /child stdout:\nhello/u, "the child's output did not come back");

      const afterRun = tail();
      assert.deepEqual(afterRun.map((record) => record.event), [
        "policy.updated",
        "task.registered",
        "approval.requested",
        "approval.granted",
        "execution.started",
        "execution.completed",
      ]);
      assert.equal(afterRun[4]?.actor, AGENT);
      assert.equal(afterRun[5]?.actor, AGENT);
      assert.deepEqual(afterRun[5]?.payload, { exit_code: 0 });

      // ---------------------------------------------------------------------
      // (i) the chain, through the tool, and the two refusals.
      const verified = await call(client, "log_verify");
      assert.equal(verified.isError, false, verified.text);
      assert.equal((verified.structured ?? {})["status"], "clean");
      assert.equal((verified.structured ?? {})["records"], 6);

      const replayed = await call(client, "run", {
        positionals: [ACTION],
        flags: { "--token": executionToken },
        trailing: COMMAND,
      });
      assert.equal(replayed.isError, true, "a spent token was accepted a second time");
      assert.equal(
        ((replayed.structured ?? {})["error"] as Record<string, unknown> | undefined)?.["code"],
        "token-consumed",
      );
      assert.equal(
        events().filter((event) => event === "execution.started").length,
        1,
        "the replay appended a second execution.started",
      );
      assert.equal(events().length, 6, "the replay appended anything at all");

      // A human-only verb is not a refused tool call; it is not a tool. The
      // error names the surface where a human decides instead.
      await assert.rejects(
        () => client.callTool({ name: "grant", arguments: {} }),
        /unknown tool/u,
        "`grant` answered an MCP client",
      );

      // ---------------------------------------------------------------------
      // (j) every actor in the log is one of two, and each is the right one.
      for (const record of tail()) {
        const expected =
          record.event === "policy.updated" || record.event === "approval.granted" ? HUMAN : AGENT;
        assert.equal(
          record.actor,
          expected,
          `seq ${record.seq} (${record.event}) was recorded as ${record.actor}`,
        );
      }
    } finally {
      await client.close();
    }

    // -----------------------------------------------------------------------
    // (k) the sweep: the raw execution token has exactly one home.
    //
    // `captured` holds every byte every child printed and every tool result —
    // everything except the listener's own stdout, which is where the runtime
    // prints the token on purpose. The bot token is hunted for everywhere,
    // including there.
    captured.push({ label: "mcp server stderr", text: serverStderr });
    for (const { label, text } of captured) {
      assert.equal(
        text.includes(executionToken),
        false,
        `the raw execution token appeared in ${label}`,
      );
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
    // The MCP server announced its identity and its scope on stderr, never on
    // stdout: stdout was the JSON-RPC stream for the whole walk.
    assert.match(serverStderr, new RegExp(`MCP server on stdio as ${AGENT}`, "u"));
    assert.match(serverStderr, /Human-only verbs are not published/u);
  } finally {
    await mock.close();
    rmSync(demo, { recursive: true, force: true });
  }
});
