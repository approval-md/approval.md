/**
 * `approval mcp serve --http` — the streamable-HTTP transport and its
 * per-session identity (APRV-174).
 *
 * The stdio suite (`tests/mcp-server.test.ts`) pins what the wrapper IS: the
 * tool list, the schemas, the CLI's own answers, one fixed identity. None of
 * that is retested here. What this suite pins is the part the HTTP transport
 * adds, and every claim in it is checked over a real socket with a real MCP
 * client on an ephemeral loopback port:
 *
 *  1. **Two concurrent sessions are two identities.** Under `--guest` each gets
 *     its own `agent:guest-<hex>`, each session says its own actor back, and the
 *     records they append carry their own actor in the log.
 *  2. **Nothing a client sends names an identity.** `clientInfo.name` is a label
 *     and the actor is the server's; a tool call passing `--as` is refused.
 *  3. **Routing is by `mcp-session-id`**, an unknown one is a 404, a
 *     non-initialize POST with no session is a 400, and a terminated session is
 *     gone from the map.
 *  4. **The caps hold**: over the concurrency cap an initialize gets a plain 503
 *     naming the reason, and no session is created.
 *  5. **The bind is loopback** unless an operator writes another host out in
 *     full, and the CLI's argument rules refuse the shapes that would make that
 *     accidental.
 *
 * No log line here is written by hand: every record under test is appended by a
 * tool call that runs the real verb.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  isLoopbackHost,
  parseListen,
  MCP_HTTP_DEFAULT_HOST,
  MCP_HTTP_DEFAULT_PORT,
} from "../src/cli/mcp.js";
import {
  GUEST_ACTOR_PREFIX,
  MAX_CONCURRENT_SESSIONS,
  mintSessionActor,
  serveApprovalMcpHttp,
  type McpHttpServer,
} from "../src/mcp/http.js";

/** dist/tests/mcp-http.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-mcp-http-")));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Run {
  const env = { ...process.env };
  delete env["APPROVAL_HUMAN"];
  delete env["APPROVAL_AGENT"];
  env["APPROVAL_HUMAN"] = "human:alice";
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** A task file with one cheap, reversible action nobody will execute. */
function taskFile(id: string): string {
  return [
    "---",
    `id: ${id}`,
    "title: Ask the crowd",
    "approval:",
    "  origin:",
    "    app: mcp-http-test",
    '    created_by: "human:tester"',
    "  state: proposed",
    "  actions:",
    "    - class: communicate.email.external",
    '      summary: "Send the chaser"',
    "      reversible: true",
    '      est_cost_usd: "0.01"',
    `      idempotency_key: "${id}:chaser"`,
    "---",
    "",
    "Body.",
    "",
  ].join("\n");
}

/** A fresh initialised, attested world carrying `tasks` task files. */
function newWorld(label: string, tasks: string[] = []): string {
  const dir = join(scratch, label);
  mkdirSync(dir, { recursive: true });
  assert.equal(runCli(["init", "--json"], dir).code, 0);
  assert.equal(runCli(["policy", "attest", "--json"], dir).code, 0);
  for (const id of tasks) writeFileSync(join(dir, `${id}.md`), taskFile(id));
  return dir;
}

/**
 * One world shared by every case that appends nothing.
 *
 * A world costs two real CLI invocations (`init`, `policy attest`), and most of
 * these cases only need somewhere legitimate for a session to point at.
 */
let shared: string | null = null;
function sharedWorld(): string {
  shared ??= newWorld("shared");
  return shared;
}

