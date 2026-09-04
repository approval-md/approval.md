/**
 * The MCP wrapper (APRV-87) — SPEC.md §10.5's "same verbs as tools", pinned.
 *
 * The wrapper's whole claim is that it adds no surface: the tools ARE the
 * registry, the code path IS the CLI's, and the identity is the operator's. So
 * this suite tests the claim rather than the plumbing.
 *
 *  1. **The tool list is the filtered registry, exactly.** Not a superset, not a
 *     subset with a convenient extra. A human-only name sent as a tool call is
 *     an unknown tool, and the refusal says why.
 *  2. **Every inputSchema is the registry's**, with the one documented deletion
 *     of `--as`, asserted per tool by deriving the expectation here and
 *     `deepEqual`-ing it.
 *  3. **The answers are the CLI's answers.** Every round trip is compared
 *     against the same command run as a real child process against the same
 *     world, so a tool that started shaping its own JSON fails here.
 *  4. **Identity cannot be escalated**, at startup or per call.
 *  5. **A concurrent CLI append is safe**, and the chain verifies afterwards.
 *
 * No network: the two verbs that touch it (`doctor`, `adapter email`) are
 * published but never called. Nothing here writes a log line by hand; every
 * record under test is appended by the real CLI or by a tool call that runs it.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { VERB_REGISTRY, verbLabel, type VerbSpec } from "../src/cli/verb-registry.js";
import { runPayloadHash } from "../src/core/payload.js";
import {
  EXCLUDED_VERBS,
  GUEST_VERBS,
  resolveAgentActor,
  serveApprovalMcp,
  toolName,
  type ServerOptions,
} from "../src/mcp/server.js";

/** dist/tests/mcp-server.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const AGENT = "agent:probe";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-mcp-")));
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
  // `human:alice` since APRV-137: the scaffolded policy these worlds are built
  // from declares `approvers: [alice]` on `communicate.email.external`, and
  // that roster now binds the grant. The human half of these scenarios drives
  // the policy as the person it names; the agent half is unaffected, since
  // approvers restrict the grant alone.
  env["APPROVAL_HUMAN"] = "human:alice";
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** The command the `run` case spawns, and therefore what the action binds to. */
const CHILD = [process.execPath, "-e", "process.stdout.write('hello from the child')"];

/**
 * APRV-140: `approval run` recomputes the binding from the argv and cwd it will
 * spawn, so the declaration commits to {@link CHILD} in the world's directory.
 */
function taskFile(binding: string): string {
  return [
  "---",
  "id: task-mcp",
  "title: Chase the deposit",
  "approval:",
  "  origin:",
  "    app: mcp-test",
  '    created_by: "human:tester"',
  "  route:",
  '    assignee: "agent:probe"',
  "  state: proposed",
  "  actions:",
  "    - class: communicate.email.external",
  '      summary: "Send the chaser"',
  "      reversible: false",
  '      est_cost_usd: "0.02"',
  '      idempotency_key: "task-mcp:chaser"',
  `      payload_hash: "${binding}"`,
  "---",
  "",
  "Body.",
  "",
  ].join("\n");
}

/** A fresh initialised, attested world with the task file on disk. */
function newWorld(label: string): string {
  const dir = join(scratch, label);
  mkdirSync(dir, { recursive: true });
  assert.equal(runCli(["init", "--json"], dir).code, 0);
  assert.equal(runCli(["policy", "attest", "--json"], dir).code, 0);
  writeFileSync(join(dir, "task-mcp.md"), taskFile(runPayloadHash(CHILD, dir)));
  writeFileSync(join(dir, "payload.json"), '{"to":"b@example.com","subject":"hi"}\n');
  return dir;
}

/** An in-memory client/server pair against `dir`, closed by the caller. */
async function connect(
  dir: string,
  overrides: Partial<ServerOptions> = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await serveApprovalMcp(
    { actor: AGENT, cwd: dir, ...overrides },
    serverTransport,
  );
  const client = new Client({ name: "test", version: "1" });
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
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
  return {
    structured: result.structuredContent,
    text,
    isError: result.isError === true,
  };
}

