/**
 * The end-to-end demo (APRV-27) — the SPEC abstract made executable.
 *
 * One scripted walk, in log order: an agent registers a task and requests a
 * manual action, the request surfaces in `approval queue` and in QUEUE.md, a
 * Telegram message carries the full payload to a phone, a tap on Approve grants
 * it and mints a single-use token, `approval run` spends that token to execute
 * the command, and the chain still verifies at the end.
 *
 * Two rules give this file its shape.
 *
 * **Everything is driven through the CLI as a child process.** That is the
 * surface a human and an agent actually touch, so a demo that called core
 * functions would prove something nobody can run. Core is imported for exactly
 * one thing — {@link payloadHash}, to build the fixture's content binding and to
 * assert against it — and never to perform a step.
 *
 * **The negative space is part of the demo.** A walk that only shows the happy
 * path would not distinguish this runtime from one that always says yes, so the
 * script runs `approval run` *before* the approval (exit 5, log byte-identical)
 * and again after the token is spent (refused, no second `execution.started`),
 * and it scans every log byte and every message the mock received for the raw
 * token.
 *
 * The Bot API is the local mock in `tests/telegram-mock.ts` and **never the real
 * network**; `assertLocal()` asserts that on the `--api-base` this file passes.
 * The real-network twin of this script is the manual walkthrough in
 * `examples/telegram-demo.md`, which a human runs once against a real bot.
 *
 * Structured as one test with ordered subtests, so a failure names the hop it
 * broke at rather than reporting "the demo failed".
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { payloadHash } from "../src/core/payload.js";
import {
  assertLocal,
  callbackUpdate,
  startMockBotApi,
  type MockBotApi,
} from "./telegram-mock.js";

/** dist/tests/e2e-demo.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

/**
 * A plausible-looking but entirely fake bot token, distinctive enough that the
 * "never anywhere" scans cannot pass by accident.
 */
const BOT_TOKEN = "7654321:AA-approval-md-fake-token-for-the-demo-DO-NOT-USE";
const CHAT = "9911";

const HUMAN = "human:carter";
const AGENT = "agent:drafter";
const TASK = "task-demo";
const ACTION = "task-demo:chaser";

/**
 * The action's concrete payload: the email the agent proposes to send.
 *
 * The subject carries `<` and `&` on purpose. §10.4 requires the channel to
 * present the payload, and the demo asserts it arrives verbatim in the rendered
 * region and HTML-escaped on the wire.
 */
const PAYLOAD = {
  to: ["agency@example.co.uk"],
  subject: "Deposit refund chaser <second> & final",
  body: "Following up on the deposit refund, now 21 days past the scheme deadline.",
};

/** The content binding (amended SPEC.md §6.2): SHA-256 over the RFC 8785 form. */
const PAYLOAD_HASH = payloadHash(PAYLOAD);

const POLICY = [
  "# Approval policy (demo)",
  "",
  "Everything is manual unless a class says otherwise, and the email class is",
  "manual with a per-action ceiling.",
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
  "  communicate.email.external:",
  "    autonomy: manual",
  "    limits:",
  "      per_action_usd: 1",
  "channels:",
  "  telegram:",
  "    token_env: APPROVAL_TG_TOKEN",
  "    chat_id_env: APPROVAL_TG_CHAT",
  "```",
  "",
].join("\n");

