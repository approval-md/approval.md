/**
 * `approval serve` under concurrency: a waiting hook holds nothing (APRV-427).
 *
 * Observed on the first hosted tenant: while one `POST /hook/hermes` call sat
 * waiting for a human, the tenant's `POST /verb/queue` and `GET /status`
 * through the same listener did not answer until the wait ended. The hook ran
 * on the listener's only thread and slept with `Atomics.wait`, inside the one
 * lock every request took, so one pending question hid the queue from the very
 * person who had to answer it.
 *
 * What is asserted here, one test per acceptance criterion:
 *
 *   1. with one hook call held open (60 s, nobody deciding), `GET /status`,
 *      `POST /verb/queue` and `GET /log/follow` on the tenant credential each
 *      answer within 2 s, and the held call still answers the human's decision;
 *   2. two concurrent hook calls for different tool calls both open their
 *      requests and both wait, and each is answered by its own decision
 *      whatever the other is doing;
 *   3. two appends never interleave through the facade. Shown twice: directly,
 *      by holding the listener's own store lock and watching a hook call's
 *      appends wait for it while its poll does not; and end to end, by a burst
 *      of concurrent hook calls whose mutation sections each land as one
 *      contiguous run of records on a chain that verifies.
 *
 * Every decision here is made through the CLI's own `grant` and `reject`, and
 * every record through the real append path. Nothing hand-writes a log line.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { main } from "../src/cli/main.js";
import type { EventRecord } from "../src/core/log.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { resolveServeCredentials } from "../src/serve/credentials.js";
import { serveApproval, storeLock, type ServeHandle } from "../src/serve/server.js";

const AGENT_TOKEN = "agent-token-for-the-serve-suite-0000";
const TENANT_TOKEN = "tenant-token-for-the-serve-suite-000";
const ACTOR = "agent:serve-test";
const SESSION = "serve-session";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-serve-concurrency-")));
let counter = 0;

after(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * `network.call` falls to `defaults.autonomy: manual`, so a POST through curl
 * opens a request and waits; a workspace write is autonomous, so it appends its
 * execution record and answers at once.
 */
const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "read_scope:",
  "  roots: []",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  files.write.workspace:",
  "    autonomy: autonomous",
  "```",
  "",
].join("\n");

const LOG = join(".approval", "log", "events.jsonl");
const quiet = { out: (): void => undefined, err: (): void => undefined };

async function ready(): Promise<{ dir: string; logPath: string }> {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const code = await main(["policy", "attest", "--as", "human:alice"], { cwd: dir, streams: quiet });
  assert.equal(code, 0, "the scenario policy did not attest");
  return { dir, logPath: join(dir, LOG) };
}

async function listener(dir: string): Promise<ServeHandle> {
  const credentials = resolveServeCredentials({
    APPROVAL_SERVE_AGENT_TOKEN: AGENT_TOKEN,
    APPROVAL_SERVE_TENANT_TOKEN: TENANT_TOKEN,
  });
  assert.equal(credentials.ok, true);
  if (!credentials.ok) throw new Error("unreachable");
  return await serveApproval({
    actor: ACTOR,
    cwd: dir,
    credentials: credentials.credentials,
    daemonId: "daemon-serve-test",
    port: 0,
    // The hold the acceptance criterion names: a hook nobody answers waits
    // this long. Every test below ends its holds with a decision instead.
    hookTimeout: "60s",
  });
}

function url(server: ServeHandle, path: string): string {
  return `http://${server.host}:${String(server.port)}${path}`;
}

/** A Claude Code PreToolUse envelope for one shell command. */
function bash(dir: string, toolUseId: string, command: string): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    tool_use_id: toolUseId,
    cwd: dir,
    tool_name: "Bash",
    tool_input: { command },
  };
}

/**
 * A manual command whose bytes are this call's own. The bytes matter: a second
 * call with the SAME command adopts the first one's open question rather than
 * asking again (the retry carryover), which is the gate working and not two
 * independent calls.
 */
function manual(toolUseId: string): string {
  return `curl -X POST https://example.com/api -d call=${toolUseId}`;
}
const MANUAL_CLASS = "network.call";

