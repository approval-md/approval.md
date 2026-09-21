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
  writeFileSync,
} from "node:fs";
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
import { serveCatalog, serveApproval, type ServeHandle } from "../src/serve/server.js";

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
    const response = await post(server, "/verb/queue", AGENT_TOKEN, {
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
    // And by the verb route as well, which is the door somebody would try next.
    const verb = await post(server, "/verb/status", AGENT_TOKEN, {});
    assert.equal(verb.status, 403);
    assert.equal(
      ((await verb.json()) as { error: { code: string } }).error.code,
      "serve-agent-forbidden",
    );
  } finally {
    await server.close();
  }
});

test("the tenant credential never acts: request, wait and consume are refused", async () => {
  const { dir } = await ready();
  const server = await listener(dir);
  try {
    // `consume` is not even published, and it still gets the SCOPE answer
    // rather than a not-found: the authorization question is asked before the
    // routing one, so a caller learns the true fact about itself.
    for (const verb of ["request", "wait", "consume", "run", "register"]) {
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
    const parsed = (await status.json()) as Record<string, unknown>;
    assert.ok("ok" in parsed || "head" in parsed, `status answered something else: ${JSON.stringify(parsed)}`);
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
      records: unknown[];
    };
    assert.equal(parsed.error.code, "integrity", "the CLI's own code for this failure");
    assert.equal(parsed.error.reason, "cursor-mismatch");
    assert.deepEqual(parsed.records, [], "a failed batch emits no record from it");
    // The exit `approval log follow` would have carried for the same failure.
    assert.equal(response.headers.get("x-approval-exit-code"), "1");
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
    assert.deepEqual(paths, [
      ".approval/QUEUE.md",
      ".approval/log/events.jsonl",
      "APPROVAL.md",
    ]);

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

    // And what it does carry is the store's own bytes, unchanged.
    const log = archive.find((entry) => entry.path === ".approval/log/events.jsonl");
    assert.ok(log !== undefined);
    assert.equal(log.data.toString("utf8"), readFileSync(logPath, "utf8"));
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
    const response = await post(server, "/verb/wait", AGENT_TOKEN, {
      positionals: ["task-does-not-exist"],
      flags: { "--timeout": "1ms" },
    });
    const parsed = (await response.json()) as Record<string, unknown>;
    // Whatever `approval wait` says about an unknown task, it says it here, in
    // its own vocabulary, with its own exit code beside it.
    assert.ok(response.headers.get("x-approval-exit-code") !== null);
    assert.ok("error" in parsed || "status" in parsed, JSON.stringify(parsed));
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
