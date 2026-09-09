/**
 * The crowd demo's intake limits, driven through the guest MCP surface
 * (APRV-176).
 *
 * `examples/web-agent-demo/provisioning.md` carries the demo gate's policy as a
 * heredoc an operator copies verbatim, and the crowd track adds two ceilings to
 * it: `requests_per_hour: 3` on every class a guest can reach, and
 * `budgets.global.max_pending: 10` over the whole queue. Those numbers are the
 * pitch of the demo — the audience watches the gate refuse a stranger to protect
 * one human's attention — so they are the numbers most worth binding to
 * executed reality rather than to a rehearsal that happened once on a laptop.
 *
 * So this suite:
 *
 *  1. **Reads the policy out of the documentation.** Not a twin, not a trimmed
 *     copy: the `yaml approval-policy` block is extracted from
 *     `provisioning.md` itself and loaded through `core/policy-load.ts`, so an
 *     edit to the documented numbers either updates these assertions or fails
 *     here. The suite's existing demo twins (`tests/e2e-web-agent-demo.test.ts`)
 *     copy the policy because they need it trimmed; this one must not.
 *  2. **Runs the real `approval policy check`** against an instance written from
 *     that block, which is what AC 1 means by "passes policy check" and what
 *     provisioning.md tells the operator to run before attesting.
 *  3. **Drives the guest surface until each refusal fires.** A real
 *     `serveApprovalMcpHttp({ guest: true })` listener on an ephemeral loopback
 *     port, real MCP clients over a socket, real `register` and `request` tool
 *     calls. Every record under test is appended by a guest tool call; nothing
 *     is hand-written into a log here.
 *
 * The two refusals are reached the way a room would reach them. `rate-limited`
 * comes from one stranger asking a fourth time inside the hour, which is the
 * per-origin ceiling doing its job — and origin is the session's own
 * server-minted `agent:guest-<hex>`, so the count cannot be moved onto anybody
 * else. `queue-full` comes from several strangers between them filling the
 * shared queue to ten, which no per-origin ceiling would ever catch.
 *
 * What is deliberately NOT asserted here: that a refusal appends nothing. That
 * is `tests/intake-limits.test.ts`'s claim about the gate, pinned there against
 * the unit. This file's claim is narrower and is about the demo: these numbers,
 * in this file, reached over this transport, refuse.
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

import { payloadHash } from "../src/core/payload.js";
import { loadPolicyText, POLICY_INFO_STRING } from "../src/core/policy-load.js";
import { GUEST_ACTOR_PREFIX, serveApprovalMcpHttp, type McpHttpServer } from "../src/mcp/http.js";

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** dist/tests/demo-guest-limits.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

/** The document that IS the demo policy, not a description of it. */
const PROVISIONING = join(REPO_ROOT, "examples", "web-agent-demo", "provisioning.md");

/** The class the crowd beats use, and the one with no credential behind it. */
const GUEST_CLASS = "exec.local";

/** `requests_per_hour` on every manual class in the demo policy. */
const PER_HOUR = 3;

/** `budgets.global.max_pending` over the whole demo queue. */
const QUEUE_CEILING = 10;

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-demo-guest-")));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The documented policy
// ---------------------------------------------------------------------------

/**
 * The one `yaml approval-policy` block in `provisioning.md`.
 *
 * The document contains exactly one, inside the heredoc an operator copies. If
 * a second is ever added, this fails loudly rather than silently testing the
 * first: which block is "the demo policy" would no longer be a question this
 * file may answer on its own.
 */
function demoPolicyBlock(): string {
  const text = readFileSync(PROVISIONING, "utf8");
  const fence = new RegExp("```" + POLICY_INFO_STRING + "\\n([\\s\\S]*?)\\n```", "gu");
  const blocks = [...text.matchAll(fence)].map((match) => match[1] ?? "");
  assert.equal(
    blocks.length,
    1,
    `expected exactly one \`\`\`${POLICY_INFO_STRING} block in provisioning.md, found ${blocks.length}`,
  );
  return blocks[0] ?? "";
}