function keyOf(toolUseId: string): string {
  return `hook:${SESSION}:${toolUseId}:${MANUAL_CLASS}`;
}

interface Verdict {
  permission: string;
  reason: string;
  /** When the response arrived, for the ordering assertions. */
  at: number;
}

/** POST one hook call; resolves with the Claude Code verdict it carried. */
async function hook(server: ServeHandle, envelope: Record<string, unknown>): Promise<Verdict> {
  const response = await fetch(url(server, "/hook/claude-code"), {
    method: "POST",
    headers: { authorization: `Bearer ${AGENT_TOKEN}` },
    body: JSON.stringify(envelope),
  });
  assert.equal(response.status, 200, "a hook verdict is an answer, so its status is 200");
  const body = (await response.json()) as { exit_code: number; stdout: string };
  const nested = (JSON.parse(body.stdout) as Record<string, unknown>)["hookSpecificOutput"] as Record<
    string,
    unknown
  >;
  return {
    permission: String(nested["permissionDecision"]),
    reason: String(nested["permissionDecisionReason"]),
    at: Date.now(),
  };
}

/** Track whether a promise has settled, without awaiting it. */
function tracked<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false;
  const wrapped = promise.finally(() => {
    done = true;
  });
  return { promise: wrapped, settled: () => done };
}

function records(logPath: string): EventRecord[] {
  const read = readVerifiedRecords(logPath, { cache: null });
  assert.equal(read.ok, true, read.ok ? "" : read.message);
  if (!read.ok) throw new Error("unreachable");
  return read.records;
}

function requestedKeys(logPath: string): string[] {
  return records(logPath)
    .filter((record) => record.event === "approval.requested")
    .map((record) => String(record.action_key));
}

/** Poll (asynchronously) until `ready` holds, or fail after `ms`. */
async function until(what: string, ready: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((settle) => setTimeout(settle, 25));
  }
}

async function decide(dir: string, verb: "grant" | "reject", key: string): Promise<void> {
  const code = await main([verb, key, "--as", "human:alice"], { cwd: dir, streams: quiet });
  assert.equal(code, 0, `the human's ${verb} of ${key} did not record`);
}

// ---------------------------------------------------------------------------
// AC1
// ---------------------------------------------------------------------------

