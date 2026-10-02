/**
 * `approval serve`: `propose`, `start` and `wait --timeout 0` over the agent
 * credential, and the unix-socket listen target (APRV-445).
 *
 * In-process `serveApproval`, real HTTP. The policy is attested through
 * `main`, and every record goes through the CLI's own append path.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { commandServe } from "../src/cli/serve.js";
import { main } from "../src/cli/main.js";
import { proposedTaskId } from "../src/core/gate.js";
import {
  AGENT_TOKEN_ENV,
  resolveServeCredentials,
  TENANT_TOKEN_ENV,
} from "../src/serve/credentials.js";
import {
  checkUnixSocketTarget,
  serveApproval,
  UNIX_SOCKET_MODE,
  type ServeHandle,
} from "../src/serve/server.js";

const AGENT_TOKEN = "agent-token-for-the-propose-suite-00";
const TENANT_TOKEN = "tenant-token-for-the-propose-suite-0";
const ACTOR = "agent:serve-propose";

// Short: a unix socket path is capped near 104 bytes on macOS.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "amd-sp-")));
let counter = 0;

after(() => rmSync(scratch, { recursive: true, force: true }));

const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "72h"',
  "  on_expiry: reject",
  "classes:",
  "  intent.publish.*:",
  "    autonomy: manual",
  "    agent_may_request: true",
  "  intent.publish.inferred.index:",
  "    autonomy: manual",
  "  intent.publish.stated.index:",
  "    autonomy: autonomous",
  "```",
  "",
].join("\n");

const quiet = { out: (): void => undefined, err: (): void => undefined };

async function ready(): Promise<string> {
  counter += 1;
  const dir = join(scratch, `c${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const code = await main(["policy", "attest", "--as", "human:alice"], { cwd: dir, streams: quiet });
  assert.equal(code, 0);
  return dir;
}

async function listener(dir: string, extra: { socketPath?: string } = {}): Promise<ServeHandle> {
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
    daemonId: "daemon-serve-propose",
    port: 0,
    ...extra,
  });
}

interface VerbAnswer {
  status: number;
  body: { stdout?: string; stderr?: string; exit_code?: number; error?: { code: string } };
}

async function verb(
  server: ServeHandle,
  name: string,
  token: string,
  args: unknown,
): Promise<VerbAnswer> {
  const response = await fetch(`http://${server.host}:${String(server.port)}/verb/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  return { status: response.status, body: (await response.json()) as VerbAnswer["body"] };
}

const TEXT = { text: "Looking for someone to cowork with on Thursdays" };

test("propose, wait --timeout 0 and start all answer the agent credential end to end", async () => {
  const dir = await ready();
  const server = await listener(dir);
  try {
    const key = "intent.publish.inferred.index:01928c3e-aaaa-7000-8000-000000000001";
    const proposed = await verb(server, "propose", AGENT_TOKEN, {
      flags: {
        "--class": "intent.publish.inferred.index",
        "--key": key,
        "--summary": "Publish an intention",
        "--payload-json": JSON.stringify(TEXT),
        "--json": true,
      },
    });
    assert.equal(proposed.status, 200);
    assert.equal(proposed.body.exit_code, 0, proposed.body.stderr ?? "");
    const answer = JSON.parse(proposed.body.stdout ?? "") as Record<string, unknown>;
    const task = proposedTaskId(ACTOR, "intent.publish.inferred.index", key);
    assert.equal(answer["task"], task);
    assert.equal(answer["decision"], "requested");

    // The poll answers at once while nobody has decided.
    const started = Date.now();
    const pending = await verb(server, "wait", AGENT_TOKEN, {
      positionals: [task],
      flags: { "--timeout": "0", "--json": true },
    });
    assert.equal(pending.body.exit_code, 6);
    assert.ok(Date.now() - started < 10_000);

    // A human decides, outside this transport.
    assert.equal(await main(["grant", key, "--as", "human:alice"], { cwd: dir, streams: quiet }), 0);

    const granted = await verb(server, "wait", AGENT_TOKEN, {
      positionals: [task],
      flags: { "--timeout": "0", "--json": true },
    });
    assert.equal(granted.body.exit_code, 0, granted.body.stderr ?? "");

    const spent = await verb(server, "start", AGENT_TOKEN, {
      positionals: [task],
      flags: { "--action": key, "--payload-json": JSON.stringify(TEXT), "--json": true },
    });
    assert.equal(spent.body.exit_code, 0, spent.body.stderr ?? "");
    assert.equal((JSON.parse(spent.body.stdout ?? "") as Record<string, unknown>)["authorization"], "grant");
  } finally {
    await server.close();
  }
});

test("propose over serve refuses an identity, a pinned path and an off-list flag", async () => {
  const dir = await ready();
  const server = await listener(dir);
  try {
    const base = {
      "--class": "intent.publish.stated.index",
      "--key": "k",
      "--summary": "s",
      "--payload-json": "{}",
    };
    const asFlag = await verb(server, "propose", AGENT_TOKEN, { flags: { ...base, "--as": "agent:other" } });
    assert.equal(asFlag.body.error?.code, "mcp-identity-fixed");
    const pinned = await verb(server, "propose", AGENT_TOKEN, { flags: { ...base, "--log": "/tmp/x" } });
    assert.equal(pinned.body.error?.code, "serve-path-pinned");
    const help = await verb(server, "propose", AGENT_TOKEN, { flags: { ...base, "--help": true } });
    assert.equal(help.body.error?.code, "serve-flag-not-permitted");
    // And the tenant credential cannot propose at all.
    const tenant = await verb(server, "propose", TENANT_TOKEN, { flags: base });
    assert.equal(tenant.status, 403);
    assert.equal(tenant.body.error?.code, "serve-tenant-forbidden");
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// The unix-socket listen target
// ---------------------------------------------------------------------------

async function overSocket(
  socketPath: string,
  path: string,
  token: string,
): Promise<{ status: number; body: string }> {
  return await new Promise((settle, fail) => {
    const req = httpRequest(
      { socketPath, path, method: "GET", headers: { authorization: `Bearer ${token}` } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => settle({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", fail);
    req.end();
  });
}

test("serve listens on a unix socket opened 0666, answers over it, and removes it on close", async () => {
  const dir = await ready();
  const socketPath = join(dir, "s.sock");
  const server = await listener(dir, { socketPath });
  try {
    assert.equal(server.socketPath, socketPath);
    assert.equal(server.host, `unix:${socketPath}`);
    assert.ok(lstatSync(socketPath).isSocket());
    assert.equal(statSync(socketPath).mode & 0o777, UNIX_SOCKET_MODE);
    const answer = await overSocket(socketPath, "/verbs", AGENT_TOKEN);
    assert.equal(answer.status, 200, answer.body);
    assert.ok(answer.body.includes("propose"));
    const refused = await overSocket(socketPath, "/verbs", "wrong-token-wrong-token-wrong-token");
    assert.equal(refused.status, 401);
  } finally {
    await server.close();
  }
  assert.equal(existsSync(socketPath), false, "the socket outlived its server");
});

test("a stale socket is replaced; a live one and a non-socket file are refused", async () => {
  const dir = await ready();
  const socketPath = join(dir, "stale.sock");

  // A server killed without closing leaves its socket file behind.
  const child = spawn(
    process.execPath,
    ["-e", `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => process.stdout.write("up"))`],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise<void>((settle) => child.stdout.once("data", () => settle()));
  const exited = new Promise<void>((settle) => child.on("exit", () => settle()));
  child.kill("SIGKILL");
  await exited;
  assert.ok(lstatSync(socketPath).isSocket(), "the killed server left no socket to replace");

  const server = await listener(dir, { socketPath });
  try {
    assert.equal((await overSocket(socketPath, "/verbs", AGENT_TOKEN)).status, 200);
    // A second server on the same path finds a LIVE socket and refuses it.
    await assert.rejects(listener(dir, { socketPath }), /live socket/u);
  } finally {
    await server.close();
  }

  const regular = join(dir, "not-a-socket");
  writeFileSync(regular, "precious", "utf8");
  assert.equal(checkUnixSocketTarget(regular).ok, false);
  await assert.rejects(listener(dir, { socketPath: regular }), /not a socket/u);
  assert.equal(existsSync(regular), true, "a regular file was destroyed");

  assert.equal(checkUnixSocketTarget("relative.sock").ok, false);
  assert.equal(checkUnixSocketTarget(join(dir, "missing-dir", "s.sock")).ok, false);

  // A live non-approval listener is refused too.
  const other = join(dir, "other.sock");
  const foreign = createServer();
  await new Promise<void>((settle) => foreign.listen(other, () => settle()));
  try {
    await assert.rejects(listener(dir, { socketPath: other }), /live socket/u);
  } finally {
    await new Promise<void>((settle) => foreign.close(() => settle()));
  }
});

test("a socket directory the serving uid does not own is refused, by the CLI before any bind", async () => {
  // The system temp root is owned by root, not by this test's uid.
  const shared = realpathSync("/tmp");
  if (typeof process.getuid !== "function" || process.getuid() === 0 || statSync(shared).uid === process.getuid()) {
    return;
  }
  const target = join(shared, `approval-md-not-mine-${String(process.pid)}.sock`);
  const verdict = checkUnixSocketTarget(target);
  assert.equal(verdict.ok, false);
  if (verdict.ok) throw new Error("unreachable");
  assert.match(verdict.message, /is owned by uid/u);

  const dir = await ready();
  let err = "";
  const env = { [AGENT_TOKEN_ENV]: AGENT_TOKEN, [TENANT_TOKEN_ENV]: TENANT_TOKEN, APPROVAL_AGENT: ACTOR };
  const byFlag = await commandServe(
    ["--listen", `unix:${target}`],
    { out: () => undefined, err: (text) => (err += text) },
    dir,
    env,
  );
  assert.equal(byFlag, 2, err);
  assert.match(err, /is owned by uid/u);

  // The environment spelling reaches the same check.
  err = "";
  const byEnv = await commandServe(
    [],
    { out: () => undefined, err: (text) => (err += text) },
    dir,
    { ...env, APPROVAL_SERVE_LISTEN: `unix:${target}` },
  );
  assert.equal(byEnv, 2, err);
  assert.match(err, /is owned by uid/u);
  assert.equal(existsSync(target), false);
});
