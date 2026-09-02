/**
 * `approval mcp serve --guest` — the allowlist, the call-time refusal and the
 * wait clamp (APRV-175).
 *
 * Guest mode is what lets strangers drive this gate over the network without
 * executing anything on the host, so the suite tests the three claims that make
 * that true, and tests them the way an attacker would:
 *
 *  1. **`tools/list` is exactly the allowlist.** Derived here from
 *     {@link GUEST_VERBS} independently, and named explicitly as well, so a
 *     widened list cannot quietly agree with itself.
 *  2. **The list is not the enforcement.** A crafted call to a withheld name is
 *     refused `mcp-guest-restricted` at CALL time, and a human-only name still
 *     gets the human-only refusal, which is true of every session on every
 *     transport.
 *  3. **A guest's `wait` is clamped**, in the argv the server builds and in the
 *     wall clock of a real ten-minute request that comes back in about five
 *     seconds.
 *
 * Full mode is checked alongside every one of those, because "guest mode
 * narrows" is a claim about both sides.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { VERB_REGISTRY, verbLabel } from "../src/cli/verb-registry.js";
import { runPayloadHash } from "../src/core/payload.js";
import {
  buildArgv,
  GUEST_INSTRUCTIONS,
  GUEST_VERBS,
  GUEST_WAIT_TIMEOUT_MS,
  guestWaitTimeout,
  publishedVerbs,
  serveApprovalMcp,
  toolName,
  type ServerOptions,
} from "../src/mcp/server.js";

/** dist/tests/mcp-guest.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const AGENT = "agent:guest-abc123";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-mcp-guest-")));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function runCli(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const env = { ...process.env };
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

/** The command the payload binding commits to. Nothing here ever spawns it. */
const CHILD = [process.execPath, "-e", "process.stdout.write('nothing')"];

function taskFile(binding: string): string {
  return [
    "---",
    "id: task-guest",
    "title: Ask the crowd",
    "approval:",
    "  origin:",
    "    app: mcp-guest-test",
    '    created_by: "human:tester"',
    "  route:",
    `    assignee: "${AGENT}"`,
    "  state: proposed",
    "  actions:",
    "    - class: communicate.email.external",
    '      summary: "Send the chaser"',
    "      reversible: false",
    '      est_cost_usd: "0.02"',
    '      idempotency_key: "task-guest:chaser"',
    `      payload_hash: "${binding}"`,
    "---",
    "",
    "Body.",
    "",
  ].join("\n");
}

let world: string | null = null;
/** One initialised, attested world with the task file on disk. */
function newWorld(label: string): string {
  const dir = join(scratch, label);
  mkdirSync(dir, { recursive: true });
  assert.equal(runCli(["init", "--json"], dir).code, 0);
  assert.equal(runCli(["policy", "attest", "--json"], dir).code, 0);
  writeFileSync(join(dir, "task-guest.md"), taskFile(runPayloadHash(CHILD, dir)));
  writeFileSync(join(dir, "payload.json"), '{"to":"b@example.com","subject":"hi"}\n');
  return dir;
}

/** A world shared by the cases that append nothing. */
function sharedWorld(): string {
  world ??= newWorld("shared");
  return world;
}