const TASK_FILE = [
  "---",
  `id: ${TASK}`,
  "title: Chase the letting agency for the deposit refund",
  "status: In Progress",
  "approval:",
  "  origin:",
  "    app: demo",
  `    created_by: "${AGENT}"`,
  "  state: proposed",
  "  actions:",
  "    - class: communicate.email.external",
  '      summary: "Send the deposit chaser to agency@example.co.uk"',
  "      reversible: false",
  "      est_cost_usd: 0.02",
  `      idempotency_key: "${ACTION}"`,
  `      payload_hash: "${PAYLOAD_HASH}"`,
  "---",
  "",
  "## Description",
  "",
  "The agency has not answered two emails. Chase once more, then escalate.",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// The scratch demo home
// ---------------------------------------------------------------------------

/** realpath: macOS hands out /var/… symlinks, and attestation compares paths. */
const demo = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-e2e-demo-")));
const logPath = join(demo, ".approval", "log", "events.jsonl");
const queuePath = join(demo, ".approval", "QUEUE.md");
/**
 * The bytes handed to `approval request --payload` (APRV-28). One file, read
 * once at intake; from there the payload store beside the log is where every
 * later surface finds the material, which is why no step below passes
 * `--payload-dir` or `--payloads` to anything.
 */
const payloadPath = join(demo, "payload.json");
/** Where the store files them: `.approval/payloads/<payload_hash>.json`. */
const storedPayloadPath = join(demo, ".approval", "payloads", `${PAYLOAD_HASH}.json`);

let mock: MockBotApi;

before(async () => {
  mkdirSync(demo, { recursive: true });
  writeFileSync(join(demo, "APPROVAL.md"), POLICY, "utf8");
  writeFileSync(join(demo, `${TASK}.md`), TASK_FILE, "utf8");
  writeFileSync(payloadPath, `${JSON.stringify(PAYLOAD, null, 2)}\n`, "utf8");
  mock = await startMockBotApi(BOT_TOKEN);
});

after(async () => {
  await mock.close();
  rmSync(demo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The child's environment is stripped of every variable the demo supplies
 * itself, so a developer who exports `APPROVAL_HUMAN` in their own shell cannot
 * make an identity-dependent step pass by accident.
 */
function cliEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const name of ["APPROVAL_HUMAN", "APPROVAL_TG_TOKEN", "APPROVAL_TG_CHAT"]) {
    if (extra[name] === undefined) delete env[name];
  }
  return env;
}

function runCli(args: string[], env: Record<string, string> = {}): Run {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: demo,
    encoding: "utf8",
    env: cliEnv(env),
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function rawLog(): string {
  return existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
}

function logRecords(): Record<string, unknown>[] {
  return rawLog()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function events(): string[] {
  return logRecords().map((record) => String(record["event"]));
}

function recordAt(seq: number): Record<string, unknown> {
  const record = logRecords().find((entry) => entry["seq"] === seq);
  assert.ok(record !== undefined, `no record at seq ${seq}`);
  return record;
}

function payloadOf(record: Record<string, unknown>): Record<string, unknown> {
  return (record["payload"] ?? {}) as Record<string, unknown>;
}

function json(run: Run): Record<string, unknown> {
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

function jsonErr(run: Run): Record<string, unknown> {
  const first = run.stderr.trim().split("\n")[0] as string;
  const parsed = JSON.parse(first) as Record<string, unknown>;
  return (parsed["error"] ?? parsed) as Record<string, unknown>;
}

async function until(predicate: () => boolean, label: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** The command the demo executes once the approval is in hand. */
const DEMO_COMMAND = [process.execPath, "-e", "console.log('sent');process.exit(0)"];

/** Filled in at the Telegram hop; spent at the execution hop. */
let executionToken = "";

// ===========================================================================
// The walk
// ===========================================================================

test("the demo: request -> telegram approval -> executed run -> clean chain", async (t) => {
  // -------------------------------------------------------------------------
  await t.test("(a) scaffold: attest the policy, register the task, request", () => {
    const attested = runCli(["policy", "attest", "--as", HUMAN, "--json"]);
    assert.equal(attested.code, 0, attested.stderr);
    assert.equal(json(attested)["seq"], 1);

    const registered = runCli(["register", `${TASK}.md`, "--as", AGENT, "--json"]);
    assert.equal(registered.code, 0, registered.stderr);
    assert.deepEqual(json(registered), { ok: true, seq: 2, task: TASK, actions: 1 });

    const requested = runCli([
      "request",
      TASK,
      "--action",
      ACTION,
      "--payload",
      "payload.json",
      "--as",
      AGENT,
      "--json",
    ]);
    assert.equal(requested.code, 0, requested.stderr);
    assert.deepEqual(json(requested), {
      ok: true,
      task: TASK,
      action_key: ACTION,
      class: "communicate.email.external",
      autonomy: "manual",
      proceed: false,
      requested: true,
      seq: 3,
    });

    assert.deepEqual(events(), ["policy.updated", "task.registered", "approval.requested"]);

    // The binding travels from the envelope onto approval.requested unchanged:
    // the class was declared before a token could be asked for, and the bytes
    // were named before a human was.
    assert.deepEqual(payloadOf(recordAt(3)), {
      class: "communicate.email.external",
      est_cost_usd: 0.02,
      payload_hash: PAYLOAD_HASH,
      summary: "Send the deposit chaser to agency@example.co.uk",
      reversible: false,
    });
    assert.equal(recordAt(3)["actor"], AGENT);

    // APRV-28: the bytes are filed once, at intake, under the hash the log
    // committed to — and the store is a sibling of the log directory, so no
    // payload file can land where the chain is walked from.
    assert.equal(existsSync(storedPayloadPath), true, "the request stored no payload");
    assert.deepEqual(
      JSON.parse(readFileSync(storedPayloadPath, "utf8")) as unknown,
      PAYLOAD,
      "the stored material is not the material that was supplied",
    );
    assert.equal(
      createHash("sha256").update(readFileSync(storedPayloadPath, "utf8"), "utf8").digest("hex"),
      PAYLOAD_HASH,
      "the store file's own bytes do not hash to its name",
    );
    assert.equal(existsSync(join(demo, ".approval", "payloads", "events.jsonl")), false);
  });

  // -------------------------------------------------------------------------
  await t.test("(b) surfaces: queue lists it, render writes QUEUE.md, status is healthy", () => {
    const queue = runCli(["queue", "--json"]);
    assert.equal(queue.code, 0, queue.stderr);
    const pending = json(queue)["pending"] as Record<string, unknown>[];
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.["action_key"], ACTION);
    assert.equal(pending[0]?.["task"], TASK);
    assert.equal(pending[0]?.["class"], "communicate.email.external");
    assert.equal(pending[0]?.["est_cost_usd"], 0.02);
    assert.ok((pending[0]?.["ttl_remaining_ms"] as number) > 0, "the request is inside its TTL");

    const render = runCli(["render", "--json"]);
    assert.equal(render.code, 0, render.stderr);
    const rendered = json(render);
    assert.equal(rendered["out"], queuePath);
    // APRV-28 inverts the APRV-27 friction case. `approval render` still takes
    // no payload flag and still needs none: the material was stored at intake,
    // so the renderer summarizes the request like every other surface and
    // QUEUE.md's pending count AGREES with the queue instead of silently
    // disagreeing with it.
    assert.equal(rendered["pending"], 1);
    assert.equal(rendered["skipped"], 0, "nothing was left unsummarizable");
    assert.equal(
      rendered["pending"],
      pending.length,
      "QUEUE.md and `approval queue` disagree about how many requests are pending",
    );
    const queueMd = readFileSync(queuePath, "utf8");
    assert.match(queueMd, new RegExp(ACTION, "u"), "QUEUE.md names the live request");
    assert.match(queueMd, /1 request\(s\), oldest first/u);
    assert.match(queueMd, /_None\._ Every live request above is rendered in full\./u);
    // Holding the bytes is not the same as printing them: QUEUE.md is a summary
    // surface that collects no decision, so it still carries only the binding.
    assert.equal(queueMd.includes(PAYLOAD.body), false, "QUEUE.md must not inline payload bytes");
    assert.match(queueMd, new RegExp(PAYLOAD_HASH, "u"));

    // Pending is not unhealthy: a request awaiting a human is the system
    // working. `status` reports on attestation, the chain, and debris.
    const status = runCli(["status", "--json"]);
    assert.equal(status.code, 0, status.stderr);
    const health = json(status);
    assert.equal(health["healthy"], true);
    assert.deepEqual(health["attestation"], { state: "attested", seq: 1 });
    assert.deepEqual(health["verification"], { status: "clean", records: 3 });
    assert.deepEqual(health["dangling"], []);
  });

  // -------------------------------------------------------------------------
  await t.test("(c) negative space: run before the approval exits 5 and appends nothing", () => {
    const before_ = rawLog();

    const refused = runCli([
      "run",
      ACTION,
      "--payload-hash",
      PAYLOAD_HASH,
      "--as",
      AGENT,
      "--json",
      "--",
      ...DEMO_COMMAND,
    ]);

    assert.equal(refused.code, 5, refused.stderr);
    assert.equal(jsonErr(refused)["code"], "token-required");
    assert.equal(refused.stdout.includes("sent"), false, "the command ran without an approval");
    assert.equal(rawLog(), before_, "a refusal wrote to the log");
  });

  // -------------------------------------------------------------------------
  await t.test("(d) telegram: the payload is delivered, and Approve grants it", async () => {
    const before_ = mock.sentTexts().length;

    const listener = spawn(
      process.execPath,
      [
        CLI_ENTRY,
        "channel",
        "telegram",
        "listen",
        "--once",
        "--api-base",
        assertLocal(mock.url),
        // No --payloads: the listener reads the same store `approval request
        // --payload` wrote at intake (APRV-28). The override flag still exists
        // and is exercised in tests/channels-telegram.test.ts; the demo shows
        // the path an operator actually walks, which no longer needs it.
        "--poll-timeout",
        "5",
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
    listener.stdout.setEncoding("utf8");
    listener.stderr.setEncoding("utf8");
    listener.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    listener.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    // Wait for the bot message that carries the keyboard, then press Approve
    // exactly as Telegram would deliver it from the configured chat.
    await until(() => {
      try {
        mock.callbackDataFor(ACTION, "grant");
        return true;
      } catch {
        return false;
      }
    }, "the listener to deliver the pending request");

    const delivered = mock.sentTexts().slice(before_).join("\n");
    assert.match(delivered, /APPROVAL REQUIRED/u);
    assert.match(delivered, new RegExp(`<code>${ACTION}</code>`, "u"));
    assert.match(delivered, /COMPUTED — derived by the runtime/u);
    assert.match(delivered, new RegExp(`CLAIMED — authored by ${AGENT}, NOT verified`, "u"));
    assert.match(delivered, /FULL PAYLOAD/u);
    assert.match(delivered, new RegExp(PAYLOAD_HASH, "u"), "the binding is shown to the approver");
    // The payload arrives whole, and HTML-escaped: an agent-authored subject
    // must not become markup on its way to a phone.
    assert.match(delivered, /Deposit refund chaser &lt;second&gt; &amp; final/u);
    assert.match(delivered, /21 days past the scheme deadline/u);
    assert.equal(delivered.includes("<second>"), false, "raw markup reached the message");

    mock.queueUpdate(
      callbackUpdate({ data: mock.callbackDataFor(ACTION, "grant"), chatId: CHAT }),
    );

    const code = await new Promise<number>((resolve) => {
      listener.on("exit", (status) => resolve(status ?? -1));
    });
    assert.equal(code, 0, `listener exited ${code}: ${stderr}`);
    assert.match(stdout, new RegExp(`notified ${ACTION}`, "u"));
    assert.match(stdout, new RegExp(`granted ${ACTION} .*by ${HUMAN} via telegram`, "u"));

    // The token is printed exactly once, on this terminal, and nowhere else.
    const printed = /execution token for \S+: (\S+)/u.exec(stdout);
    assert.ok(printed !== null, `no execution token on the listener's stdout: ${stdout}`);
    executionToken = printed[1] as string;
    assert.match(executionToken, /^[a-f0-9]{64}$/u);
    assert.match(stdout, /NOT sent to Telegram/u);

    assert.deepEqual(events(), [
      "policy.updated",
      "task.registered",
      "approval.requested",
      "approval.granted",
    ]);
    const granted = recordAt(4);
    assert.equal(granted["actor"], HUMAN, "the decision is recorded against the human, not the bot");
    assert.equal(granted["action_key"], ACTION);
    const grantPayload = payloadOf(granted);
    assert.equal(grantPayload["class"], "communicate.email.external");
    assert.equal(grantPayload["est_cost_usd"], 0.02);
    // The grant carries the SAME binding the request did: the human approved
    // these bytes, and the token below can only spend them.
    assert.equal(grantPayload["payload_hash"], PAYLOAD_HASH);
    assert.equal(
      grantPayload["token_sha256"],
      createHash("sha256").update(executionToken, "utf8").digest("hex"),
      "the log holds the token's digest and only its digest",
    );
    // An inline keyboard collects no text, and the channel invents none on the
    // approving side: a grant carries no note at all. (A reject does, because
    // "why not" is the one thing a refusal owes the record.)
    assert.deepEqual(Object.keys(grantPayload).sort(), [
      "class",
      "est_cost_usd",
      "payload_hash",
      "token_sha256",
    ]);

    // The two scans that matter: the raw execution token is in no log byte and
    // in no message the mock received, and neither is the bot token.
    const bytes = rawLog();
    assert.equal(bytes.includes(executionToken), false, "the raw token reached the log");
    assert.equal(bytes.includes(BOT_TOKEN), false, "the bot token reached the log");
    for (const entry of mock.requests) {
      assert.equal(
        entry.raw.includes(executionToken),
        false,
        `the execution token appeared in a ${entry.method} body`,
      );
      assert.equal(
        entry.raw.includes(BOT_TOKEN),
        false,
        `the bot token appeared in a ${entry.method} body`,
      );
    }
    assert.equal(stderr.includes(BOT_TOKEN), false, "the bot token appeared on stderr");
  });

  // -------------------------------------------------------------------------
  await t.test("(e) execute: the token is spent and the command runs", () => {
    const executed = runCli([
      "run",
      ACTION,
      "--token",
      executionToken,
      "--payload-hash",
      PAYLOAD_HASH,
      "--as",
      AGENT,
      "--json",
      "--",
      ...DEMO_COMMAND,
    ]);

    assert.equal(executed.code, 0, executed.stderr);
    // stdout belongs to the child; run's own --json summary is on stderr.
    assert.match(executed.stdout, /sent/u);
    assert.deepEqual(JSON.parse(executed.stderr.trim()), {
      ok: true,
      action_key: ACTION,
      task: TASK,
      class: "communicate.email.external",
      autonomy: "manual",
      started_seq: 5,
      outcome: "execution.completed",
      outcome_seq: 6,
      exit_code: 0,
      payload_hash: PAYLOAD_HASH,
    });

    assert.deepEqual(events(), [
      "policy.updated",
      "task.registered",
      "approval.requested",
      "approval.granted",
      "execution.started",
      "execution.completed",
    ]);
    assert.equal(recordAt(5)["actor"], AGENT);
    assert.deepEqual(payloadOf(recordAt(6)), { exit_code: 0 });
    assert.equal(rawLog().includes(executionToken), false, "the spent token reached the log");
  });

  // -------------------------------------------------------------------------
  await t.test("(f) negative space: the same token cannot be spent twice", () => {
    const before_ = events().filter((event) => event === "execution.started").length;

    const replayed = runCli([
      "run",
      ACTION,
      "--token",
      executionToken,
      "--payload-hash",
      PAYLOAD_HASH,
      "--as",
      AGENT,
      "--json",
      "--",
      ...DEMO_COMMAND,
    ]);

    assert.equal(replayed.code, 1, replayed.stderr);
    assert.equal(jsonErr(replayed)["code"], "token-consumed");
    assert.equal(
      events().filter((event) => event === "execution.started").length,
      before_,
      "a replay appended a second execution.started",
    );
    assert.equal(events().length, 6, "the replay appended anything at all");
  });

  // -------------------------------------------------------------------------
  await t.test("(g) surfaces again: the queue is empty and the state is complete", () => {
    const queue = runCli(["queue", "--json"]);
    assert.equal(queue.code, 0, queue.stderr);
    assert.deepEqual(json(queue), { ok: true, pending: [] });

    const render = runCli(["render", "--json"]);
    assert.equal(render.code, 0, render.stderr);
    assert.equal(json(render)["pending"], 0);
    assert.equal(json(render)["skipped"], 0, "nothing is live to summarize any more");
    const queueMd = readFileSync(queuePath, "utf8");
    assert.match(queueMd, /_Nothing is awaiting a decision\._/u);

    const status = runCli(["status", "--json"]);
    assert.equal(status.code, 0, status.stderr);
    const health = json(status);
    assert.equal(health["healthy"], true);
    assert.deepEqual(health["dangling"], [], "a completed execution leaves no debris");
    assert.deepEqual(health["loop_escalations"], []);
    assert.deepEqual(health["verification"], { status: "clean", records: 6 });
  });

  // -------------------------------------------------------------------------
  // The closing claim is the chain's own, and it is the last thing asserted.
  await t.test("(h) the chain verifies", () => {
    const verified = runCli(["log", "verify", "--json"]);
    assert.equal(verified.code, 0, verified.stderr);
    const result = json(verified);
    assert.equal(result["status"], "clean");
    assert.equal(result["records"], 6);
    assert.equal((result["head"] as Record<string, unknown>)["seq"], 6);
  });
});