/** That block, wrapped as the `APPROVAL.md` the operator writes. */
function demoPolicyFile(): string {
  return [
    "# Approval policy — web-agent demo gate",
    "",
    "Written by tests/demo-guest-limits.test.ts from the block in",
    "examples/web-agent-demo/provisioning.md. The YAML below is that file's,",
    "byte for byte.",
    "",
    "```" + POLICY_INFO_STRING,
    demoPolicyBlock(),
    "```",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Instances and the CLI
// ---------------------------------------------------------------------------

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Run {
  const env = { ...process.env };
  delete env["APPROVAL_AGENT"];
  env["APPROVAL_HUMAN"] = "human:demo";
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** The concrete bytes one seeded action commits to. */
function payloadOf(id: string): Record<string, unknown> {
  return { argv: ["echo", `hello from ${id}`] };
}

/**
 * One task envelope declaring one `exec.local` action.
 *
 * Reversible and cheap: this suite is about the queue, and an irreversibility
 * floor or a budget refusal firing first would prove something else. Nothing
 * here is ever granted, so nothing is ever executed — which is also the guest
 * surface's own promise.
 *
 * `payload_hash` is mandatory rather than decorative: amended SPEC §6.2 refuses
 * a manual request whose declaration has nothing to bind to (`payload-hash-
 * required`), so a crowd-demo envelope the operator seeds without one cannot be
 * requested at all. That is a fact the runbook has to carry, and it is pinned
 * here by the fact that these envelopes would not work without it.
 */
function taskFile(id: string): string {
  return [
    "---",
    `id: ${id}`,
    "title: A stranger asks",
    "approval:",
    "  origin:",
    "    app: crowd-demo",
    '    created_by: "human:demo"',
    "  state: proposed",
    "  actions:",
    `    - class: ${GUEST_CLASS}`,
    '      summary: "echo hello from the crowd"',
    "      reversible: true",
    '      est_cost_usd: "0"',
    `      idempotency_key: "${id}:echo"`,
    `      payload_hash: "${payloadHash(payloadOf(id))}"`,
    "---",
    "",
    "Body.",
    "",
  ].join("\n");
}

/**
 * A scratch gate instance running the DOCUMENTED demo policy, with `count` task
 * envelopes on disk.
 *
 * The envelopes are the operator's, exactly as they are on demo day: a guest
 * has no way to author a file on the host, so what a crowd can request is
 * whatever the operator seeded and nothing else. That is a property of the
 * demo's shape rather than of guest mode, and it is why the runbook tells the
 * operator to seed them.
 */
function newInstance(label: string, count: number): string {
  const dir = join(scratch, label);
  mkdirSync(dir, { recursive: true });
  assert.equal(runCli(["init", "--json"], dir).code, 0);
  writeFileSync(join(dir, "APPROVAL.md"), demoPolicyFile());
  const attested = runCli(["policy", "attest", "--as", "human:demo"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  for (let index = 1; index <= count; index += 1) {
    const id = taskId(index);
    writeFileSync(join(dir, `${id}.md`), taskFile(id));
    writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(payloadOf(id))}\n`);
  }
  return dir;
}

/** `task-01`, `task-02`, … — zero-padded so log order reads in file order. */
function taskId(index: number): string {
  return `task-${String(index).padStart(2, "0")}`;
}

/** Every record in an instance's log, in order. Read, never written. */
function logRecords(dir: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, ".approval", "log", "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// The guest surface
// ---------------------------------------------------------------------------

/** A guest listener on an ephemeral loopback port, against `dir`. */
async function listen(dir: string): Promise<McpHttpServer> {
  return await serveApprovalMcpHttp({
    actor: null,
    guest: true,
    port: 0,
    cwd: dir,
    notice: () => {},
  });
}

interface Guest {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

/** One connected stranger. The client's own name is a label and proves nothing. */
async function connect(server: McpHttpServer, name: string): Promise<Guest> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://${server.host}:${server.port}/mcp`),
  );
  const client = new Client({ name, version: "1" });
  // The SDK's own d.ts declares `sessionId` as `string | undefined`, which this
  // repo's `exactOptionalPropertyTypes` reads as a mismatch with `Transport`.
  await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
  return { client, transport };
}

async function disconnect(guest: Guest): Promise<void> {
  await guest.transport.terminateSession();
  await guest.client.close();
}

interface ToolAnswer {
  /** The `--json` object the verb printed: `{ok:true,…}` or `{ok:false,error:{…}}`. */
  structured: Record<string, unknown> | undefined;
  text: string;
  isError: boolean;
}

async function call(
  guest: Guest,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolAnswer> {
  const result = (await guest.client.callTool({ name, arguments: args })) as {
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

/** The `error` object of a refused tool answer. Fails the test if it passed. */
function refusalOf(answer: ToolAnswer): Record<string, unknown> {
  assert.equal(answer.isError, true, `expected a refusal, got: ${answer.text}`);
  const error = answer.structured?.["error"];
  assert.ok(
    typeof error === "object" && error !== null,
    `no machine-readable error in: ${answer.text}`,
  );
  return error as Record<string, unknown>;
}

/**
 * One stranger asks for one seeded action: `register`, then `request`.
 *
 * `--json` on both, so the answer a client branches on is the frozen object and
 * not prose. `register` is expected to succeed throughout: nothing about intake
 * limits touches it, which is itself worth seeing — the ceiling is on requests,
 * not on declarations.
 */
async function ask(guest: Guest, index: number): Promise<ToolAnswer> {
  const id = taskId(index);
  const registered = await call(guest, "register", {
    positionals: [`${id}.md`],
    flags: { "--json": true },
  });
  assert.equal(registered.isError, false, registered.text);
  return await call(guest, "request", {
    positionals: [id],
    flags: { "--action": `${id}:echo`, "--payload": `${id}.json`, "--json": true },
  });
}

// ---------------------------------------------------------------------------
// (1) the documented policy declares the crowd limits
// ---------------------------------------------------------------------------

test("the demo policy in provisioning.md declares the crowd-demo intake limits", () => {
  const load = loadPolicyText(PROVISIONING, demoPolicyFile());
  assert.equal(load.ok, true, load.ok ? "" : `${load.code}: ${load.message}`);
  if (!load.ok) return;
  const policy = load.policy;

  // Every class a guest can put in front of the human carries the per-origin
  // ceiling. `read.*` deliberately does not: an autonomous class returns
  // `proceed` before `request()` reaches the intake limits, so a number there
  // would be a ceiling in an attested file that nothing enforces.
  const manual = ["exec.local", "communicate.email.external", "policy.edit"];
  for (const name of manual) {
    const rule = policy.classes?.[name];
    assert.ok(rule !== undefined, `the demo policy no longer declares ${name}`);
    assert.equal(rule.autonomy, "manual", name);
    assert.equal(rule.limits?.["requests_per_hour"], PER_HOUR, `${name}.requests_per_hour`);
  }
  assert.equal(policy.classes?.["read.*"]?.autonomy, "autonomous");
  assert.equal(policy.classes?.["read.*"]?.limits, undefined);

  // The one class with a credential behind it keeps its own queue ceiling.
  assert.equal(policy.classes?.["communicate.email.external"]?.limits?.["max_pending"], 3);

  // And the whole queue is capped, whatever the class.
  assert.equal(policy.budgets?.["global"]?.["max_pending"], QUEUE_CEILING);
  assert.equal(policy.budgets?.["global"]?.["daily_actions"], 25);
});

// ---------------------------------------------------------------------------
// (2) it passes `approval policy check`
// ---------------------------------------------------------------------------

test("the demo policy passes `approval policy check` as provisioning.md prints it", () => {
  const dir = newInstance("policy-check", 0);

  // The discriminating check, and provisioning.md says why it is this one: an
  // unparseable policy fails closed to `manual` everywhere, so a class the
  // policy makes PERMISSIVE is the only one whose answer proves the file loaded.
  const permissive = runCli(["policy", "check", "read.files", "--reversible", "true"], dir);
  assert.equal(permissive.code, 0, permissive.stderr);
  assert.match(permissive.stdout, /winner: read\.\* -> autonomous/u);
  assert.match(permissive.stdout, /final: autonomous/u);

  const email = runCli(
    ["policy", "check", "communicate.email.external", "--reversible", "false"],
    dir,
  );
  assert.equal(email.code, 0, email.stderr);
  assert.match(email.stdout, /winner: communicate\.email\.external -> manual/u);
  assert.match(email.stdout, /final: manual/u);

  // The class the crowd beats use, and the one the limit tests below drive.
  const guestClass = runCli(["policy", "check", GUEST_CLASS, "--reversible", "true"], dir);
  assert.equal(guestClass.code, 0, guestClass.stderr);
  assert.match(guestClass.stdout, /final: manual/u);
});

// ---------------------------------------------------------------------------
// (3) rate-limited: one stranger, a fourth ask inside the hour
// ---------------------------------------------------------------------------

test("a guest's fourth request in an hour is refused rate-limited", async () => {
  const dir = newInstance("rate-limited", PER_HOUR + 1);
  const server = await listen(dir);
  try {
    const guest = await connect(server, "one-stranger");
    try {
      for (let index = 1; index <= PER_HOUR; index += 1) {
        const answer = await ask(guest, index);
        assert.equal(answer.isError, false, `ask ${index}: ${answer.text}`);
        assert.equal(answer.structured?.["requested"], true, `ask ${index}: ${answer.text}`);
      }

      const refused = await ask(guest, PER_HOUR + 1);
      const error = refusalOf(refused);
      assert.equal(error["code"], "rate-limited", refused.text);

      // The verdicts travel under their own key, so a client reads the ceiling
      // it crossed rather than parsing the sentence.
      const limits = error["limits"] as Array<Record<string, unknown>> | undefined;
      assert.ok(Array.isArray(limits), `no limits array in: ${refused.text}`);
      const failing = limits.filter((verdict) => verdict["pass"] === false);
      assert.deepEqual(
        failing.map((verdict) => [verdict["limit"], verdict["window"], verdict["ceiling"]]),
        [["requests_per_hour", "rolling-1h", PER_HOUR]],
        JSON.stringify(limits),
      );

      // Three asks, three requests, and every one of them under the session's
      // own server-minted identity. The fourth left no trace at all.
      const requested = logRecords(dir).filter(
        (record) => record["event"] === "approval.requested",
      );
      assert.equal(requested.length, PER_HOUR, JSON.stringify(requested.map((r) => r["seq"])));
      const actors = new Set(requested.map((record) => record["actor"] as string));
      assert.equal(actors.size, 1, JSON.stringify([...actors]));
      assert.ok([...actors][0]?.startsWith(GUEST_ACTOR_PREFIX), JSON.stringify([...actors]));
    } finally {
      await disconnect(guest);
    }
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// (4) queue-full: a crowd fills the shared queue
// ---------------------------------------------------------------------------

test("the eleventh pending request from a crowd is refused queue-full", async () => {
  const dir = newInstance("queue-full", QUEUE_CEILING + 1);
  const server = await listen(dir);
  const guests: Guest[] = [];
  try {
    // Four strangers, three asks each at most: the per-origin ceiling is what
    // makes a crowd necessary to reach the global one, which is the division of
    // labour between the two limits stated out loud.
    let index = 0;
    while (index < QUEUE_CEILING) {
      const guest = await connect(server, `stranger-${guests.length + 1}`);
      guests.push(guest);
      for (let asked = 0; asked < PER_HOUR && index < QUEUE_CEILING; asked += 1) {
        index += 1;
        const answer = await ask(guest, index);
        assert.equal(answer.isError, false, `ask ${index}: ${answer.text}`);
      }
    }

    const pending = logRecords(dir).filter((record) => record["event"] === "approval.requested");
    assert.equal(pending.length, QUEUE_CEILING, "the queue should be exactly at its ceiling");

    // A fresh stranger, whose own hour is untouched: the only ceiling left to
    // cross is the shared queue's.
    const latecomer = await connect(server, "latecomer");
    guests.push(latecomer);
    const refused = await ask(latecomer, QUEUE_CEILING + 1);
    const error = refusalOf(refused);
    assert.equal(error["code"], "queue-full", refused.text);

    const limits = error["limits"] as Array<Record<string, unknown>> | undefined;
    assert.ok(Array.isArray(limits), `no limits array in: ${refused.text}`);
    assert.deepEqual(
      limits
        .filter((verdict) => verdict["pass"] === false)
        .map((verdict) => [verdict["limit"], verdict["scope"], verdict["observed"]]),
      [["global.max_pending", "global", QUEUE_CEILING]],
      JSON.stringify(limits),
    );

    // The queue is where it was: a refused request appended nothing.
    assert.equal(
      logRecords(dir).filter((record) => record["event"] === "approval.requested").length,
      QUEUE_CEILING,
    );
  } finally {
    for (const guest of guests) await disconnect(guest);
    await server.close();
  }
});
