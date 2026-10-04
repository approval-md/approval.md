/**
 * `approval serve` stamps the daemon id and is held to the `daemons` allowlist
 * (APRV-448).
 *
 * APRV-383 gave records a `daemon` field and policies a `daemons` list, and only
 * the daemon loop declared an identity, so everything `approval serve` appended
 * (its verbs on the listener's thread and its hook calls on worker threads)
 * carried no field and met no list. What is asserted here:
 *
 *   1. a verb call's records carry the id `approval status` reports for the
 *      same store, derived when the launch environment declares none and the
 *      declared one when it does;
 *   2. a hook call's records, appended on a worker thread with its own copy of
 *      every module, carry the same id;
 *   3. an attested `daemons` list that does not admit the id refuses the append
 *      `daemon-not-allowed` on both routes with the log byte-identical, and a
 *      list a human narrows while the server runs takes effect on the next call;
 *   4. the server never marks itself the daemon, so the daemon's own advance
 *      route stays the daemon's.
 *
 * In-process `serveApproval`, real HTTP. Every policy is attested through the
 * CLI and every record goes through the real append path. The listener's
 * declaration is module state of THIS process, so it is cleared after every
 * case: otherwise the next case's own attestation would be judged as the
 * previous server's append.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli/main.js";
import { isDaemonProcess } from "../src/core/daemon-actor.js";
import { derivedDaemonId } from "../src/core/daemon-host.js";
import { clearDaemonIdentity, DAEMON_ID_ENV, daemonIdentity } from "../src/core/daemon-identity.js";
import type { EventRecord } from "../src/core/log.js";
import { readVerifiedRecords } from "../src/core/state.js";
import {
  AGENT_TOKEN_ENV,
  resolveServeCredentials,
  TENANT_TOKEN_ENV,
} from "../src/serve/credentials.js";
import { serveApproval, type ServeHandle } from "../src/serve/server.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const AGENT_TOKEN = "agent-token-for-the-stamp-suite-0000";
const TENANT_TOKEN = "tenant-token-for-the-stamp-suite-000";
const ACTOR = "agent:serve-stamp";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "amd-stamp-")));
let counter = 0;

after(() => rmSync(scratch, { recursive: true, force: true }));

afterEach(() => {
  clearDaemonIdentity();
});

const quiet = { out: (): void => undefined, err: (): void => undefined };

function policyText(daemons: readonly string[] | null): string {
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    '  approval_ttl: "72h"',
    "  on_expiry: reject",
    ...(daemons === null ? [] : ["daemons:", ...daemons.map((id) => `  - ${id}`)]),
    "read_scope:",
    "  roots: []",
    "classes:",
    "  read.*:",
    "    autonomy: autonomous",
    "  files.write.workspace:",
    "    autonomy: autonomous",
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
}

/** A store with an attested policy. Attested BEFORE any server declares anything. */
async function ready(daemons: readonly string[] | null = null): Promise<{ dir: string; logPath: string }> {
  counter += 1;
  const dir = join(scratch, `c${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), policyText(daemons), "utf8");
  const code = await main(["policy", "attest", "--as", "human:alice"], { cwd: dir, streams: quiet });
  assert.equal(code, 0, "the scenario policy did not attest");
  return { dir, logPath: join(dir, ".approval", "log", "events.jsonl") };
}

async function listener(dir: string, env: NodeJS.ProcessEnv): Promise<ServeHandle> {
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
    env,
    port: 0,
  });
}

interface Answer {
  status: number;
  body: { stdout?: string; stderr?: string; exit_code?: number; error?: { code: string } };
}

async function verb(server: ServeHandle, name: string, args: unknown): Promise<Answer> {
  const response = await fetch(`http://${server.host}:${String(server.port)}/verb/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${AGENT_TOKEN}` },
    body: JSON.stringify(args),
  });
  return { status: response.status, body: (await response.json()) as Answer["body"] };
}

