/**
 * `approval serve` — the transport, its two credentials, and the three things
 * it adds to the MCP surface (APRV-421).
 *
 * The harness-hook half of this verb has its own file (`serve-hook.test.ts`),
 * because that one is a table across every adapter and this one is about the
 * server. What is asserted here:
 *
 *   1. everything that can refuse refuses BEFORE the listener exists;
 *   2. the published catalog IS `approval mcp serve`'s tool list, compared
 *      entry for entry against `toolDefinitions()`, with `--as` gone and
 *      `grant` absent;
 *   3. both credential directions, each with its own code;
 *   4. `log/follow` pages, carries its cursor, and refuses a mismatched one
 *      with the integrity code and NO records — checked against what the real
 *      `approval log follow` prints for the same cursor;
 *   5. `export` carries the store and not the credentials;
 *   6. every refusal is a result body, and the server appends nothing.
 *
 * Nothing here hand-writes a log line: the policy is attested through the CLI
 * and every record goes through `core/log.ts`'s append path.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { commandServe } from "../src/cli/serve.js";
import { main } from "../src/cli/main.js";
import { appendEvent, type EventInput, type EventRecord } from "../src/core/log.js";
import { toolDefinitions } from "../src/mcp/server.js";
import { EXCLUDED_PREFIXES, readTarEntries } from "../src/serve/archive.js";
import {
  AGENT_TOKEN_ENV,
  MIN_TOKEN_LENGTH,
  resolveServeCredentials,
  TENANT_TOKEN_ENV,
} from "../src/serve/credentials.js";
import {
  AGENT_VERBS,
  serveApproval,
  serveCatalog,
  type ServeHandle,
} from "../src/serve/server.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const AGENT_TOKEN = "agent-token-for-the-serve-suite-0000";
const TENANT_TOKEN = "tenant-token-for-the-serve-suite-000";
const ACTOR = "agent:serve-test";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-serve-")));
let counter = 0;

after(() => rmSync(scratch, { recursive: true, force: true }));

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
  "```",
  "",
].join("\n");

const LOG = join(".approval", "log", "events.jsonl");

async function ready(): Promise<{ dir: string; logPath: string }> {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const code = await main(["policy", "attest", "--as", "human:alice"], {
    cwd: dir,
    streams: { out: () => undefined, err: () => undefined },
  });
  assert.equal(code, 0, "the scenario policy did not attest");
  return { dir, logPath: join(dir, LOG) };
}

/** Append one ordinary record through the real path. Never a hand-written line. */
function append(logPath: string, id: number): EventRecord {
  const input: EventInput = {
    ts: `2026-09-20T12:00:${String(id).padStart(2, "0")}Z`,
    event: "task.registered",
    actor: "agent:serve-test",
    task: `task-${String(id)}`,
    channel: "cli",
    payload: { title: `Task ${String(id)}` },
  };
  const result = appendEvent(logPath, input);
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) throw new Error("unreachable");
  return result.record;
}

async function listener(dir: string, extra: Partial<{ log: string }> = {}): Promise<ServeHandle> {
  const credentials = resolveServeCredentials({
    [AGENT_TOKEN_ENV]: AGENT_TOKEN,
    [TENANT_TOKEN_ENV]: TENANT_TOKEN,
  });
  assert.equal(credentials.ok, true);
  if (!credentials.ok) throw new Error("unreachable");
  return await serveApproval({
    actor: ACTOR,
    cwd: dir,
    credentials: credentials.credentials,
    daemonId: "daemon-serve-test",
    port: 0,
    ...extra,
  });
}

function url(server: ServeHandle, path: string): string {
  return `http://${server.host}:${String(server.port)}${path}`;
}