/** The verbs the server should publish, derived here independently. */
function expectedVerbs(): VerbSpec[] {
  return VERB_REGISTRY.filter(
    (spec) => !spec.human_only && !EXCLUDED_VERBS.has(verbLabel(spec)),
  );
}

// ---------------------------------------------------------------------------
// (1) the tool list is the filtered registry
// ---------------------------------------------------------------------------

test("mcp: the tool list is the registry filtered by human_only, less the two exclusions", async () => {
  const dir = newWorld("list");
  const { client, close } = await connect(dir);
  try {
    const listed = (await client.listTools()).tools.map((tool) => tool.name).sort();
    const expected = expectedVerbs().map(toolName).sort();
    assert.deepEqual(listed, expected);

    // Named explicitly as well as derived, so a registry edit that flipped a
    // human_only marker cannot quietly agree with itself.
    assert.ok(listed.includes("register"));
    assert.ok(listed.includes("request"));
    assert.ok(listed.includes("wait"));
    assert.ok(listed.includes("queue"));
    assert.ok(listed.includes("status"));
    assert.ok(listed.includes("run"));
    assert.ok(listed.includes("payload_hash"));
    assert.ok(listed.includes("policy_test"));
    assert.ok(listed.includes("log_verify"));
    // APRV-238. The human's own words, published to the agent they were
    // written for. It is on this list for the same reason `journal_write` is:
    // an ungated channel that only one party can reach is not a channel, and
    // an MCP client is as much a session as a shell is.
    assert.ok(listed.includes("values"), "the values tool is not published");
    assert.ok(listed.includes("journal_write"));
    // APRV-239. Human-AUTHORED, agent-FACING: publishing it establishes no
    // authority, because what it prints decides nothing. `audit_review`, the
    // verb that WRITES a reaction, stays withheld below.
    assert.ok(listed.includes("feedback"));

    for (const withheld of [
      "grant",
      "reject",
      "revoke",
      "expire",
      "policy_attest",
      "policy_amend",
      "execution_resolve",
      "audit_review",
      "vault_set",
      "vault_list",
      "vault_remove",
      "env",
      "init",
      "setup_identity",
      "channel_cli",
      "channel_web",
      "channel_telegram_listen",
      "daemon_run",
      "mcp_serve",
      "consume",
      "hook_claude-code",
      "hook_cursor",
    ]) {
      assert.ok(!listed.includes(withheld), `"${withheld}" must not be a tool`);
    }
  } finally {
    await close();
  }
});

test("mcp: `values` is published in full mode and withheld from guests (APRV-238)", async () => {
  // Published, and its own instructions say what it is. The server-level
  // instruction string is the only place a client learns that this tool's
  // output is guidance and not permission, so it is asserted here rather than
  // being left to the guide the client may never call.
  const dir = newWorld("values-tool");
  const { client, close } = await connect(dir);
  try {
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "values");
    assert.ok(tool !== undefined, "the values tool is not published");
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /`values` prints the operator's stated preferences/u);
    assert.match(instructions, /guidance rather than policy/u);
  } finally {
    await close();
  }

  // Withheld from guests, and that is a decision rather than an omission: a
  // guest is somebody else's session on somebody else's queue, and the
  // operator's own stated values are not theirs to read. `journal_write` is
  // withheld for the mirrored reason, so the two are checked together.
  assert.ok(!GUEST_VERBS.has("values"), "`values` must not be in GUEST_VERBS");
  assert.ok(!GUEST_VERBS.has("journal write"), "`journal write` must not be in GUEST_VERBS");
});

test("mcp: the exclusions are agent-facing verbs, each with a stated reason", () => {
  for (const [label, reason] of EXCLUDED_VERBS) {
    const spec = VERB_REGISTRY.find((candidate) => verbLabel(candidate) === label);
    assert.ok(spec !== undefined, `"${label}" is excluded but is not a verb`);
    assert.equal(
      spec.human_only,
      false,
      `"${label}" is human_only; the registry already withholds it and the exclusion list must not restate that`,
    );
    assert.ok(reason.length > 40, `"${label}" is excluded without a reason`);
  }
  assert.deepEqual([...EXCLUDED_VERBS.keys()].sort(), ["consume", "hook claude-code", "hook cursor"]);
});