async function hook(server: ServeHandle, harness: string, body: unknown): Promise<Answer> {
  const response = await fetch(`http://${server.host}:${String(server.port)}/hook/${harness}`, {
    method: "POST",
    headers: { authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Answer["body"] };
}

function recordsOf(logPath: string): EventRecord[] {
  const read = readVerifiedRecords(logPath);
  assert.equal(read.ok, true, read.ok ? "" : read.code);
  return read.ok ? [...read.records] : [];
}

function digestOf(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The verb's own JSON refusal, as it printed it: `append-failed`, with the
 * write boundary's code under `append` so a caller can branch on it.
 */
function appendRefusalOf(answer: Answer): { code?: string; append?: string; message?: string } {
  const line = (answer.body.stderr ?? "").trim().split("\n").at(-1) ?? "";
  const parsed = JSON.parse(line) as { error?: { code?: string; append?: string; message?: string } };
  return parsed.error ?? {};
}

/** The id `approval status --json` reports for this store, run in a fresh process. */
function statusId(dir: string, env: NodeJS.ProcessEnv): string {
  const run = spawnSync(process.execPath, [CLI_ENTRY, "status", "--json"], {
    cwd: dir,
    env: { ...process.env, [DAEMON_ID_ENV]: "", ...env },
    encoding: "utf8",
  });
  const report = JSON.parse(run.stdout) as { daemon?: { id?: unknown } };
  assert.equal(typeof report.daemon?.id, "string", `status reported no daemon id: ${run.stdout}${run.stderr}`);
  return report.daemon?.id as string;
}

/** A manual-class proposal: registers and requests, and nothing waits on it. */
function proposal(key: string): unknown {
  return {
    flags: {
      "--class": "intent.publish.inferred.index",
      "--key": key,
      "--summary": "Publish an intention",
      "--payload-json": JSON.stringify({ text: "cowork on Thursdays" }),
      "--json": true,
    },
  };
}

/** Codex's `apply_patch`, which the policy above makes autonomous: it appends on the hook thread. */
function codexPatch(dir: string, file: string): unknown {
  return {
    hook_event_name: "PreToolUse",
    session_id: "stamp-session",
    tool_use_id: `stamp-${file}`,
    cwd: dir,
    tool_name: "apply_patch",
    tool_input: { command: `*** Begin Patch\n*** Add File: ${file}\n+hello\n*** End Patch\n` },
  };
}

// ---------------------------------------------------------------------------
// 1. Verbs carry the status id
// ---------------------------------------------------------------------------

test("verb calls through serve carry the derived id approval status reports", async () => {
  const { dir, logPath } = await ready();
  const reported = statusId(dir, {});
  assert.equal(reported, derivedDaemonId(logPath), "status and the derivation disagree before serve starts");

  // No APPROVAL_DAEMON_ID: the id derives from the store's instance, exactly as
  // the daemon loop's would for the same store.
  const server = await listener(dir, {});
  const before = recordsOf(logPath).length;
  try {
    assert.equal(server.daemonId, reported);
    const proposed = await verb(server, "propose", proposal("intent.publish.inferred.index:stamp-1"));
    assert.equal(proposed.body.exit_code, 0, proposed.body.stderr ?? "");
    const task = (JSON.parse(proposed.body.stdout ?? "") as { task: string }).task;

    const withdrawn = await verb(server, "withdraw", {
      positionals: [task],
      flags: { "--action": "intent.publish.inferred.index:stamp-1", "--reason": "cancelled", "--json": true },
    });
    assert.equal(withdrawn.body.exit_code, 0, withdrawn.body.stderr ?? "");

    // An autonomous proposal, spent through `start`: the execution record is
    // written by this transport too.
    const stated = await verb(server, "propose", {
      flags: {
        "--class": "intent.publish.stated.index",
        "--key": "intent.publish.stated.index:stamp-2",
        "--summary": "Publish a stated intention",
        "--payload-json": JSON.stringify({ text: "x" }),
        "--json": true,
      },
    });
    assert.equal(stated.body.exit_code, 0, stated.body.stderr ?? "");
    const statedTask = (JSON.parse(stated.body.stdout ?? "") as { task: string }).task;
    const started = await verb(server, "start", {
      positionals: [statedTask],
      flags: {
        "--action": "intent.publish.stated.index:stamp-2",
        "--payload-json": JSON.stringify({ text: "x" }),
        "--json": true,
      },
    });
    assert.equal(started.body.exit_code, 0, started.body.stderr ?? "");
  } finally {
    await server.close();
  }

  const appended = recordsOf(logPath).slice(before);
  const events: string[] = appended.map((record) => record.event);
  for (const expected of ["approval.requested", "approval.withdrawn", "execution.started"]) {
    assert.ok(events.includes(expected), `serve wrote no ${expected}: ${events.join(", ")}`);
  }
  for (const record of appended) {
    assert.equal(record.daemon, reported, `${record.event} (seq ${String(record.seq)}) is not stamped`);
  }
  // The attestation was written before any server existed, by a human's CLI
  // call, and carries nothing: the field is the writing process's, not the store's.
  assert.equal("daemon" in (recordsOf(logPath)[0] as EventRecord), false);
});

test("a declared APPROVAL_DAEMON_ID is the stamped id, and the one status reports", async () => {
  const { dir, logPath } = await ready();
  const declared = { [DAEMON_ID_ENV]: "village-goa-1" };
  assert.equal(statusId(dir, declared), "village-goa-1");

  const server = await listener(dir, declared);
  const before = recordsOf(logPath).length;
  try {
    assert.equal(server.daemonId, "village-goa-1");
    const proposed = await verb(server, "propose", proposal("intent.publish.inferred.index:declared"));
    assert.equal(proposed.body.exit_code, 0, proposed.body.stderr ?? "");
  } finally {
    await server.close();
  }
  const appended = recordsOf(logPath).slice(before);
  assert.ok(appended.length > 0);
  for (const record of appended) assert.equal(record.daemon, "village-goa-1");
});

test("an unusable declared id is refused before serve binds", async () => {
  const { dir } = await ready();
  await assert.rejects(
    listener(dir, { [DAEMON_ID_ENV]: "Village GOA 1" }),
    /not a usable daemon id/u,
  );
});

// ---------------------------------------------------------------------------
// 2. The hook route, on its worker thread, carries the same id
// ---------------------------------------------------------------------------

test("a hook call's records, appended on a worker thread, carry the same id", async () => {
  const { dir, logPath } = await ready();
  const server = await listener(dir, {});
  const before = recordsOf(logPath).length;
  try {
    const answer = await hook(server, "codex", codexPatch(dir, "notes.md"));
    assert.equal(answer.status, 200);
    assert.equal(answer.body.exit_code, 0, answer.body.stderr ?? "");
    // And a verb beside it, so the two threads are compared in one store.
    const proposed = await verb(server, "propose", proposal("intent.publish.inferred.index:beside-hook"));
    assert.equal(proposed.body.exit_code, 0, proposed.body.stderr ?? "");
  } finally {
    await server.close();
  }
  const appended = recordsOf(logPath).slice(before);
  const fromHook = appended.filter((record) => record.event === "execution.started");
  assert.ok(fromHook.length > 0, `the hook appended nothing: ${appended.map((r) => r.event).join(", ")}`);
  for (const record of appended) {
    assert.equal(record.daemon, derivedDaemonId(logPath), `${record.event} is not stamped`);
  }
});

// ---------------------------------------------------------------------------
// 3. The allowlist, at the write boundary, through serve
// ---------------------------------------------------------------------------

test("a daemons list that excludes the id refuses a verb's append, writing nothing", async () => {
  const { dir, logPath } = await ready(["village-goa-2"]);
  const server = await listener(dir, { [DAEMON_ID_ENV]: "village-goa-1" });
  const before = digestOf(logPath);
  try {
    const refused = await verb(server, "propose", proposal("intent.publish.inferred.index:refused"));
    assert.notEqual(refused.body.exit_code, 0, "an unlisted daemon's append went through");
    const error = appendRefusalOf(refused);
    assert.equal(error.code, "append-failed", refused.body.stderr ?? "");
    assert.equal(error.append, "daemon-not-allowed", refused.body.stderr ?? "");
    assert.match(error.message ?? "", /village-goa-1/u);
  } finally {
    await server.close();
  }
  assert.equal(digestOf(logPath), before, "the log changed under a refused append");
});

test("a daemons list that excludes the id refuses a hook's append, and the hook blocks", async () => {
  const { dir, logPath } = await ready(["village-goa-2"]);
  const server = await listener(dir, { [DAEMON_ID_ENV]: "village-goa-1" });
  const before = digestOf(logPath);
  try {
    const answer = await hook(server, "codex", codexPatch(dir, "refused.md"));
    assert.equal(answer.status, 200);
    // Codex's dialect carries the verdict in the body at exit 0: whatever the
    // route said, it is not an allow.
    const verdict = JSON.parse(answer.body.stdout ?? "{}") as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    assert.notEqual(verdict.hookSpecificOutput?.permissionDecision, "allow", answer.body.stdout ?? "");
    assert.match(
      `${answer.body.stdout ?? ""}${answer.body.stderr ?? ""}`,
      /daemon-not-allowed|may not write to this log/u,
    );
  } finally {
    await server.close();
  }
  assert.equal(digestOf(logPath), before, "the log changed under a refused hook append");
});

test("a list a human narrows while serve runs refuses the very next call", async () => {
  const { dir, logPath } = await ready(["village-goa-1"]);
  const server = await listener(dir, { [DAEMON_ID_ENV]: "village-goa-1" });
  try {
    const admitted = await verb(server, "propose", proposal("intent.publish.inferred.index:admitted"));
    assert.equal(admitted.body.exit_code, 0, admitted.body.stderr ?? "");

    // The human narrows the list and re-attests in their own process, which
    // declares nothing, while the server keeps running.
    writeFileSync(join(dir, "APPROVAL.md"), policyText(["village-goa-2"]), "utf8");
    const attested = spawnSync(process.execPath, [CLI_ENTRY, "policy", "attest", "--as", "human:alice"], {
      cwd: dir,
      env: { ...process.env, [DAEMON_ID_ENV]: "" },
      encoding: "utf8",
    });
    assert.equal(attested.status, 0, attested.stderr);

    const before = digestOf(logPath);
    const refused = await verb(server, "propose", proposal("intent.publish.inferred.index:narrowed"));
    assert.notEqual(refused.body.exit_code, 0);
    assert.equal(appendRefusalOf(refused).append, "daemon-not-allowed", refused.body.stderr ?? "");
    assert.equal(digestOf(logPath), before);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Declared, never marked
// ---------------------------------------------------------------------------

test("serve declares an identity without marking itself the daemon", async () => {
  const { dir } = await ready();
  const server = await listener(dir, {});
  try {
    // The mark is what routes an advance under the daemon's own autonomous
    // class (APRV-382). A process that dispatches the verbs an agent asks for
    // must not hold it, and stamping does not need it.
    assert.equal(isDaemonProcess(), false);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Review findings: a fresh hook thread under drift, and one id per process
// ---------------------------------------------------------------------------

test("a hook thread spawned after the policy lost its attestation writes nothing an excluding list forbids", async () => {
  const { dir, logPath } = await ready(["village-goa-2"]);
  const server = await listener(dir, { [DAEMON_ID_ENV]: "village-goa-1" });
  try {
    // A human edits the policy and has not re-attested it: every resolution
    // fails from here on. The listener still holds the list it resolved; no
    // hook thread exists yet, so the first call spawns one.
    appendFileSync(join(dir, "APPROVAL.md"), "\n<!-- an edit nobody attested -->\n", "utf8");
    const before = digestOf(logPath);
    const answer = await hook(server, "claude-code", {
      hook_event_name: "PreToolUse",
      session_id: "stamp-session",
      tool_use_id: "stamp-drift",
      cwd: dir,
      tool_name: "Bash",
      tool_input: { command: "npm install left-pad" },
    });
    assert.equal(answer.status, 200);
    assert.equal(digestOf(logPath), before, "a fresh hook thread wrote under an excluded id");
    assert.ok(
      !recordsOf(logPath).some((record) => record.daemon === "village-goa-1"),
      "a record carries the excluded id",
    );
  } finally {
    await server.close();
  }
});

test("a closed listener stops stamping, and one process stamps one id", async () => {
  const first = await ready();
  const second = await ready();
  const server = await listener(first.dir, { [DAEMON_ID_ENV]: "village-goa-1" });
  try {
    await assert.rejects(
      listener(second.dir, { [DAEMON_ID_ENV]: "village-goa-2" }),
      /already writes as daemon village-goa-1/u,
    );
  } finally {
    await server.close();
  }
  assert.equal(daemonIdentity(), null, "a closed listener left its declaration in force");
  const next = await listener(second.dir, { [DAEMON_ID_ENV]: "village-goa-2" });
  try {
    assert.equal(next.daemonId, "village-goa-2");
  } finally {
    await next.close();
  }
});