/** Every record in a world's log, in order. Read, never written. */
function logRecords(dir: string): Array<Record<string, unknown>> {
  const text = readFileSync(join(dir, ".approval", "log", "events.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Start a listener on an ephemeral loopback port. */
async function listen(
  dir: string,
  options: { guest: boolean; actor?: string } = { guest: true },
): Promise<McpHttpServer> {
  return await serveApprovalMcpHttp({
    actor: options.actor ?? null,
    guest: options.guest,
    port: 0,
    cwd: dir,
    notice: () => {},
  });
}

/** Connect one MCP client over HTTP. The `name` is a label and proves nothing. */
async function connect(
  server: McpHttpServer,
  name = "stranger",
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://${server.host}:${server.port}/mcp`),
  );
  const client = new Client({ name, version: "1" });
  // The SDK's own d.ts declares `sessionId` as `string | undefined`, which this
  // repo's `exactOptionalPropertyTypes` reads as a mismatch with `Transport`.
  await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
  return { client, transport };
}

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
  return {
    structured: result.structuredContent,
    text: result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n"),
    isError: result.isError === true,
  };
}

/**
 * The actor a session is running as, asked of the session itself.
 *
 * `--as` from a tool call is refused with `mcp-identity-fixed`, and the refusal
 * names the identity the server chose. So the probe for "which actor am I" is
 * the very mechanism that stops a caller from choosing one.
 */
async function actorOf(client: Client): Promise<string> {
  try {
    await client.callTool({
      name: "queue",
      arguments: { flags: { "--as": "agent:i-said-so" } },
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    assert.ok(
      message.includes("mcp-identity-fixed"),
      `expected an identity refusal, got: ${message}`,
    );
    const found = /agent:[a-z0-9-]+/u.exec(message.replace("agent:i-said-so", ""));
    assert.ok(found !== null, `no actor in the refusal: ${message}`);
    return found[0];
  }
  throw new Error("--as was accepted over HTTP");
}

/** Poll until `predicate` holds or the budget runs out. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((settle) => setTimeout(settle, 20));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** One raw JSON-RPC initialize, without the SDK client. */
async function rawInitialize(
  server: McpHttpServer,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await fetch(`http://${server.host}:${server.port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw", version: "1" },
      },
    }),
  });
}

// ---------------------------------------------------------------------------
// (1) two sessions, two identities
// ---------------------------------------------------------------------------

test("mcp http: two concurrent guest sessions get distinct agent:guest-* actors", async () => {
  const dir = newWorld("two-guests", ["task-a", "task-b"]);
  const server = await listen(dir);
  try {
    const first = await connect(server, "alice-harness");
    const second = await connect(server, "bob-harness");
    try {
      const firstActor = await actorOf(first.client);
      const secondActor = await actorOf(second.client);

      assert.ok(firstActor.startsWith(GUEST_ACTOR_PREFIX), firstActor);
      assert.ok(secondActor.startsWith(GUEST_ACTOR_PREFIX), secondActor);
      assert.notEqual(firstActor, secondActor);
      assert.deepEqual(server.sessionActors().sort(), [firstActor, secondActor].sort());

      // The appends land under their own actor, which is the whole point: a
      // budget or a rate limit keyed on the actor sees one stranger per session.
      const a = await call(first.client, "register", { positionals: ["task-a.md"] });
      const b = await call(second.client, "register", { positionals: ["task-b.md"] });
      assert.equal(a.isError, false, a.text);
      assert.equal(b.isError, false, b.text);

      const registered = new Map(
        logRecords(dir)
          .filter((record) => record["event"] === "task.registered")
          .map((record) => [record["task"] as string, record["actor"] as string]),
      );
      assert.equal(registered.size, 2, JSON.stringify([...registered]));
      assert.deepEqual([...registered.values()].sort(), [firstActor, secondActor].sort());
      assert.notEqual(registered.get("task-a"), registered.get("task-b"));
    } finally {
      await first.transport.terminateSession();
      await second.transport.terminateSession();
      await first.client.close();
      await second.client.close();
    }
  } finally {
    await server.close();
  }
});

test("mcp http: the client's own name is a label, never an identity", async () => {
  const dir = sharedWorld();
  const server = await listen(dir);
  try {
    const { client, transport } = await connect(server, "agent:root");
    try {
      const actor = await actorOf(client);
      assert.ok(actor.startsWith(GUEST_ACTOR_PREFIX), actor);
      assert.notEqual(actor, "agent:root");
    } finally {
      await transport.terminateSession();
      await client.close();
    }
  } finally {
    await server.close();
  }
});

test("mcp http: without --guest every session runs as the operator's one actor", async () => {
  const dir = sharedWorld();
  const server = await listen(dir, { guest: false, actor: "agent:operator" });
  try {
    const first = await connect(server);
    const second = await connect(server);
    try {
      assert.equal(await actorOf(first.client), "agent:operator");
      assert.equal(await actorOf(second.client), "agent:operator");
      assert.deepEqual(server.sessionActors(), ["agent:operator", "agent:operator"]);
    } finally {
      await first.transport.terminateSession();
      await second.transport.terminateSession();
      await first.client.close();
      await second.client.close();
    }
  } finally {
    await server.close();
  }
});

test("mcp http: minted actors are unique against the ones already handed out", () => {
  const used = new Set<string>();
  for (let index = 0; index < 500; index += 1) {
    const actor = mintSessionActor(used);
    assert.ok(actor.startsWith(GUEST_ACTOR_PREFIX));
    assert.ok(!used.has(actor));
    used.add(actor);
  }
  assert.equal(used.size, 500);
});

// ---------------------------------------------------------------------------
// (2) routing, and the session lifecycle
// ---------------------------------------------------------------------------

test("mcp http: requests route by mcp-session-id, and a stranger's id is a 404", async () => {
  const dir = sharedWorld();
  const server = await listen(dir);
  try {
    const { client, transport } = await connect(server);
    try {
      assert.equal(server.sessionActors().length, 1);

      const bogus = await fetch(`http://${server.host}:${server.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": "00000000-0000-4000-8000-000000000000",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
      });
      assert.equal(bogus.status, 404);
      assert.equal(
        ((await bogus.json()) as { error: { code: string } }).error.code,
        "mcp-unknown-session",
      );

      const sessionless = await fetch(`http://${server.host}:${server.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list", params: {} }),
      });
      assert.equal(sessionless.status, 400);
      assert.equal(
        ((await sessionless.json()) as { error: { code: string } }).error.code,
        "mcp-session-required",
      );

      const nowhere = await fetch(`http://${server.host}:${server.port}/nope`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(nowhere.status, 404);
      assert.equal(
        ((await nowhere.json()) as { error: { code: string } }).error.code,
        "mcp-unknown-path",
      );

      // The live session still answers after all of that.
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      assert.ok(tools.includes("register"));
    } finally {
      await transport.terminateSession();
      await client.close();
    }
    await until(() => server.sessionActors().length === 0, "the session map to empty");
  } finally {
    await server.close();
  }
});