test("AC1: while one hook call is held open, status, queue and follow answer within 2 s", async () => {
  const { dir, logPath } = await ready();
  const server = await listener(dir);
  try {
    const held = tracked(hook(server, bash(dir, "tu-held", manual("tu-held"))));
    const key = keyOf("tu-held");
    // The request is on the log, so the call is past its mutation section and
    // in its wait, which is where it used to freeze the listener.
    await until("the held call's request", () => requestedKeys(logPath).includes(key));
    assert.equal(held.settled(), false, "the held call answered before anyone decided");

    const tenant = { authorization: `Bearer ${TENANT_TOKEN}` };
    const calls: Array<[string, () => Promise<Response>]> = [
      ["GET /status", async () => await fetch(url(server, "/status"), { headers: tenant })],
      [
        "POST /verb/queue",
        async () =>
          await fetch(url(server, "/verb/queue"), { method: "POST", headers: tenant, body: "{}" }),
      ],
      ["GET /log/follow", async () => await fetch(url(server, "/log/follow?from=0"), { headers: tenant })],
    ];
    for (const [label, call] of calls) {
      const started = performance.now();
      const response = await call();
      const text = await response.text();
      const elapsed = performance.now() - started;
      assert.equal(response.status, 200, `${label} answered ${String(response.status)}: ${text}`);
      assert.ok(elapsed < 2_000, `${label} took ${elapsed.toFixed(0)} ms while a hook call waited`);
      if (label === "POST /verb/queue") {
        // Not merely an answer: the question the held call is waiting on is IN
        // it, which is the whole reason the tenant is asking.
        assert.match(text, new RegExp(key.replaceAll(".", "\\."), "u"));
      }
      if (label === "GET /log/follow") {
        const page = JSON.parse(text) as { records: EventRecord[] };
        assert.ok(page.records.some((record) => record.action_key === key));
      }
    }
    assert.equal(held.settled(), false, "the held call ended while the tenant read");

    // And the held call is still a gate: the human's answer reaches it.
    await decide(dir, "reject", key);
    const verdict = await held.promise;
    assert.equal(verdict.permission, "deny");
    assert.match(verdict.reason, /hook-rejected/u);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// AC2
// ---------------------------------------------------------------------------

test("AC2: two concurrent hook calls both open their requests, both wait, and neither delays the other", async () => {
  const { dir, logPath } = await ready();
  const server = await listener(dir);
  try {
    const first = tracked(hook(server, bash(dir, "tu-a", manual("tu-a"))));
    const second = tracked(hook(server, bash(dir, "tu-b", manual("tu-b"))));
    const [keyA, keyB] = [keyOf("tu-a"), keyOf("tu-b")];

    // Both questions are asked while both calls are still waiting: the second
    // did not queue behind the first one's wait.
    await until("both requests", () => {
      const keys = requestedKeys(logPath);
      return keys.includes(keyA) && keys.includes(keyB);
    });
    assert.equal(first.settled(), false, "the first call answered before anyone decided");
    assert.equal(second.settled(), false, "the second call answered before anyone decided");

    // Answered in the OPPOSITE order to the one they were asked in, so the
    // second call's answer cannot be riding on the first call's.
    await decide(dir, "grant", keyB);
    const b = await second.promise;
    assert.equal(b.permission, "allow", b.reason);
    assert.equal(first.settled(), false, "granting the second call's question answered the first");

    await decide(dir, "reject", keyA);
    const a = await first.promise;
    assert.equal(a.permission, "deny");
    assert.match(a.reason, /hook-rejected/u);

    // Neither was refused by the other: exactly one request each, and the
    // granted one spent its grant once.
    const log = records(logPath);
    assert.equal(log.filter((record) => record.action_key === keyA && record.event === "approval.requested").length, 1);
    assert.equal(log.filter((record) => record.action_key === keyB && record.event === "approval.requested").length, 1);
    assert.equal(log.filter((record) => record.action_key === keyB && record.event === "execution.started").length, 1);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// AC3
// ---------------------------------------------------------------------------

test("AC3: under concurrent hook calls no two mutation sections interleave, and the chain verifies", async () => {
  const { dir, logPath } = await ready();
  const server = await listener(dir);
  const waiting = ["tu-m1", "tu-m2", "tu-m3", "tu-m4", "tu-m5"];
  const autonomous = ["tu-w1", "tu-w2", "tu-w3", "tu-w4", "tu-w5"];
  try {
    const before = records(logPath).length;
    // All ten at once, interleaved in the order they are sent, and a tenant
    // read in the middle of them for good measure.
    const calls = new Map<string, Promise<Verdict>>();
    for (let index = 0; index < waiting.length; index += 1) {
      const m = waiting[index] as string;
      const w = autonomous[index] as string;
      calls.set(m, hook(server, bash(dir, m, manual(m))));
      calls.set(w, hook(server, bash(dir, w, `mkdir build-${w}`)));
    }
    const status = await fetch(url(server, "/status"), {
      headers: { authorization: `Bearer ${TENANT_TOKEN}` },
    });
    assert.equal(status.status, 200);
    await status.text();

    await until("every waiting call's request", () => {
      const keys = requestedKeys(logPath);
      return waiting.every((id) => keys.includes(keyOf(id)));
    });
    // The autonomous calls never waited, so they have answered by now or will
    // without anyone deciding anything.
    for (const id of autonomous) {
      const verdict = await (calls.get(id) as Promise<Verdict>);
      assert.equal(verdict.permission, "allow", `${id}: ${verdict.reason}`);
    }

    const log = records(logPath);
    // The single-appender property, read off the chain itself: sequence
    // numbers run 1..n with no gap and no repeat, and the verified read above
    // already proved every link.
    assert.deepEqual(
      log.map((record) => record.seq),
      log.map((_record, index) => index + 1),
    );

    // Each call's mutation section is one contiguous run: nothing another call
    // appended lands between a call's own records. For a waiting call that is
    // its registration and its request; for an autonomous one it is every
    // record it wrote.
    const fresh = log.slice(before);
    const runsOf = (task: string): number[] =>
      fresh.filter((record) => record.task === task).map((record) => record.seq);
    for (const id of [...waiting, ...autonomous]) {
      const seqs = runsOf(`hook:${SESSION}:${id}`);
      assert.ok(seqs.length > 0, `${id} wrote nothing`);
      for (let index = 1; index < seqs.length; index += 1) {
        assert.equal(
          seqs[index],
          (seqs[index - 1] as number) + 1,
          `${id}'s records ${seqs.join(", ")} were interleaved by another call's append`,
        );
      }
    }
    for (const id of autonomous) {
      const started = fresh.filter(
        (record) => record.task === `hook:${SESSION}:${id}` && record.event === "execution.started",
      );
      assert.equal(started.length, 1, `${id} recorded ${String(started.length)} execution.started`);
    }

    // The CLI's own verifier agrees, from a cold read.
    const verified = await main(["log", "verify", "--log", logPath], { cwd: dir, streams: quiet });
    assert.equal(verified, 0, "the log does not verify after the burst");

    for (const id of waiting) await decide(dir, "reject", keyOf(id));
    for (const id of waiting) {
      const verdict = await (calls.get(id) as Promise<Verdict>);
      assert.equal(verdict.permission, "deny");
      assert.match(verdict.reason, /hook-rejected/u);
    }
  } finally {
    await server.close();
  }
});

test("AC3: a hook call appends only inside the store lock, and waits outside it", async () => {
  const { dir, logPath } = await ready();
  const server = await listener(dir);
  // The lock the listener itself takes for this store: every verb call, follow
  // page and export runs inside it, so an append that honours it cannot land
  // inside any of theirs.
  const lock = storeLock(logPath, dir);
  try {
    const before = records(logPath).length;
    let release = (): void => undefined;
    const holding = lock(
      async () =>
        await new Promise<void>((settle) => {
          release = settle;
        }),
    );
    const call = tracked(hook(server, bash(dir, "tu-lock", manual("tu-lock"))));
    // Ample time for the call to reach its thread and ask for the lock. It
    // may append nothing while another holder has it.
    await new Promise((settle) => setTimeout(settle, 750));
    assert.equal(
      records(logPath).length,
      before,
      "the hook call appended while another holder had the store lock",
    );
    assert.equal(call.settled(), false);

    release();
    await holding;
    const key = keyOf("tu-lock");
    await until("the request, once the lock was free", () => requestedKeys(logPath).includes(key));

    // Now the call is in its wait, and the wait holds nothing: the lock is
    // taken at once, and the call is still waiting afterwards.
    const started = performance.now();
    await lock(async () => undefined);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1_000, `the store lock took ${elapsed.toFixed(0)} ms to take while a hook call waited`);
    assert.equal(call.settled(), false, "the hook call ended without a decision");

    await decide(dir, "reject", key);
    const verdict = await call.promise;
    assert.equal(verdict.permission, "deny");
    assert.match(verdict.reason, /hook-rejected/u);
  } finally {
    await server.close();
  }
});

test("closing the listener while a hook call waits leaves the store writable", async () => {
  const { dir, logPath } = await ready();
  const server = await listener(dir);
  const call = hook(server, bash(dir, "tu-close", manual("tu-close"))).then(
    () => "answered",
    () => "dropped",
  );
  const key = keyOf("tu-close");
  await until("the request", () => requestedKeys(logPath).includes(key));
  await server.close();
  // The caller gets no verdict, which its client reads as a block.
  assert.equal(await call, "dropped");
  // The thread was stopped outside any mutation section, so it left no append
  // lockfile behind: the next writer appends at once. The question it opened
  // is still open, exactly as for a killed `approval hook` process, and a human
  // can still answer it.
  assert.deepEqual(readdirSync(join(dir, ".approval", "log")).filter((name) => name.endsWith(".lock")), []);
  await decide(dir, "reject", key);
  assert.ok(records(logPath).some((record) => record.event === "approval.rejected" && record.action_key === key));
});
