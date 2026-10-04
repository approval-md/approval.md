/**
 * `approval channel telegram webhook` stamps the daemon id and is held to the
 * `daemons` allowlist (APRV-448).
 *
 * The listener runs as the real verb in its own process, against the fake Bot
 * API, so what is asserted is the whole startup path (`commandTelegramWebhook`,
 * `prepareWebhook`, `runWebhook`) rather than a function a test can call with
 * whatever it likes:
 *
 *   1. a tap delivered to the webhook is recorded with the id `approval status`
 *      reports for the same store, which is the id the daemon loop would derive;
 *   2. an attested `daemons` list that does not admit the id refuses the tap's
 *      append with the log byte-identical;
 *   3. an unusable declared id refuses the verb before it claims the bot or
 *      binds a port.
 *
 * Every fixture record goes through the real gate in THIS process, which
 * declares no identity, so the only stamped records are the listener's.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { TELEGRAM_SECRET_HEADER } from "../src/channels/telegram-webhook.js";
import { derivedDaemonId } from "../src/core/daemon-host.js";
import { DAEMON_ID_ENV } from "../src/core/daemon-identity.js";
import { register, request } from "../src/core/gate.js";
import type { EventRecord } from "../src/core/log.js";
import { payloadHash } from "../src/core/payload.js";
import { payloadStoreDirFor, storePayload } from "../src/core/payload-store.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { TELEGRAM_WEBHOOK_SECRET_ENV } from "../src/core/telegram-config.js";
import { attest, newScenario, scratchRoot, type Scenario } from "./scenario.js";
import { assertLocal, callbackUpdate, startMockBotApi, type MockBotApi } from "./telegram-mock.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = scratchRoot("tg-webhook-stamp");

const TOKEN = "7654321:AA-approval-md-fake-token-for-tests-only-DO-NOT-USE";
const CHAT = "9911";
const TASK = "task-448";
const ACTOR = "agent:drafter";
const LAUNCH_HUMAN = "human:launcher";
const MAPPED_ACCOUNT = "4242";
const SECRET = "wh-0123456789abcdef0123456789abcdef";
const URL_PATH = "/telegram/webhook";

let mock: MockBotApi;

before(async () => {
  mock = await startMockBotApi(TOKEN);
});

after(async () => {
  await mock.close();
  scratch.cleanup();
});

function policyText(daemons: readonly string[] | null): string {
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    '  approval_ttl: "24h"',
    "  on_expiry: reject",
    ...(daemons === null ? [] : ["daemons:", ...daemons.map((id) => `  - ${id}`)]),
    "approvers:",
    "  carter:",
    "    channels: [telegram, cli]",
    "    senders:",
    `      telegram: "${MAPPED_ACCOUNT}"`,
    "classes:",
    "  communicate.email.external:",
    "    autonomy: manual",
    "```",
    "",
  ].join("\n");
}

/** One live manual request, registered and requested through the real gate on the real clock. */
function live(daemons: readonly string[] | null, key: string): Scenario {
  const unit = newScenario(scratch.root, policyText(daemons));
  attest(unit);
  const payload = { to: ["ap@vendor.example"], subject: "Invoice chaser" };
  // The bytes the listener renders on the prompt, in the store beside the log.
  const stored = storePayload(payloadStoreDirFor(unit.logPath), payload);
  assert.equal(stored.ok, true, JSON.stringify(stored));
  const registered = register(
    unit.logPath,
    {
      task: TASK,
      envelope: {
        origin: { app: "manual", created_by: ACTOR },
        state: "awaiting",
        actions: [
          {
            class: "communicate.email.external",
            idempotency_key: key,
            summary: "chase the invoice",
            reversible: false,
            est_cost_usd: "0.02",
            payload_hash: payloadHash(payload),
          },
        ],
      },
    },
    ACTOR,
    unit.options,
  );
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const requested = request(
    unit.logPath,
    {
      task: TASK,
      actionKey: key,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      summary: "chase the invoice",
    },
    ACTOR,
    unit.options,
  );
  assert.equal(requested.ok, true, JSON.stringify(requested));
  return unit;
}

function recordsOf(logPath: string): EventRecord[] {
  const read = readVerifiedRecords(logPath);
  assert.equal(read.ok, true, read.ok ? "" : read.code);
  return read.ok ? [...read.records] : [];
}

function digestOf(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function freePort(): Promise<number> {
  return await new Promise((settle, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => settle(port));
    });
  });
}

function launchEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APPROVAL_TG_TOKEN: TOKEN,
    APPROVAL_TG_CHAT: CHAT,
    [TELEGRAM_WEBHOOK_SECRET_ENV]: SECRET,
    // The per-machine bot registry, kept in the scratch tree.
    APPROVAL_STATE_DIR: `${scratch.root}/state`,
    [DAEMON_ID_ENV]: "",
    NO_COLOR: "1",
    ...extra,
  };
}

function argvFor(unit: Scenario, port: number): string[] {
  return [
    CLI_ENTRY,
    "channel",
    "telegram",
    "webhook",
    "--url",
    `https://gate.example${URL_PATH}`,
    "--port",
    String(port),
    "--log",
    unit.logPath,
    "--policy",
    unit.policyPath,
    "--as",
    LAUNCH_HUMAN,
    "--api-base",
    assertLocal(mock.url),
    "--allow-cross-instance",
    "--no-gloss",
  ];
}