async function get(server: ServeHandle, path: string, token: string | null): Promise<Response> {
  return await fetch(url(server, path), {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

async function post(
  server: ServeHandle,
  path: string,
  token: string | null,
  body: unknown,
): Promise<Response> {
  return await fetch(url(server, path), {
    method: "POST",
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/**
 * Send request lines over a raw socket.
 *
 * `fetch` normalises a request before it goes out, so it cannot express the
 * two inputs the review found: a `Host` header that is not a host, and two
 * `Authorization` headers. Both are ordinary things a proxy or a hostile
 * client can put on the wire, so the test has to put them there too.
 */
async function rawRequest(
  server: ServeHandle,
  lines: readonly string[],
): Promise<{ statusLine: string; body: string }> {
  return await new Promise((settle, fail) => {
    const socket = connect(server.port, server.host, () => {
      socket.write(`${lines.join("\r\n")}\r\nConnection: close\r\n\r\n`);
    });
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      raw += chunk;
    });
    socket.on("error", fail);
    socket.on("close", () => {
      const split = raw.indexOf("\r\n\r\n");
      settle({
        statusLine: raw.split("\r\n", 1)[0] ?? "",
        body: split === -1 ? "" : raw.slice(split + 4),
      });
    });
  });
}

function digestOf(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "absent";
  }
}

function quiet(): { streams: { out: (t: string) => void; err: (t: string) => void }; err: () => string } {
  let err = "";
  return {
    streams: {
      out: () => undefined,
      err: (text: string) => {
        err += text;
      },
    },
    err: () => err,
  };
}

// ---------------------------------------------------------------------------
// 1. Startup: everything that can refuse refuses before the listener exists
// ---------------------------------------------------------------------------

const BOTH_TOKENS: NodeJS.ProcessEnv = {
  [AGENT_TOKEN_ENV]: AGENT_TOKEN,
  [TENANT_TOKEN_ENV]: TENANT_TOKEN,
};

test("serve refuses to start without both credentials, naming the one it wants", async () => {
  const { dir } = await ready();
  for (const [missing, env] of [
    [AGENT_TOKEN_ENV, { [TENANT_TOKEN_ENV]: TENANT_TOKEN }],
    [TENANT_TOKEN_ENV, { [AGENT_TOKEN_ENV]: AGENT_TOKEN }],
  ] as const) {
    const sink = quiet();
    const code = await commandServe(["--as", ACTOR], sink.streams, dir, env);
    assert.equal(code, 2, `a missing ${missing} must be a startup refusal`);
    assert.ok(sink.err().includes(missing), sink.err());
  }
});

test("serve refuses two credentials that are the same value, or one that is short", async () => {
  const { dir } = await ready();

  const same = quiet();
  assert.equal(
    await commandServe(["--as", ACTOR], same.streams, dir, {
      [AGENT_TOKEN_ENV]: AGENT_TOKEN,
      [TENANT_TOKEN_ENV]: AGENT_TOKEN,
    }),
    2,
  );
  assert.match(same.err(), /the same value/u);

  const short = quiet();
  assert.equal(
    await commandServe(["--as", ACTOR], short.streams, dir, {
      [AGENT_TOKEN_ENV]: "x".repeat(MIN_TOKEN_LENGTH - 1),
      [TENANT_TOKEN_ENV]: TENANT_TOKEN,
    }),
    2,
  );
  assert.match(short.err(), /shorter than/u);
});

test("serve refuses a human or system identity before anything is bound", async () => {
  const { dir } = await ready();
  for (const actor of ["human:carter", "system:daemon"]) {
    const sink = quiet();
    const code = await commandServe(["--as", actor], sink.streams, dir, BOTH_TOKENS);
    assert.equal(code, 2, `${actor} must be refused at startup`);
    assert.match(sink.err(), /--as expects agent:<id>/u);
  }
});

test("serve refuses a non-loopback bind unless the operator says so explicitly", async () => {
  const { dir } = await ready();

  const refused = quiet();
  assert.equal(
    await commandServe(["--as", ACTOR, "--listen", "0.0.0.0:4682"], refused.streams, dir, BOTH_TOKENS),
    2,
  );
  assert.match(refused.err(), /--allow-non-loopback/u);

  // `--port` cannot reach a non-loopback interface at all, which is what makes
  // the widening decision explicit rather than a typo away.
  const port = quiet();
  assert.equal(
    await commandServe(["--as", ACTOR, "--port", "70000"], port.streams, dir, BOTH_TOKENS),
    2,
  );
  assert.match(port.err(), /outside the TCP port range/u);
});

test("serve starts, prints the daemon instance id, answers, and stops on a signal", async () => {
  const { dir } = await ready();
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [CLI_ENTRY, "serve", "--as", ACTOR, "--port", "0"],
    {
      cwd: dir,
      env: { ...process.env, ...BOTH_TOKENS, APPROVAL_DAEMON_ID: "village-goa-1", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stderr = "";
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  const started = await new Promise<string>((settle, fail) => {
    const timer = setTimeout(() => fail(new Error(`serve never printed a started line: ${stderr}`)), 15_000);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      const line = /approval: serve on http:\/\/(?<host>[^:]+):(?<port>\d+)\//u.exec(stderr);
      if (line === null) return;
      clearTimeout(timer);
      settle(stderr);
    });
    child.on("error", fail);
  });

  try {
    // The id a record written under this process would carry, from the launch
    // environment, on the started line beside the identity and the store.
    assert.match(started, /daemon village-goa-1 \(environment\)/u);
    assert.ok(started.includes(ACTOR), started);

    const matched = /http:\/\/(?<host>[^:]+):(?<port>\d+)\//u.exec(started);
    assert.ok(matched?.groups !== undefined);
    const base = `http://${matched.groups["host"] as string}:${matched.groups["port"] as string}`;
    const response = await fetch(`${base}/verbs`, {
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
    });
    assert.equal(response.status, 200);
    const parsed = (await response.json()) as { actor: string; verbs: unknown[] };
    assert.equal(parsed.actor, ACTOR);
    assert.ok(parsed.verbs.length > 10);
  } finally {
    child.kill("SIGTERM");
  }

  const exit = await new Promise<number>((settle) => child.on("exit", (code) => settle(code ?? -1)));
  assert.equal(exit, 0, "a signal is a clean shutdown");
  assert.equal(stdout, "", "this verb writes nothing to stdout");
});

test("an invalid APPROVAL_DAEMON_ID stops the server starting at all", async () => {
  const { dir } = await ready();
  const sink = quiet();
  const code = await commandServe(["--as", ACTOR], sink.streams, dir, {
    ...BOTH_TOKENS,
    APPROVAL_DAEMON_ID: "Village GOA 1",
  });
  assert.equal(code, 2);
  assert.match(sink.err(), /not a usable daemon id/u);
});

// ---------------------------------------------------------------------------
// 2. The catalog IS the MCP tool list
// ---------------------------------------------------------------------------

test("the published verbs are approval mcp serve's tool list, entry for entry", () => {
  const catalog = serveCatalog();
  const tools = toolDefinitions();
  assert.equal(catalog.length, tools.length);
  for (const [index, entry] of catalog.entries()) {
    const tool = tools[index];
    assert.ok(tool !== undefined);
    assert.equal(entry.name, tool.name);
    assert.equal(entry.title, tool.title);
    assert.equal(entry.description, tool.description);
    assert.deepEqual(entry.inputSchema, tool.inputSchema);
  }
});

test("no published schema carries --as, and grant is absent", () => {
  const names = new Set(serveCatalog().map((entry) => entry.name));
  for (const withheld of ["grant", "reject", "revoke", "policy_attest", "expire"]) {
    assert.equal(names.has(withheld), false, `\`${withheld}\` must not be published`);
  }
  for (const entry of serveCatalog()) {
    const schema = entry.inputSchema as {
      properties?: { flags?: { properties?: Record<string, unknown> } };
    };
    assert.equal(
      "--as" in (schema.properties?.flags?.properties ?? {}),
      false,
      `${entry.name} publishes --as; identity is the server's and no call may name one`,
    );
  }
});

test("a call that names an identity is refused rather than quietly ignored", async () => {
  const { dir } = await ready();
  const server = await listener(dir);
  try {
    const response = await post(server, "/verb/request", AGENT_TOKEN, {
      flags: { "--as": "human:carter" },
    });
    const parsed = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(parsed.error.code, "mcp-identity-fixed");
    assert.match(parsed.error.message, /agent:serve-test/u);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Two credentials, two directions
// ---------------------------------------------------------------------------

/**
 * The allowlist, spelled out here as well as in the source.
 *
 * Two copies on purpose, which is the one place this repository wants them: a
 * change to what the party under oversight may do must be a diff in a test as
 * well as a diff in `src/serve/server.ts`, so it cannot ride along with an
 * unrelated edit. A verb added to the registry lands OUTSIDE this list and is
 * tenant-scoped, and the sweep below proves it is actually refused rather than
 * merely annotated.
 */
const EXPECTED_AGENT_VERBS = [
  "hook_classify",
  "instructions",
  "payload_agentmail-draft",
  "payload_hash",
  "request",
  "wait",
  "withdraw",
];

test("the agent allowlist is exactly the decided list, so a registry addition is loud", () => {
  assert.deepEqual([...AGENT_VERBS].sort(), EXPECTED_AGENT_VERBS);

  // And every name on it is a verb this surface actually publishes: an
  // allowlist entry matching nothing would be authority granted to a door that
  // does not exist, which is the quiet half of the same mistake.
  const published = new Set(serveCatalog().map((entry) => entry.name));
  for (const name of EXPECTED_AGENT_VERBS) {
    assert.ok(published.has(name), `the allowlist names ${name}, which is not published`);
  }
});

test("every published verb off the allowlist refuses the agent credential", async () => {
  const { dir } = await ready();
  const server = await listener(dir);
  try {
    const tenantScoped = serveCatalog().filter((entry) => !AGENT_VERBS.has(entry.name));
    // The sweep is worth nothing if it walks an empty list, and worth less if
    // the split has quietly become "almost everything is the agent's".
    assert.ok(
      tenantScoped.length > 20,
      `only ${String(tenantScoped.length)} published verbs are the tenant's`,
    );

    for (const entry of tenantScoped) {
      assert.equal(entry.scope, "tenant", `${entry.name} is annotated ${entry.scope}`);
      const response = await post(server, `/verb/${entry.name}`, AGENT_TOKEN, {});
      assert.equal(response.status, 403, `${entry.name} answered the agent credential`);
      const parsed = (await response.json()) as { error: { code: string } };
      assert.equal(parsed.error.code, "serve-agent-forbidden", entry.name);
    }
  } finally {
    await server.close();
  }
});

test("the verbs a harness needs to ask and to act on a grant DO answer the agent", async () => {
  const { dir } = await ready();
  const server = await listener(dir);
  try {
    for (const name of EXPECTED_AGENT_VERBS) {
      const response = await post(server, `/verb/${name}`, AGENT_TOKEN, {});
      // Whatever the verb makes of an empty argument object is the VERB's
      // answer. What must never come back is the scope refusal.
      assert.notEqual(response.status, 403, `${name} refused the agent credential`);
      const parsed = (await response.json()) as { error?: { code?: string } };
      assert.notEqual(parsed.error?.code, "serve-agent-forbidden", name);
    }
  } finally {
    await server.close();
  }
});

test("the agent credential never reaches the log, the export or status", async () => {
  const { dir } = await ready();
  const server = await listener(dir);
  try {
    for (const path of ["/log/follow", "/export", "/status"]) {
      const response = await get(server, path, AGENT_TOKEN);
      assert.equal(response.status, 403, `${path} answered the agent credential`);
      const parsed = (await response.json()) as { error: { code: string; message: string } };
      assert.equal(parsed.error.code, "serve-agent-forbidden", path);
      assert.match(parsed.error.message, /TENANT credential/u);
    }
    // And by the verb route as well, which is the door somebody would try
    // next: the two that return RECORDS, the tenant's own view of the
    // oversight the agent is under, and the four the review took off the agent
    // list (a head hash and a live window are facts about the log, and
    // `register`'s positional is a host path).
    for (const verb of [
      "status",
      "log_tail",
      "log_export",
      "queue",
      "log_verify",
      "gate_status",
      "policy_check",
      "policy_test",
      "register",
    ]) {
      const response = await post(server, `/verb/${verb}`, AGENT_TOKEN, {});
      assert.equal(response.status, 403, `${verb} answered the agent credential`);
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        "serve-agent-forbidden",
        verb,
      );
    }
  } finally {
    await server.close();
  }
});

test("the tenant credential never acts: request, wait and consume are refused", async () => {
  // `run` is deliberately NOT in this list any more: it spawns argv on the
  // daemon's machine, so it moved to the TENANT side with the rest of the
  // host-touching verbs, and the tenant credential is the one that may call
  // it. The verbs below are the gate sequence, which is the agent's alone.
  const { dir } = await ready();
  const server = await listener(dir);
  try {
    // `consume` is not even published, and it still gets the SCOPE answer
    // rather than a not-found: the authorization question is asked before the
    // routing one, and an unpublished name is an agent-side verb this surface
    // withholds for transport reasons rather than a door the tenant may probe.
    // `register` is NOT here any more: its positional is a host path, so the
    // review moved it to the tenant side and the hook endpoint became the
    // harness's way to register (it synthesises the envelope itself).
    for (const verb of ["request", "wait", "consume", "withdraw", "payload_hash"]) {
      const response = await post(server, `/verb/${verb}`, TENANT_TOKEN, {});
      assert.equal(response.status, 403, `${verb} answered the tenant credential`);
      const parsed = (await response.json()) as { error: { code: string; message: string } };
      assert.equal(parsed.error.code, "serve-tenant-forbidden", verb);
      assert.match(parsed.error.message, /AGENT credential/u);
    }
  } finally {
    await server.close();
  }
});

test("no credential opens nothing at all, including a path that does not exist", async () => {
  const { dir } = await ready();
  const server = await listener(dir);
  try {
    for (const path of ["/verbs", "/export", "/nowhere", "/log/follow"]) {
      const response = await get(server, path, null);
      assert.equal(response.status, 401, path);
      const parsed = (await response.json()) as { error: { code: string } };
      assert.equal(parsed.error.code, "serve-unauthorized", path);
    }
    const wrong = await get(server, "/verbs", "not-the-credential-but-long-enough-xx");
    assert.equal(wrong.status, 401);
  } finally {
    await server.close();
  }
});

test("the catalog answers either credential; status answers the tenant", async () => {
  const { dir } = await ready();
  const server = await listener(dir);
  try {
    for (const token of [AGENT_TOKEN, TENANT_TOKEN]) {
      assert.equal((await get(server, "/verbs", token)).status, 200);
    }
    const status = await get(server, "/status", TENANT_TOKEN);
    assert.equal(status.status, 200);
    const parsed = (await status.json()) as { exit_code: number; stdout: string };
    assert.equal(typeof parsed.exit_code, "number");
    // The verb's own `--json` object, on the stream it printed it on.
    const printed = JSON.parse(parsed.stdout.trim()) as Record<string, unknown>;
    assert.ok("ok" in printed || "head" in printed, parsed.stdout);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 4. log/follow
// ---------------------------------------------------------------------------

interface FollowBody {
  records: EventRecord[];
  cursor: { seq: number; hash: string | null };
  caught_up: boolean;
}

/** What `approval log follow` prints for this cursor, as whole lines. */
async function printedByTheCli(
  dir: string,
  args: string[],
  expected: number,
): Promise<string[]> {
  const child = spawn(process.execPath, [CLI_ENTRY, "log", "follow", "--json", ...args], {
    cwd: dir,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  try {
    await new Promise<void>((settle, fail) => {
      const timer = setTimeout(() => fail(new Error(`log follow printed ${out}`)), 15_000);
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
        if (out.split("\n").filter((line) => line.length > 0).length < expected) return;
        clearTimeout(timer);
        settle();
      });
      child.on("error", fail);
    });
  } finally {
    child.kill("SIGTERM");
  }
  return out.split("\n").filter((line) => line.length > 0);
}

test("log/follow returns the batch approval log follow prints, and carries the cursor", async () => {
  const { dir, logPath } = await ready();
  const first = append(logPath, 1);
  const second = append(logPath, 2);

  const server = await listener(dir);
  try {
    const response = await get(server, `/log/follow?from=${String(first.seq)}&cursor_hash=${first.hash}`, TENANT_TOKEN);
    assert.equal(response.status, 200);
    const page = (await response.json()) as FollowBody;

    const printed = await printedByTheCli(
      dir,
      ["--from", String(first.seq), "--cursor-hash", first.hash],
      1,
    );
    assert.deepEqual(
      page.records.map((record) => JSON.stringify(record)),
      printed,
      "a served batch is not the batch the CLI prints for the same cursor",
    );

    // The cursor is EXCLUSIVE, so the page starts after `first` and ends at the
    // head it actually read.
    assert.deepEqual(page.records.map((record) => record.seq), [second.seq]);
    assert.deepEqual(page.cursor, { seq: second.seq, hash: second.hash });
    assert.equal(page.caught_up, true);
  } finally {
    await server.close();
  }
});

test("log/follow pages: a limit stops short and says it is not caught up", async () => {
  const { dir, logPath } = await ready();
  for (let id = 1; id <= 4; id += 1) append(logPath, id);

  const server = await listener(dir);
  try {
    const first = (await (await get(server, "/log/follow?limit=2", TENANT_TOKEN)).json()) as FollowBody;
    assert.equal(first.records.length, 2);
    assert.equal(first.caught_up, false);

    const next = (await (
      await get(
        server,
        `/log/follow?from=${String(first.cursor.seq)}&cursor_hash=${String(first.cursor.hash)}`,
        TENANT_TOKEN,
      )
    ).json()) as FollowBody;
    assert.equal(next.caught_up, true);
    // The attestation plus four records: the two pages are the whole log, in
    // order, with nothing repeated and nothing skipped.
    assert.deepEqual(
      [...first.records, ...next.records].map((record) => record.seq),
      [1, 2, 3, 4, 5],
    );
  } finally {
    await server.close();
  }
});

test("log/follow refuses a cursor whose hash does not match, and returns no records", async () => {
  const { dir, logPath } = await ready();
  append(logPath, 1);
  append(logPath, 2);

  const server = await listener(dir);
  try {
    const response = await get(server, `/log/follow?from=1&cursor_hash=${"a".repeat(64)}`, TENANT_TOKEN);
    const parsed = (await response.json()) as {
      error: { code: string; message: string; reason: string | null };
      exit_code: number;
      records: unknown[];
    };
    assert.equal(parsed.error.code, "integrity", "the CLI's own code for this failure");
    assert.equal(parsed.error.reason, "cursor-mismatch");
    assert.deepEqual(parsed.records, [], "a failed batch emits no record from it");
    // The exit `approval log follow` would have carried for the same failure,
    // in the body where a client cannot miss it.
    assert.equal(parsed.exit_code, 1);
  } finally {
    await server.close();
  }
});

test("log/follow refuses a malformed cursor before it reads anything", async () => {
  const { dir } = await ready();
  const server = await listener(dir);
  try {
    for (const query of ["?from=x", "?from=1&cursor_hash=nope", "?cursor_hash=" + "a".repeat(64), "?limit=x"]) {
      const response = await get(server, `/log/follow${query}`, TENANT_TOKEN);
      assert.equal(response.status, 400, query);
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        "serve-invalid-cursor",
        query,
      );
    }
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 5. export
// ---------------------------------------------------------------------------

test("export carries the store and nothing that is a credential", async () => {
  const { dir, logPath } = await ready();
  append(logPath, 1);

  // The payload bytes behind a `payload_hash`. An archive that carried the
  // hashes and not these would be a chain of references to evidence the tenant
  // no longer holds, which is a receipt for an exit rather than an exit.
  mkdirSync(join(dir, ".approval", "payloads"), { recursive: true });
  writeFileSync(
    join(dir, ".approval", "payloads", "abc123.json"),
    '{"command":"the bytes a human approved"}',
    "utf8",
  );

  // The things an export must never carry, written into the store so their
  // absence is a fact about the archive rather than about the fixture.
  mkdirSync(join(dir, ".approval", "keys"), { recursive: true });
  writeFileSync(join(dir, ".approval", "keys", "sender.key"), "SECRET-KEY", "utf8");
  writeFileSync(join(dir, ".approval", "env"), "APPROVAL_TG_TOKEN=SECRET-TOKEN\n", "utf8");
  mkdirSync(join(dir, ".approval", "daemon"), { recursive: true });
  writeFileSync(join(dir, ".approval", "daemon", "state.json"), "{}", "utf8");
  writeFileSync(join(dir, ".approval", "vault.enc"), "SECRET-VAULT", "utf8");
  writeFileSync(join(dir, ".approval", "QUEUE.md"), "# Queue\n", "utf8");

  const server = await listener(dir);
  try {
    const response = await get(server, "/export", TENANT_TOKEN);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/gzip");

    const archive = readTarEntries(gunzipSync(Buffer.from(await response.arrayBuffer())));
    const paths = archive.map((entry) => entry.path).sort();
    assert.deepEqual(
      paths.filter((path) => !path.startsWith(".approval/payloads/")),
      [".approval/QUEUE.md", ".approval/log/events.jsonl", "APPROVAL.md"],
    );

    // The payloads, stated as their own assertion because they are what makes
    // this archive an exit rather than a receipt for one: the log records a
    // `payload_hash` per action, and these are the bytes those hashes name.
    const payloads = paths.filter((path) => path.startsWith(".approval/payloads/"));
    const fixture = archive.find((entry) => entry.path === ".approval/payloads/abc123.json");
    assert.ok(fixture !== undefined, "the export carries no payload bytes");
    assert.equal(fixture.data.toString("utf8"), '{"command":"the bytes a human approved"}');
    // And the one the RUNTIME wrote: attesting the policy stored its bytes
    // under a hash-named file, so this is the real thing rather than only the
    // fixture the test planted.
    assert.ok(
      payloads.some((path) => /\/[0-9a-f]{64}\.json$/u.test(path)),
      `no runtime-written payload in the archive: ${payloads.join(", ")}`,
    );

    for (const excluded of [...EXCLUDED_PREFIXES, ".approval/vault.enc"]) {
      assert.equal(
        paths.some((path) => path === excluded || path.startsWith(`${excluded}/`)),
        false,
        `the archive carries ${excluded}`,
      );
    }
    // Not only the paths: none of the secret BYTES are anywhere in the archive.
    const whole = Buffer.concat(archive.map((entry) => entry.data)).toString("utf8");
    for (const secret of ["SECRET-KEY", "SECRET-TOKEN", "SECRET-VAULT"]) {
      assert.equal(whole.includes(secret), false, `${secret} left the store`);
    }

    // Not the append lockfile either. The export takes that lock while it
    // walks, so it exists for exactly the span of the copy; an archive
    // carrying it would carry a file whose only meaning is "somebody was
    // reading when this was made".
    assert.equal(
      paths.some((path) => path.endsWith(".lock")),
      false,
      `the archive carries a lockfile: ${paths.join(", ")}`,
    );

    // And what it does carry is the store's own bytes, unchanged.
    const log = archive.find((entry) => entry.path === ".approval/log/events.jsonl");
    assert.ok(log !== undefined);
    assert.equal(log.data.toString("utf8"), readFileSync(logPath, "utf8"));
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 5b. The review's attack inputs, one test per finding
// ---------------------------------------------------------------------------

/** Finding 1. The archive-relative name was checked; the read followed the link. */
test("export: a symlink under the store refuses the whole export and names the link", async () => {
  const { dir, logPath } = await ready();
  append(logPath, 1);
  writeFileSync(join(dir, ".approval", "env"), "APPROVAL_TG_TOKEN=SECRET-TOKEN\n", "utf8");
  mkdirSync(join(dir, ".approval", "keys"), { recursive: true });
  writeFileSync(join(dir, ".approval", "keys", "sender.key"), "SECRET-KEY", "utf8");

  // The reviewer's two inputs: a link to credential material inside the store,
  // and a link straight out of it. Both sit under `.approval/log/` with names
  // the allowlist admits, which is the whole trick.
  symlinkSync(join(dir, ".approval", "keys", "sender.key"), join(dir, ".approval", "log", "note.jsonl"));

  const server = await listener(dir);
  try {
    const response = await get(server, "/export", TENANT_TOKEN);
    assert.equal(response.status, 409, "a store with a link in it must not export");
    const parsed = (await response.json()) as {
      error: { code: string; message: string };
      path: string;
      exit_code: number;
    };
    assert.equal(parsed.error.code, "serve-export-symlink");
    assert.equal(parsed.path, ".approval/log/note.jsonl", "the refusal names the link");
    assert.notEqual(parsed.exit_code, 0);
    // No archive at all: refused whole, never partially produced.
    assert.match(response.headers.get("content-type") ?? "", /application\/json/u);
    assert.equal(response.headers.get("x-approval-export-paths"), null);
    // And the secret is nowhere in the response.
    assert.equal(JSON.stringify(parsed).includes("SECRET-KEY"), false);
  } finally {
    await server.close();
  }
});

test("export: a symlink pointing outside the store is refused the same way", async () => {
  const { dir, logPath } = await ready();
  append(logPath, 1);
  const outside = join(scratch, `outside-${String(counter)}.txt`);
  writeFileSync(outside, "HOST-FILE-CONTENTS", "utf8");
  symlinkSync(outside, join(dir, ".approval", "log", "hosts.jsonl"));

  const server = await listener(dir);
  try {
    const response = await get(server, "/export", TENANT_TOKEN);
    assert.equal(response.status, 409);
    const parsed = (await response.json()) as { error: { code: string }; path: string };
    assert.equal(parsed.error.code, "serve-export-symlink");
    assert.equal(parsed.path, ".approval/log/hosts.jsonl");
    assert.equal(JSON.stringify(parsed).includes("HOST-FILE-CONTENTS"), false);
  } finally {
    await server.close();
  }
});

/**
 * Finding 2. The 413 that was an allow.
 *
 * A 1.1 MB hook envelope used to come back as a bare 413 with no exit code
 * anywhere, and a client following the documented rule read the missing header
 * as zero. Zero is ALLOW on Claude Code, Cursor, Codex and Muse.
 */
test("hook: an oversized envelope is a BLOCK in the harness's own dialect, never an allow", async () => {
  const { dir } = await ready();
  const server = await listener(dir);
  try {
    const oversized = JSON.stringify({ padding: "x".repeat(1_100_000) });
    for (const harness of ["claude-code", "cursor", "grok", "hermes"] as const) {
      const response = await fetch(url(server, `/hook/${harness}`), {
        method: "POST",
        headers: { authorization: `Bearer ${AGENT_TOKEN}` },
        body: oversized,
      });
      assert.equal(response.status, 413, harness);
      const parsed = (await response.json()) as {
        error: { code: string };
        exit_code: number;
        stdout: string;
      };
      assert.equal(parsed.error.code, "serve-body-too-large", harness);
      // The two halves that make this a block on every dialect at once.
      assert.notEqual(parsed.exit_code, 0, `${harness}: a refusal carried exit 0`);
      assert.ok(parsed.stdout.length > 0, `${harness}: no block directive`);
      const directive = JSON.parse(parsed.stdout) as Record<string, unknown>;
      if (harness === "claude-code") {
        const nested = directive["hookSpecificOutput"] as Record<string, unknown>;
        assert.equal(nested["permissionDecision"], "deny");
      } else if (harness === "cursor") {
        assert.equal(directive["permission"], "deny");
      } else if (harness === "grok") {
        assert.equal(directive["decision"], "deny");
      } else {
        assert.equal(directive["action"], "block");
      }
    }
  } finally {
    await server.close();
  }
});

test("every refusal on every route carries a non-zero exit code in the body", async () => {
  const { dir } = await ready();
  const server = await listener(dir);
  try {
    const refusals: Array<[string, Promise<Response>]> = [
      ["401", get(server, "/verbs", null)],
      ["403 agent", get(server, "/export", AGENT_TOKEN)],
      ["403 tenant", post(server, "/verb/request", TENANT_TOKEN, {})],
      ["404 path", get(server, "/nowhere", AGENT_TOKEN)],
      ["404 verb", post(server, "/verb/frobnicate", AGENT_TOKEN, {})],
      ["404 harness", post(server, "/hook/devin", AGENT_TOKEN, {})],
      ["405", post(server, "/export", TENANT_TOKEN, {})],
      ["400 cursor", get(server, "/log/follow?from=x", TENANT_TOKEN)],
    ];
    for (const [label, pending] of refusals) {
      const response = await pending;
      const parsed = (await response.json()) as { exit_code?: number; error?: { code?: string } };
      assert.equal(typeof parsed.exit_code, "number", `${label} carried no exit_code`);
      assert.notEqual(parsed.exit_code, 0, `${label} carried exit_code 0, which is an allow`);
      assert.equal(typeof parsed.error?.code, "string", label);
    }
  } finally {
    await server.close();
  }
});

/** Finding 3. The published `--log` that was a filesystem oracle. */
test("a caller may not name the store: --log, --dir and --policy are refused", async () => {
  const { dir } = await ready();
  const server = await listener(dir);
  try {
    // The reviewer's exact input, now on a tenant-scoped verb because the
    // review moved `log_verify` there; the guard runs in EVERY scope.
    const oracle = await post(server, "/verb/log_verify", TENANT_TOKEN, {
      flags: { "--log": "/etc/hosts" },
    });
    assert.equal(oracle.status, 403);
    const parsed = (await oracle.json()) as { error: { code: string }; exit_code: number };
    assert.equal(parsed.error.code, "serve-path-pinned");
    assert.notEqual(parsed.exit_code, 0);

    for (const flag of ["--dir", "--policy", "--log"]) {
      const response = await post(server, "/verb/log_verify", TENANT_TOKEN, {
        flags: { [flag]: dir },
      });
      assert.equal(response.status, 403, flag);
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        "serve-path-pinned",
        `${flag} must be refused even when it names the right store`,
      );
    }
  } finally {
    await server.close();
  }
});

test("a caller may not name a path outside the store, by flag or by positional", async () => {
  const { dir } = await ready();
  const server = await listener(dir);
  try {
    // The positional hole the review's fix did not reach: `payload hash`
    // names a host file and is on the agent allowlist.
    const positional = await post(server, "/verb/payload_hash", AGENT_TOKEN, {
      positionals: ["/etc/hosts"],
    });
    assert.equal(positional.status, 403);
    assert.equal(
      ((await positional.json()) as { error: { code: string } }).error.code,
      "serve-path-outside-store",
    );

    // And the same through a flag that is not one of the three pins.
    const flagged = await post(server, "/verb/request", AGENT_TOKEN, {
      positionals: ["task-1"],
      flags: { "--payload": "/etc/hosts" },
    });
    assert.equal(flagged.status, 403);
    assert.equal(
      ((await flagged.json()) as { error: { code: string } }).error.code,
      "serve-path-outside-store",
    );

    // A path INSIDE the store is still allowed, so the guard confines rather
    // than deletes the verb: this reaches `payload hash` and fails on the
    // file's contents, not on the transport.
    const inside = join(dir, "payload.json");
    writeFileSync(inside, '{"command":"ls"}', "utf8");
    const allowed = await post(server, "/verb/payload_hash", AGENT_TOKEN, {
      positionals: [inside],
    });
    assert.equal(allowed.status, 200);
    const body = (await allowed.json()) as { exit_code: number; stdout: string };
    assert.equal(body.exit_code, 0, body.stdout);
  } finally {
    await server.close();
  }
});

/** Finding 5. A resume without its hash is a replaced prefix served silently. */
test("log/follow: from>0 requires cursor_hash", async () => {
  const { dir, logPath } = await ready();
  append(logPath, 1);
  const server = await listener(dir);
  try {
    const response = await get(server, "/log/follow?from=1", TENANT_TOKEN);
    assert.equal(response.status, 400);
    const parsed = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(parsed.error.code, "serve-invalid-cursor");
    assert.match(parsed.error.message, /requires cursor_hash/u);

    // `from=0` is the one hashless form, because replaying from genesis binds
    // nothing and claims nothing.
    assert.equal((await get(server, "/log/follow?from=0", TENANT_TOKEN)).status, 200);
  } finally {
    await server.close();
  }
});

/** Finding 6. A number past the safe-integer range escaped as a 500. */
test("log/follow: an unrepresentable from is a cursor refusal, not a 500", async () => {
  const { dir } = await ready();
  const server = await listener(dir);
  try {
    const response = await get(
      server,
      `/log/follow?from=99999999999999999999&cursor_hash=${"a".repeat(64)}`,
      TENANT_TOKEN,
    );
    assert.equal(response.status, 400);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      "serve-invalid-cursor",
    );
  } finally {
    await server.close();
  }
});

/** A note: out-of-range limits were clamped silently. */
test("log/follow: limit=0 and an over-large limit are refused, not clamped", async () => {
  const { dir, logPath } = await ready();
  append(logPath, 1);
  const server = await listener(dir);
  try {
    for (const limit of ["0", "1001", "99999999999999999999"]) {
      const response = await get(server, `/log/follow?limit=${limit}`, TENANT_TOKEN);
      assert.equal(response.status, 400, limit);
      const parsed = (await response.json()) as { error: { code: string; message: string } };
      assert.equal(parsed.error.code, "serve-invalid-cursor", limit);
      assert.match(parsed.error.message, /limit expects 1 to 1000/u);
    }
    assert.equal((await get(server, "/log/follow?limit=1", TENANT_TOKEN)).status, 200);
  } finally {
    await server.close();
  }
});

/** Finding 7. `Host: [` reached `new URL()` before the credential check. */
test("a malformed request with no credential gets the 401 and nothing else", async () => {
  const { dir } = await ready();
  const server = await listener(dir);
  try {
    // Raw socket: `fetch` will not send a Host header this broken.
    const raw = await rawRequest(server, ["GET /verbs HTTP/1.1", "Host: ["]);
    assert.match(raw.statusLine, /^HTTP\/1\.1 401 /u, raw.statusLine);
    const parsed = JSON.parse(raw.body) as { error: { code: string }; exit_code: number };
    assert.equal(parsed.error.code, "serve-unauthorized");
    assert.notEqual(parsed.exit_code, 0);

    // With a credential, the same request is a malformed URL and says so.
    const authed = await rawRequest(server, [
      "GET /verbs HTTP/1.1",
      "Host: [",
      `Authorization: Bearer ${TENANT_TOKEN}`,
    ]);
    assert.match(authed.statusLine, /^HTTP\/1\.1 400 /u, authed.statusLine);
    assert.equal(
      (JSON.parse(authed.body) as { error: { code: string } }).error.code,
      "serve-malformed-url",
    );
  } finally {
    await server.close();
  }
});

/** A note: Node keeps the first Authorization header and discards the rest. */
test("two Authorization headers are refused rather than resolved", async () => {
  const { dir } = await ready();
  const server = await listener(dir);
  try {
    const raw = await rawRequest(server, [
      "GET /verbs HTTP/1.1",
      "Host: localhost",
      `Authorization: Bearer ${TENANT_TOKEN}`,
      "Authorization: Bearer not-the-credential-at-all-xxxx",
    ]);
    assert.match(raw.statusLine, /^HTTP\/1\.1 401 /u, raw.statusLine);
    const parsed = JSON.parse(raw.body) as { error: { code: string; message: string } };
    assert.equal(parsed.error.code, "serve-unauthorized");
    assert.match(parsed.error.message, /2 Authorization headers/u);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Refusal shape, and the server's own restraint
// ---------------------------------------------------------------------------

test("every refusal is a result body with a code, never a bare HTTP error", async () => {
  const { dir } = await ready();
  const server = await listener(dir);
  try {
    const refusals: Array<[string, Promise<Response>]> = [
      ["unauthorized", get(server, "/verbs", null)],
      ["unknown path", get(server, "/nowhere", AGENT_TOKEN)],
      ["unknown verb", post(server, "/verb/frobnicate", AGENT_TOKEN, {})],
      ["wrong method", post(server, "/export", TENANT_TOKEN, {})],
      ["scope", get(server, "/export", AGENT_TOKEN)],
    ];
    for (const [label, pending] of refusals) {
      const response = await pending;
      assert.ok(response.status >= 400, label);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/u, label);
      const parsed = (await response.json()) as { error?: { code?: string; message?: string } };
      assert.equal(typeof parsed.error?.code, "string", `${label} carried no machine-readable code`);
      assert.ok((parsed.error?.message ?? "").length > 0, `${label} carried no message`);
    }
  } finally {
    await server.close();
  }
});

test("a verb refusal keeps the CLI's own code rather than a transport one", async () => {
  const { dir } = await ready();
  const server = await listener(dir);
  try {
    const response = await post(server, "/verb/request", AGENT_TOKEN, {
      positionals: ["task-does-not-exist"],
    });
    assert.equal(response.status, 200, "a verb's refusal is an ANSWER, not a transport failure");
    const parsed = (await response.json()) as {
      exit_code: number;
      stdout: string;
      stderr: string;
    };
    // What `approval request` says about a call with no action key, in its own
    // vocabulary, on the stream it prints refusals on, with its own exit code.
    assert.equal(parsed.exit_code, 2);
    assert.equal(parsed.stdout, "");
    const refusal = JSON.parse(parsed.stderr.trim()) as { error: { code: string } };
    assert.equal(refusal.error.code, "usage");
  } finally {
    await server.close();
  }
});

test("the server appends no record on its own account", async () => {
  const { dir, logPath } = await ready();
  append(logPath, 1);
  const before = digestOf(logPath);

  const server = await listener(dir);
  try {
    await get(server, "/verbs", AGENT_TOKEN);
    await get(server, "/status", TENANT_TOKEN);
    await get(server, "/export", TENANT_TOKEN);
    await get(server, "/log/follow", TENANT_TOKEN);
    await get(server, "/nowhere", AGENT_TOKEN);
    await post(server, "/verb/frobnicate", AGENT_TOKEN, {});
    await get(server, "/export", AGENT_TOKEN);
  } finally {
    await server.close();
  }

  assert.equal(digestOf(logPath), before, "the log moved under a server that decided nothing");
});