async function connect(
  dir: string,
  overrides: Partial<ServerOptions> = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await serveApprovalMcp(
    { actor: AGENT, cwd: dir, ...overrides },
    serverTransport,
  );
  const client = new Client({ name: "guest-test", version: "1" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
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

// ---------------------------------------------------------------------------
// (1) the tool list is exactly the allowlist
// ---------------------------------------------------------------------------

test("mcp guest: tools/list is exactly the allowlist", async () => {
  const dir = sharedWorld();
  const { client, close } = await connect(dir, { guest: true });
  try {
    const listed = (await client.listTools()).tools.map((tool) => tool.name).sort();

    const expected = VERB_REGISTRY.filter(
      (spec) => !spec.human_only && GUEST_VERBS.has(verbLabel(spec)),
    )
      .map(toolName)
      .sort();
    assert.deepEqual(listed, expected);

    // Named as well as derived.
    assert.deepEqual(listed, [
      "instructions",
      "log_verify",
      "policy_check",
      "policy_test",
      "queue",
      "register",
      "request",
      "status",
      "wait",
    ]);

    for (const withheld of [
      "run",
      "adapter_email",
      "token",
      "consume",
      "withdraw",
      "journal_write",
      "journal_read",
      "doctor",
      "payload_hash",
      "audit_list",
      "log_tail",
      "log_sync",
      "channel_telegram_health",
      "import_agents-md",
      "reindex",
      "render",
      "hook_classify",
      "grant",
      "vault_list",
    ]) {
      assert.ok(!listed.includes(withheld), `"${withheld}" must not be a guest tool`);
    }
  } finally {
    await close();
  }
});

test("mcp guest: the allowlist narrows the published list and never widens it", () => {
  const full = new Set(publishedVerbs().map(verbLabel));
  const guest = publishedVerbs(true).map(verbLabel);

  for (const label of guest) {
    assert.ok(full.has(label), `guest mode published "${label}", which full mode does not`);
    assert.ok(GUEST_VERBS.has(label), `"${label}" is not in the allowlist`);
  }
  assert.ok(guest.length < full.size, "guest mode published everything");

  // Every name in the allowlist is a verb that exists and is agent-facing, so
  // the list cannot rot into a set of strings that mean nothing.
  for (const label of GUEST_VERBS) {
    const spec = VERB_REGISTRY.find((candidate) => verbLabel(candidate) === label);
    assert.ok(spec !== undefined, `the allowlist names "${label}", which is not a verb`);
    assert.equal(spec.human_only, false, `"${label}" is human_only`);
  }
  assert.deepEqual([...GUEST_VERBS].sort(), [
    "instructions",
    "log verify",
    "policy check",
    "policy test",
    "queue",
    "register",
    "request",
    "status",
    "wait",
  ]);
});

test("mcp guest: full mode still publishes the whole agent surface", async () => {
  const dir = sharedWorld();
  const { client, close } = await connect(dir);
  try {
    const listed = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ["run", "token", "journal_write", "payload_hash", "adapter_email"]) {
      assert.ok(listed.includes(name), `full mode dropped "${name}"`);
    }
    assert.deepEqual(listed.sort(), publishedVerbs().map(toolName).sort());
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// (2) the advertised list is not the enforcement
// ---------------------------------------------------------------------------

test("mcp guest: a crafted call to a withheld verb is refused mcp-guest-restricted", async () => {
  const dir = sharedWorld();
  const { client, close } = await connect(dir, { guest: true });
  try {
    for (const name of ["run", "token", "adapter_email", "journal_write", "withdraw"]) {
      await assert.rejects(
        () => client.callTool({ name, arguments: { positionals: ["task-guest"] } }),
        (cause: Error) => {
          assert.match(cause.message, /mcp-guest-restricted/u);
          assert.match(cause.message, /GUEST mode/u);
          return true;
        },
        `"${name}" was not refused as guest-restricted`,
      );
    }
  } finally {
    await close();
  }
});

test("mcp guest: a human-only name keeps the human-only refusal, not the guest one", async () => {
  const dir = sharedWorld();
  const { client, close } = await connect(dir, { guest: true });
  try {
    for (const name of ["grant", "vault_list", "policy_attest"]) {
      await assert.rejects(
        () => client.callTool({ name, arguments: {} }),
        (cause: Error) => {
          assert.match(cause.message, /unknown tool/u);
          assert.doesNotMatch(cause.message, /mcp-guest-restricted/u);
          return true;
        },
        `"${name}" did not get the human-only refusal`,
      );
    }
    // And a name that is no verb at all is still just unknown.
    await assert.rejects(
      () => client.callTool({ name: "frobnicate", arguments: {} }),
      (cause: Error) => {
        assert.match(cause.message, /unknown tool/u);
        assert.doesNotMatch(cause.message, /mcp-guest-restricted/u);
        return true;
      },
    );
  } finally {
    await close();
  }
});

test("mcp guest: full mode runs the verbs a guest may not", async () => {
  const dir = sharedWorld();
  const { client, close } = await connect(dir);
  try {
    // `payload_hash` computes and writes nothing, which makes it the honest
    // probe: a guest is refused it, a full client gets an answer.
    const answer = await call(client, "payload_hash", { positionals: ["payload.json"] });
    assert.equal(answer.isError, false, answer.text);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// (3) the wait clamp
// ---------------------------------------------------------------------------

test("mcp guest: the clamp is a ceiling, not an override", () => {
  assert.equal(guestWaitTimeout({ "--timeout": "10m" }), `${GUEST_WAIT_TIMEOUT_MS}ms`);
  assert.equal(guestWaitTimeout({ "--timeout": "1h" }), `${GUEST_WAIT_TIMEOUT_MS}ms`);
  assert.equal(guestWaitTimeout({ "--timeout": "nonsense" }), `${GUEST_WAIT_TIMEOUT_MS}ms`);
  assert.equal(guestWaitTimeout(undefined), `${GUEST_WAIT_TIMEOUT_MS}ms`);
  assert.equal(guestWaitTimeout({}), `${GUEST_WAIT_TIMEOUT_MS}ms`);
  // A caller asking for less than the ceiling gets what they asked for.
  assert.equal(guestWaitTimeout({ "--timeout": "500ms" }), "500ms");
  assert.equal(guestWaitTimeout({ "--timeout": "2s" }), "2000ms");
});

test("mcp guest: the clamped timeout is appended last, so the caller's value loses", () => {
  const spec = VERB_REGISTRY.find((candidate) => verbLabel(candidate) === "wait");
  assert.ok(spec !== undefined);
  const options: ServerOptions = { actor: AGENT, cwd: scratch, guest: true };

  const built = buildArgv(spec, { positionals: ["task-guest"], flags: { "--timeout": "10m" } }, options);
  assert.ok(built.ok, built.ok ? "" : built.message);
  assert.deepEqual(built.argv.slice(0, 3), ["task-guest", "--timeout", "10m"]);
  const last = built.argv.lastIndexOf("--timeout");
  assert.equal(built.argv[last + 1], `${GUEST_WAIT_TIMEOUT_MS}ms`);
  assert.ok(last > 1, "the clamp was not appended after the caller's value");

  // Full mode injects no timeout at all: the CLI's own contract stands.
  const full = buildArgv(
    spec,
    { positionals: ["task-guest"], flags: { "--timeout": "10m" } },
    { actor: AGENT, cwd: scratch },
  );
  assert.ok(full.ok, full.ok ? "" : full.message);
  assert.equal(full.argv.filter((value) => value === "--timeout").length, 1);
  assert.ok(full.argv.includes("10m"));
});

test("mcp guest: a ten-minute wait comes back in about five seconds", async () => {
  const dir = newWorld("clamp");
  const { client, close } = await connect(dir, { guest: true });
  try {
    const registered = await call(client, "register", { positionals: ["task-guest.md"] });
    assert.equal(registered.isError, false, registered.text);

    const requested = await call(client, "request", {
      positionals: ["task-guest"],
      flags: { "--action": "task-guest:chaser" },
    });
    assert.equal(requested.isError, false, requested.text);
    assert.equal((requested.structured ?? {})["proceed"], false);

    // A live manual request nobody will decide: without the clamp this call
    // would hold the shared queue for ten minutes.
    const started = Date.now();
    const waited = await call(client, "wait", {
      positionals: ["task-guest"],
      flags: { "--timeout": "10m" },
    });
    const elapsed = Date.now() - started;

    assert.equal((waited.structured ?? {})["status"], "timeout", waited.text);
    assert.ok(
      elapsed < 60_000,
      `the wait was not clamped: it took ${elapsed}ms for a --timeout of 10m`,
    );
    assert.ok(
      elapsed >= GUEST_WAIT_TIMEOUT_MS - 1_000,
      `the wait returned in ${elapsed}ms, sooner than the clamp itself`,
    );
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// (4) what a guest is told
// ---------------------------------------------------------------------------

test("mcp guest: the instructions say wait returns fast and that nothing executes", async () => {
  const dir = sharedWorld();
  const { client, close } = await connect(dir, { guest: true });
  try {
    const instructions = client.getInstructions();
    assert.equal(instructions, GUEST_INSTRUCTIONS);
    for (const phrase of ["GUEST", "mcp-guest-restricted", "five seconds", "EXECUTES ANYWHERE"]) {
      assert.ok(
        (instructions ?? "").includes(phrase),
        `the guest instructions never say "${phrase}"`,
      );
    }
  } finally {
    await close();
  }
});

test("mcp guest: full mode keeps its own instructions", async () => {
  const dir = sharedWorld();
  const { client, close } = await connect(dir);
  try {
    const instructions = client.getInstructions() ?? "";
    assert.notEqual(instructions, GUEST_INSTRUCTIONS);
    assert.ok(instructions.includes("AGENT surface only"));
  } finally {
    await close();
  }
});