/** Start the verb and resolve on its started line. */
async function startWebhook(
  unit: Scenario,
  env: NodeJS.ProcessEnv,
): Promise<{ child: ChildProcessWithoutNullStreams; port: number; started: string; stderr: () => string }> {
  mock.setWebhookInfo({ url: "" });
  const port = await freePort();
  const child = spawn(process.execPath, argvFor(unit, port), {
    cwd: unit.dir,
    env: launchEnv(env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  const started = await new Promise<string>((settle, fail) => {
    const timer = setTimeout(() => fail(new Error(`the webhook never started: ${stderr}`)), 20_000);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (!/telegram webhook registered/u.test(stderr)) return;
      clearTimeout(timer);
      settle(stderr);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`the webhook exited ${String(code)} before it started: ${stderr}`));
    });
  });
  return { child, port, started, stderr: () => stderr };
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<number> {
  const exited = new Promise<number>((settle) => child.on("exit", (code) => settle(code ?? -1)));
  child.kill("SIGTERM");
  return await exited;
}

async function tap(port: number, key: string, updateId: number): Promise<number> {
  const update = callbackUpdate({
    data: mock.callbackDataFor(key, "grant"),
    chatId: CHAT,
    id: `cb-448-${String(updateId)}`,
    fromId: MAPPED_ACCOUNT,
  });
  const response = await fetch(`http://127.0.0.1:${String(port)}${URL_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", [TELEGRAM_SECRET_HEADER]: SECRET },
    body: JSON.stringify({ update_id: updateId, ...update }),
  });
  await response.text();
  return response.status;
}

/** The id `approval status --json` reports for this store, from a fresh process. */
function statusId(unit: Scenario, env: NodeJS.ProcessEnv): string {
  const run = spawnSync(
    process.execPath,
    [CLI_ENTRY, "status", "--json", "--log", unit.logPath, "--policy", unit.policyPath],
    { cwd: unit.dir, env: { ...process.env, [DAEMON_ID_ENV]: "", ...env }, encoding: "utf8" },
  );
  const report = JSON.parse(run.stdout) as { daemon?: { id?: unknown } };
  assert.equal(typeof report.daemon?.id, "string", `${run.stdout}${run.stderr}`);
  return report.daemon?.id as string;
}

test("a tap through the webhook is recorded with the id approval status reports (APRV-448)", async () => {
  const key = `${TASK}:stamp-derived`;
  const unit = live(null, key);
  const expected = statusId(unit, {});
  // The id the daemon loop would derive for this store, by the same function.
  assert.equal(expected, derivedDaemonId(unit.logPath));

  const { child, port, started } = await startWebhook(unit, {});
  let exit: number;
  try {
    assert.match(started, new RegExp(`records stamped daemon ${expected} \\(derived\\)`, "u"));
    const before = recordsOf(unit.logPath).length;
    assert.equal(await tap(port, key, 44_801), 200);
    const appended = recordsOf(unit.logPath).slice(before);
    const granted = appended.find((record) => record.event === "approval.granted");
    assert.ok(granted !== undefined, `the tap recorded no grant: ${appended.map((r) => r.event).join(", ")}`);
    for (const record of appended) {
      assert.equal(record.daemon, expected, `${record.event} carries no daemon id`);
    }
  } finally {
    exit = await stop(child);
  }
  assert.equal(exit, 0, "a signal is a clean stop");
  // The fixture's own records were written by a process that declares nothing.
  for (const record of recordsOf(unit.logPath).filter((r) => r.event !== "approval.granted")) {
    assert.equal("daemon" in record, false, `${record.event} was stamped by a fixture`);
  }
});

test("a declared id is the one the webhook stamps (APRV-448)", async () => {
  const key = `${TASK}:stamp-declared`;
  const unit = live(null, key);
  const declared = { [DAEMON_ID_ENV]: "village-goa-1" };
  assert.equal(statusId(unit, declared), "village-goa-1");

  const { child, port } = await startWebhook(unit, declared);
  try {
    const before = recordsOf(unit.logPath).length;
    assert.equal(await tap(port, key, 44_802), 200);
    const appended = recordsOf(unit.logPath).slice(before);
    assert.ok(appended.length > 0);
    for (const record of appended) assert.equal(record.daemon, "village-goa-1");
  } finally {
    await stop(child);
  }
});

test("a daemons list that excludes the webhook's id refuses the tap's append (APRV-448)", async () => {
  const key = `${TASK}:stamp-refused`;
  const unit = live(["village-goa-2"], key);
  const { child, port, stderr } = await startWebhook(unit, { [DAEMON_ID_ENV]: "village-goa-1" });
  try {
    const before = digestOf(unit.logPath);
    await tap(port, key, 44_803);
    assert.equal(digestOf(unit.logPath), before, "an unlisted webhook appended a decision");
    assert.ok(
      !recordsOf(unit.logPath).some((record) => record.event === "approval.granted"),
      "the grant was recorded",
    );
  } finally {
    await stop(child);
  }
  // Refused for the reason under test, not for any other: the write boundary's
  // own sentence reaches the operator's stderr.
  assert.match(stderr(), /village-goa-1/u, stderr());
  assert.match(stderr(), /may not write to this log/u, stderr());
});

test("an unusable declared id refuses the webhook verb before it starts (APRV-448)", async () => {
  const unit = live(null, `${TASK}:stamp-invalid`);
  const run = spawnSync(process.execPath, [...argvFor(unit, 18_448), "--json"], {
    cwd: unit.dir,
    env: launchEnv({ [DAEMON_ID_ENV]: "Village GOA 1" }),
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(run.status, 2, `${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /not a usable daemon id/u);
  assert.equal(mock.webhookRegistration(), null, "a refused start registered the webhook");
});