test("mcp: every tool's inputSchema is the registry's, with --as removed and nothing else", async () => {
  const dir = newWorld("schemas");
  const { client, close } = await connect(dir);
  try {
    const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    assert.equal(tools.size, expectedVerbs().length);

    for (const spec of expectedVerbs()) {
      const tool = tools.get(toolName(spec));
      assert.ok(tool !== undefined, `no tool for "${verbLabel(spec)}"`);

      const expected = structuredClone(spec.input) as {
        properties: { flags: { properties: Record<string, unknown> } };
      };
      delete expected.properties.flags.properties["--as"];

      assert.deepEqual(
        tool.inputSchema,
        expected,
        `the inputSchema of "${tool.name}" is not "${verbLabel(spec)}"'s registry input schema`,
      );
      assert.equal(tool.description, spec.purpose);
      assert.ok(
        !JSON.stringify(tool.inputSchema).includes("--as"),
        `"${tool.name}" publishes --as`,
      );
    }
  } finally {
    await close();
  }
});

test("mcp: tools/list appends nothing and creates no log", async () => {
  const dir = join(scratch, "readonly-list");
  mkdirSync(dir, { recursive: true });
  const { client, close } = await connect(dir);
  try {
    await client.listTools();
    await client.listTools();
  } finally {
    await close();
  }
  const verify = runCli(["log", "verify", "--json"], dir);
  assert.equal(verify.code, 0);
  assert.deepEqual(JSON.parse(verify.stdout.trim()), {
    status: "clean",
    records: 0,
    head: null,
  });
});

// ---------------------------------------------------------------------------
// (2) the answers are the CLI's answers
// ---------------------------------------------------------------------------

test("mcp: register, request, queue, wait, status and log verify round-trip as the CLI", async () => {
  const dir = newWorld("roundtrip");
  const { client, close } = await connect(dir);
  try {
    const registered = await call(client, "register", { positionals: ["task-mcp.md"] });
    assert.equal(registered.isError, false);
    assert.deepEqual(registered.structured, {
      ok: true,
      seq: 2,
      task: "task-mcp",
      actions: 1,
    });

    const requested = await call(client, "request", {
      positionals: ["task-mcp"],
      flags: { "--action": "task-mcp:chaser" },
    });
    assert.equal(requested.isError, false);
    assert.deepEqual(requested.structured, {
      ok: true,
      task: "task-mcp",
      action_key: "task-mcp:chaser",
      class: "communicate.email.external",
      autonomy: "manual",
      proceed: false,
      requested: true,
      seq: 3,
    });

    // The tool's answer and the CLI's answer are the same object, for a verb
    // that reads and one that reports health.
    // `ttl_remaining_ms` is a countdown, so it is the one field that must differ
    // between two readings; everything else must be identical.
    const untimed = (value: unknown): unknown => {
      const parsed = value as { pending: Array<Record<string, unknown>> };
      for (const entry of parsed.pending) delete entry["ttl_remaining_ms"];
      return parsed;
    };
    const queue = await call(client, "queue");
    assert.deepEqual(
      untimed(queue.structured),
      untimed(JSON.parse(runCli(["queue", "--json"], dir).stdout)),
    );
    assert.ok(
      typeof ((queue.structured ?? {})["pending"] as Array<Record<string, unknown>>)[0] ===
        "object",
    );

    const status = await call(client, "status");
    assert.deepEqual(status.structured, JSON.parse(runCli(["status", "--json"], dir).stdout));

    // The timeout path: exit 6 is an ANSWER, not an error result.
    const waited = await call(client, "wait", {
      positionals: ["task-mcp"],
      flags: { "--timeout": "200ms", "--interval": "50ms" },
    });
    assert.equal(waited.isError, false, "a timeout is an answer, not a tool error");
    assert.equal((waited.structured ?? {})["status"], "timeout");
    assert.equal((waited.structured ?? {})["ok"], false);

    const verified = await call(client, "log_verify");
    assert.equal(verified.isError, false);
    assert.equal((verified.structured ?? {})["status"], "clean");
    assert.deepEqual(
      verified.structured,
      JSON.parse(runCli(["log", "verify", "--json"], dir).stdout),
    );

    const hashed = await call(client, "payload_hash", { positionals: ["payload.json"] });
    assert.deepEqual(
      hashed.structured,
      JSON.parse(runCli(["payload", "hash", "payload.json", "--json"], dir).stdout),
    );

    const explained = await call(client, "policy_test", {
      positionals: ["communicate.email.external"],
      flags: { "--reversible": "false" },
    });
    assert.deepEqual(
      explained.structured,
      JSON.parse(
        runCli(
          ["policy", "test", "communicate.email.external", "--reversible", "false", "--json"],
          dir,
        ).stdout,
      ),
    );
  } finally {
    await close();
  }
});