test("mcp http: a terminated session's id stops working", async () => {
  const dir = sharedWorld();
  const server = await listen(dir);
  try {
    const { client, transport } = await connect(server);
    const id = transport.sessionId;
    assert.ok(id !== undefined);
    await transport.terminateSession();
    await client.close();
    await until(() => server.sessionActors().length === 0, "the session map to empty");

    const after = await fetch(`http://${server.host}:${server.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": id,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
    });
    assert.equal(after.status, 404);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// (3) the caps
// ---------------------------------------------------------------------------

test("mcp http: an initialize over the concurrency cap is a 503 naming the reason", async () => {
  const dir = sharedWorld();
  const server = await listen(dir, { guest: false, actor: "agent:operator" });
  try {
    for (let index = 0; index < MAX_CONCURRENT_SESSIONS; index += 1) {
      const response = await rawInitialize(server);
      assert.equal(response.status, 200, `session ${index} was refused`);
      await response.text();
    }
    assert.equal(server.sessionActors().length, MAX_CONCURRENT_SESSIONS);
    assert.equal(server.lifetimeSessions(), MAX_CONCURRENT_SESSIONS);

    const refused = await rawInitialize(server);
    assert.equal(refused.status, 503);
    const body = (await refused.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "mcp-session-cap");
    assert.ok(body.error.message.includes(String(MAX_CONCURRENT_SESSIONS)));

    // Refused means refused: no session was created for it.
    assert.equal(server.sessionActors().length, MAX_CONCURRENT_SESSIONS);
    assert.equal(server.lifetimeSessions(), MAX_CONCURRENT_SESSIONS);
  } finally {
    await server.close();
  }
});

test("mcp http: a body that is not JSON is refused before any session work", async () => {
  const dir = sharedWorld();
  const server = await listen(dir);
  try {
    const response = await fetch(`http://${server.host}:${server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(response.status, 400);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      "mcp-invalid-json",
    );
    assert.equal(server.lifetimeSessions(), 0);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// (4) the bind, and the argument rules that keep it deliberate
// ---------------------------------------------------------------------------

test("mcp http: the default bind is loopback", async () => {
  const dir = sharedWorld();
  const server = await listen(dir);
  try {
    assert.equal(server.host, "127.0.0.1");
    assert.equal(MCP_HTTP_DEFAULT_HOST, "127.0.0.1");
    assert.equal(MCP_HTTP_DEFAULT_PORT, 4681);
    assert.ok(server.port > 0);
    assert.ok(isLoopbackHost(server.host));
  } finally {
    await server.close();
  }
});

test("mcp http: --listen parses [host:]port and only a written-out host is non-loopback", () => {
  assert.deepEqual(parseListen("4681"), { ok: true, host: "127.0.0.1", port: 4681 });
  assert.deepEqual(parseListen(":4681"), { ok: true, host: "127.0.0.1", port: 4681 });
  assert.deepEqual(parseListen("127.0.0.1:4681"), {
    ok: true,
    host: "127.0.0.1",
    port: 4681,
  });
  assert.deepEqual(parseListen("0.0.0.0:4681"), { ok: true, host: "0.0.0.0", port: 4681 });
  assert.deepEqual(parseListen("[::1]:4681"), { ok: true, host: "::1", port: 4681 });
  assert.equal(parseListen("::1:4681").ok, false);
  assert.equal(parseListen("nonsense").ok, false);
  assert.equal(parseListen("127.0.0.1:70000").ok, false);

  assert.ok(isLoopbackHost("127.0.0.1"));
  assert.ok(isLoopbackHost("localhost"));
  assert.ok(isLoopbackHost("::1"));
  assert.ok(!isLoopbackHost("0.0.0.0"));
  assert.ok(!isLoopbackHost("10.0.0.4"));
});

test("mcp http: the CLI refuses the flag shapes that would make a bind accidental", () => {
  const dir = sharedWorld();

  const guestOnStdio = runCli(["mcp", "serve", "--guest", "--json"], dir);
  assert.equal(guestOnStdio.code, 2);
  assert.match(guestOnStdio.stderr, /--guest applies to the HTTP transport only/u);

  const both = runCli(
    ["mcp", "serve", "--http", "--listen", "4681", "--port", "4681", "--json"],
    dir,
  );
  assert.equal(both.code, 2);
  assert.match(both.stderr, /--listen and --port name the same thing/u);

  const asWithGuest = runCli(
    ["mcp", "serve", "--http", "--guest", "--as", "agent:x", "--json"],
    dir,
  );
  assert.equal(asWithGuest.code, 2);
  assert.match(asWithGuest.stderr, /--as and --guest are exclusive/u);

  const badPort = runCli(["mcp", "serve", "--http", "--port", "wat", "--json"], dir);
  assert.equal(badPort.code, 2);
  assert.match(badPort.stderr, /--port expects a whole number/u);
});