test("mcp: the identity every append carries is the server's, not the caller's", async () => {
  const dir = newWorld("identity-recorded");
  const { client, close } = await connect(dir);
  try {
    await call(client, "register", { positionals: ["task-mcp.md"] });
  } finally {
    await close();
  }
  const exported = JSON.parse(runCli(["log", "export", "--json"], dir).stdout) as {
    records: Array<{ event: string; actor: string }>;
  };
  const registration = exported.records.find((record) => record.event === "task.registered");
  assert.ok(registration !== undefined);
  assert.equal(registration.actor, AGENT);
});

test("mcp: run executes behind the gate and pipes the child rather than the transport", async () => {
  const dir = newWorld("run");
  assert.equal(runCli(["register", "task-mcp.md", "--json"], dir).code, 0);
  assert.equal(
    runCli(["request", "task-mcp", "--action", "task-mcp:chaser", "--json"], dir).code,
    0,
  );
  const granted = runCli(["grant", "task-mcp:chaser", "--json"], dir);
  assert.equal(granted.code, 0);
  const token = (JSON.parse(granted.stdout.trim()) as { token: string }).token;

  const { client, close } = await connect(dir);
  try {
    const ran = await call(client, "run", {
      positionals: ["task-mcp:chaser"],
      flags: { "--token": token },
      trailing: CHILD,
    });
    assert.equal(ran.isError, false);
    assert.equal((ran.structured ?? {})["outcome"], "execution.completed");
    assert.equal((ran.structured ?? {})["exit_code"], 0);
    // The child's stdout came back as content instead of going down the wire.
    assert.ok(
      ran.text.includes("hello from the child"),
      `the child's output was not returned:\n${ran.text}`,
    );
  } finally {
    await close();
  }

  assert.equal(runCli(["log", "verify", "--json"], dir).code, 0);
});

// ---------------------------------------------------------------------------
// (3) refusals are results; unknown tools and bad arguments are protocol errors
// ---------------------------------------------------------------------------

test("mcp: a gate refusal is a tool result with isError and the CLI's own code", async () => {
  const dir = newWorld("refusal");
  const { client, close } = await connect(dir);
  try {
    // `request` against an action nobody registered: well-formed, and the
    // runtime says no.
    const refused = await call(client, "request", {
      positionals: ["task-mcp"],
      flags: { "--action": "task-mcp:chaser" },
    });
    assert.equal(refused.isError, true);
    const error = (refused.structured ?? {})["error"] as { code: string; message: string };
    assert.ok(error !== undefined, `no machine-readable error in ${refused.text}`);

    // The same command, as a real child process, refuses with the same code.
    const cli = runCli(["request", "task-mcp", "--action", "task-mcp:chaser", "--json"], dir);
    assert.notEqual(cli.code, 0);
    const cliError = (JSON.parse(cli.stderr.trim().split("\n").at(-1) ?? "{}") as {
      error: { code: string };
    }).error;
    assert.equal(error.code, cliError.code);
  } finally {
    await close();
  }
});

test("mcp: a human-only verb name is an unknown tool, and the refusal says why", async () => {
  const dir = newWorld("human-only");
  const { client, close } = await connect(dir);
  try {
    for (const name of ["grant", "policy_attest", "vault_list", "mcp_serve"]) {
      await assert.rejects(
        () => client.callTool({ name, arguments: { positionals: ["task-mcp:chaser"] } }),
        (cause: Error) => {
          assert.match(cause.message, /unknown tool/u);
          return true;
        },
        `"${name}" was not rejected as an unknown tool`,
      );
    }
    // The withheld-for-authority case names the reason.
    await assert.rejects(
      () => client.callTool({ name: "grant", arguments: {} }),
      /human's authority/u,
    );
  } finally {
    await close();
  }
});

test("mcp: a caller cannot supply an identity, in any shape", async () => {
  const dir = newWorld("no-escalation");
  const { client, close } = await connect(dir);
  try {
    await assert.rejects(
      () =>
        client.callTool({
          name: "register",
          arguments: { as: "human:carter", positionals: ["task-mcp.md"] },
        }),
      /mcp-unknown-property/u,
      "a top-level `as` must be refused",
    );
    await assert.rejects(
      () =>
        client.callTool({
          name: "register",
          arguments: { positionals: ["task-mcp.md"], flags: { "--as": "human:carter" } },
        }),
      /mcp-identity-fixed/u,
      "an `--as` flag must be refused",
    );
    await assert.rejects(
      () =>
        client.callTool({
          name: "queue",
          arguments: { flags: { "--not-a-flag": "x" } },
        }),
      /mcp-unknown-flag/u,
    );

    // Nothing was appended by any of the three.
    const verify = runCli(["log", "verify", "--json"], dir);
    assert.equal(verify.code, 0);
    assert.equal((JSON.parse(verify.stdout.trim()) as { records: number }).records, 1);
  } finally {
    await close();
  }
});

test("mcp: `-` (read stdin) is refused, because stdin is the transport", async () => {
  const dir = newWorld("stdin");
  const { client, close } = await connect(dir);
  try {
    await assert.rejects(
      () => client.callTool({ name: "payload_hash", arguments: { positionals: ["-"] } }),
      /mcp-stdin-unavailable/u,
    );
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// (4) identity at startup
// ---------------------------------------------------------------------------

test("mcp: the server identity is agent-only", () => {
  assert.deepEqual(resolveAgentActor("agent:probe", {}), { ok: true, actor: "agent:probe" });
  assert.deepEqual(resolveAgentActor(null, { APPROVAL_AGENT: "agent:env" }), {
    ok: true,
    actor: "agent:env",
  });

  for (const bad of ["human:carter", "system:gate", "probe", "", "  "]) {
    const outcome = resolveAgentActor(bad, {});
    assert.equal(outcome.ok, false, `"${bad}" must be refused`);
  }
  assert.equal(resolveAgentActor(null, {}).ok, false);

  // The flag beats the environment, so an operator can override a stale export.
  assert.deepEqual(resolveAgentActor("agent:flag", { APPROVAL_AGENT: "agent:env" }), {
    ok: true,
    actor: "agent:flag",
  });
});

test("mcp serve: a human identity is refused at startup, at exit 2", () => {
  const dir = newWorld("startup");
  for (const bad of ["human:carter", "system:gate"]) {
    const run = runCli(["mcp", "serve", "--as", bad, "--json"], dir);
    assert.equal(run.code, 2, `\`--as ${bad}\` must exit 2\n${run.stderr}`);
    const error = (JSON.parse(run.stderr.trim().split("\n").at(-1) ?? "{}") as {
      error: { code: string; message: string };
    }).error;
    assert.equal(error.code, "usage");
    assert.match(error.message, /agent:/u);
  }

  const missing = runCli(["mcp", "serve", "--json"], dir);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /APPROVAL_AGENT/u);
});

test("mcp serve: --help states what is not published, and why", () => {
  const help = runCli(["mcp", "serve", "--help"], scratch);
  assert.equal(help.code, 0);
  for (const phrase of [
    "AGENT SURFACE",
    "untrusted policy",
    "grant",
    "SPEC.md §11",
    "POST-V1",
    "tasks/elicitation",
    "READS NO .approval/env",
    "SERIALLY",
  ]) {
    assert.ok(help.stdout.includes(phrase), `the help never says "${phrase}"`);
  }
  assert.ok(runCli(["--help"], scratch).stdout.includes("mcp serve"));
});

// ---------------------------------------------------------------------------
// (5) concurrency, and (6) the real stdio child
// ---------------------------------------------------------------------------

test("mcp: a concurrent CLI append interleaves safely and the chain verifies", async () => {
  const dir = newWorld("concurrent");
  const { client, close } = await connect(dir);
  try {
    // Both writers append at the same time: the tool call registers the task,
    // a second CLI process attests the policy again. Both go through the core
    // lockfile and compare-and-append, so the chain must still be one chain.
    const viaTool = call(client, "register", { positionals: ["task-mcp.md"] });
    const viaCli = new Promise<Run>((settle) => {
      const env: NodeJS.ProcessEnv = { ...process.env, APPROVAL_HUMAN: "human:tester" };
      delete env["APPROVAL_AGENT"];
      const child = spawn(process.execPath, [CLI_ENTRY, "policy", "attest", "--json"], {
        cwd: dir,
        env,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("close", (code) => settle({ code: code ?? -1, stdout, stderr }));
    });

    const [tool, cli] = await Promise.all([viaTool, viaCli]);
    assert.equal(tool.isError, false, tool.text);
    assert.equal(cli.code, 0, cli.stderr);
  } finally {
    await close();
  }

  const verify = runCli(["log", "verify", "--json"], dir);
  assert.equal(verify.code, 0, `the chain did not verify:\n${verify.stdout}${verify.stderr}`);
  const parsed = JSON.parse(verify.stdout.trim()) as { status: string; records: number };
  assert.equal(parsed.status, "clean");
  assert.equal(parsed.records, 3);
});

test("mcp: tool calls run serially within one server", async () => {
  const dir = newWorld("serial");
  const { client, close } = await connect(dir);
  try {
    // Five appends fired at once. Serialization plus compare-and-append means
    // five distinct seqs and a clean chain, with no lost update.
    const files: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const name = `task-${index}.md`;
      writeFileSync(
        join(dir, name),
        taskFile(runPayloadHash(CHILD, dir))
          .replace("id: task-mcp", `id: task-${index}`)
          .replace('"task-mcp:chaser"', `"task-${index}:chaser"`),
      );
      files.push(name);
    }
    const answers = await Promise.all(
      files.map((file) => call(client, "register", { positionals: [file] })),
    );
    const seqs = answers.map((answer) => (answer.structured ?? {})["seq"]);
    assert.equal(new Set(seqs).size, 5, `duplicate seqs: ${JSON.stringify(seqs)}`);
    for (const answer of answers) assert.equal(answer.isError, false, answer.text);
  } finally {
    await close();
  }
  assert.equal(runCli(["log", "verify", "--json"], dir).code, 0);
});

test("mcp serve: a real child process speaks MCP over stdio end to end", async () => {
  const dir = newWorld("stdio-child");
  const env: NodeJS.ProcessEnv = { ...process.env, APPROVAL_AGENT: AGENT };
  delete env["APPROVAL_HUMAN"];

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_ENTRY, "mcp", "serve"],
    cwd: dir,
    env: env as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "stdio-test", version: "1" });
  await client.connect(transport);
  try {
    const listed = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(listed, expectedVerbs().map(toolName).sort());

    const registered = await call(client, "register", { positionals: ["task-mcp.md"] });
    assert.equal(registered.isError, false, registered.text);
    assert.equal((registered.structured ?? {})["task"], "task-mcp");

    const requested = await call(client, "request", {
      positionals: ["task-mcp"],
      flags: { "--action": "task-mcp:chaser" },
    });
    assert.equal(requested.isError, false, requested.text);
    assert.equal((requested.structured ?? {})["proceed"], false);

    const queue = await call(client, "queue");
    const pending = (queue.structured ?? {})["pending"] as Array<{ action_key: string }>;
    assert.deepEqual(
      pending.map((entry) => entry.action_key),
      ["task-mcp:chaser"],
    );

    await assert.rejects(() => client.callTool({ name: "grant", arguments: {} }), /unknown tool/u);
  } finally {
    await client.close();
  }

  const verify = runCli(["log", "verify", "--json"], dir);
  assert.equal(verify.code, 0, `${verify.stdout}${verify.stderr}`);
  const exported = JSON.parse(runCli(["log", "export", "--json"], dir).stdout) as {
    records: Array<{ event: string; actor: string }>;
  };
  for (const record of exported.records) {
    if (record.event === "task.registered" || record.event === "approval.requested") {
      assert.equal(record.actor, AGENT, `${record.event} was not recorded as the server's agent`);
    }
  }
});
