/**
 * Telegram webhook transport tests (APRV-424).
 *
 * Same discipline as every other suite here: no log line is written by hand,
 * the policy is attested through `core/attest.ts`, requests are registered and
 * made through `core/gate.ts`, and every decision reaches the log through
 * `recordChannelDecision` -> the human-only `decide()`. The Bot API is the
 * local mock in `tests/telegram-mock.ts`, and the webhook receiver is bound on
 * 127.0.0.1 with an ephemeral port: nothing here touches the network.
 *
 * ## The test this file exists for
 *
 * `sameRecordThroughBothTransports` is the shared contract test acceptance
 * criterion 2 asks for. One scenario, one `callback_query`, delivered twice:
 * once by `pollOnce` and once by an HTTP POST to the receiver. The records the
 * two logs end up holding are then compared FIELD FOR FIELD, with only the
 * values that cannot be equal (the sequence number, the runtime-assigned
 * timestamp, the chain hashes, the digest of a freshly minted token) replaced
 * by a marker — and the marker check asserts each of those is present on both
 * sides, so normalising cannot hide a missing field.
 *
 * It runs under a policy that MAPS the tapping account to an approver who is
 * not the identity either process was launched as, which is the only shape in
 * which "the sender mapping ran" can be told apart from "nothing happened".
 *
 * ## The negative tests
 *
 * A forged post is the failure mode the secret exists for, so the checks on it
 * are the strict ones: the refusal carries its own code, the log gains NOT ONE
 * record, and the request is still pending afterwards.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, test } from "node:test";

import { buildPendingQueue, type TagOptions } from "../src/channels/tagging.js";
import type { ChannelDecision, ChannelRequest, DecisionOutcome } from "../src/channels/contract.js";
import { recordChannelDecision } from "../src/channels/contract.js";
import {
  runChannelConformance,
  type ConformanceCase,
  type ConformanceHarness,
} from "../src/channels/conformance.js";
import {
  TelegramChannel,
  TelegramTransportError,
  type TelegramConfig,
} from "../src/channels/telegram.js";
import {
  secretHeaderOf,
  secretMatches,
  serveTelegramWebhook,
  TELEGRAM_SECRET_HEADER,
  TELEGRAM_WEBHOOK_DEFAULT_PATH,
  TELEGRAM_WEBHOOK_DEFAULT_PORT,
  TELEGRAM_WEBHOOK_MAX_BODY_BYTES,
  TELEGRAM_WEBHOOK_REFUSAL_CODES,
  type TelegramWebhookHandle,
  type TelegramWebhookRefusalCode,
} from "../src/channels/telegram-webhook.js";
import {
  prepareWebhook,
  resolveWebhookBind,
  runWebhook,
  WEBHOOK_MIN_SECRET_LENGTH,
  WEBHOOK_REFUSAL_CODES,
  type WebhookRefusalCode,
} from "../src/cli/channel-telegram-webhook.js";
import {
  claimListenerBot,
  prepareListen,
  type ListenSetup,
} from "../src/cli/channel-telegram.js";
import { TELEGRAM_WEBHOOK_HELP } from "../src/cli/help.js";
import {
  normaliseWebhookUrl,
  redactWebhookUrl,
  TELEGRAM_WEBHOOK_SECRET_ENV,
} from "../src/core/telegram-config.js";
import {
  channelLeasePathFor,
  readChannelLease,
  takeChannelLease,
} from "../src/core/channel-lease.js";
import { EXIT_IO } from "../src/cli/exit-codes.js";
import { register as registerCore, request as requestCore } from "../src/core/gate.js";
import type { EventRecord } from "../src/core/log.js";
import { payloadHash } from "../src/core/payload.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { register, request } from "./clock-adapters.js";
import {
  assertClean,
  at,
  attest,
  fixedClock,
  newScenario,
  scratchRoot,
  T0,
  type Scenario,
} from "./scenario.js";
import {
  assertLocal,
  callbackUpdate,
  startMockBotApi,
  type MockBotApi,
} from "./telegram-mock.js";

const scratch = scratchRoot("telegram-webhook");

const TOKEN = "7654321:AA-approval-md-fake-token-for-tests-only-DO-NOT-USE";
const CHAT = "9911";
const TASK = "task-424";
const ACTOR = "agent:drafter";
/** The identity the PROCESS is launched as. Never the one a mapped tap records. */
const LAUNCH_HUMAN = "human:launcher";
/** The person the policy attests the tapping account to. */
const MAPPED_HUMAN = "human:carter";
const MAPPED_ACCOUNT = "4242";
const UNMAPPED_ACCOUNT = "9999";
/** A generated-looking secret: long enough, and in Telegram's charset. */
const SECRET = "wh-0123456789abcdef0123456789abcdef";

/**
 * A policy that maps one Telegram account to one approver.
 *
 * The mapping is the whole point of the fixture: with it, a decision recorded
 * against `LAUNCH_HUMAN` is a decision the mapping did not touch, and a
 * decision recorded against `MAPPED_HUMAN` is one it did.
 */
const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "24h"',
  "  on_expiry: reject",
  "approvers:",
  "  carter:",
  "    channels: [telegram, cli]",
  "    senders:",
  `      telegram: "${MAPPED_ACCOUNT}"`,
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  communicate.email.external:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

let mock: MockBotApi;
/**
 * The per-machine bot registry this suite writes to.
 *
 * Pointed at the scratch tree, because `claimListenerBot` records an ownership
 * claim and a suite that wrote the operator's real `bots.json` would refuse
 * their own gate's next start.
 */
let previousStateDir: string | undefined;

before(async () => {
  previousStateDir = process.env["APPROVAL_STATE_DIR"];
  process.env["APPROVAL_STATE_DIR"] = `${scratch.root}/state`;
  mock = await startMockBotApi(TOKEN);
});

after(async () => {
  await mock.close();
  if (previousStateDir === undefined) delete process.env["APPROVAL_STATE_DIR"];
  else process.env["APPROVAL_STATE_DIR"] = previousStateDir;
  scratch.cleanup();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Live {
  unit: Scenario;
  keys: string[];
  tagOptions: TagOptions;
}

function payloadFor(index: number): Record<string, unknown> {
  return {
    from: "ap@approval.example",
    to: [`ap-${index}@vendor.example`],
    subject: `Invoice ${41 + index} chaser`,
    body: `Following up on invoice ${41 + index}.`,
  };
}

/**
 * `count` live manual requests in a fresh log, built through the real gate.
 *
 * The action keys are FIXED rather than counter-derived, because the contract
 * test compares two runs in two logs and a key that carried a fixture counter
 * would make the two records differ for a reason that is not about transports.
 */
function live(count: number, realClock = false, keyPrefix = "chaser"): Live {
  const unit = newScenario(scratch.root, POLICY);
  attest(unit, T0);

  const keys: string[] = [];
  const payloads = new Map<string, unknown>();
  const actions = [];
  for (let index = 0; index < count; index += 1) {
    const key = `${TASK}:${keyPrefix}-${index}`;
    const payload = payloadFor(index);
    keys.push(key);
    payloads.set(key, payload);
    actions.push({
      class: "communicate.email.external",
      idempotency_key: key,
      summary: `chase invoice ${41 + index}`,
      reversible: false,
      est_cost_usd: "0.02",
      payload_hash: payloadHash(payload),
    });
  }

  const source = {
    task: TASK,
    envelope: { origin: { app: "manual", created_by: ACTOR }, state: "awaiting", actions },
  };
  const registered = realClock
    ? registerCore(unit.logPath, source, ACTOR, unit.options)
    : register(unit.logPath, source, T0, ACTOR, unit.options);
  assert.equal(registered.ok, true, `registration failed: ${JSON.stringify(registered)}`);

  for (const [index, key] of keys.entries()) {
    const input = {
      task: TASK,
      actionKey: key,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      summary: `chase invoice ${41 + index}`,
    };
    const requested = realClock
      ? requestCore(unit.logPath, input, ACTOR, unit.options)
      : request(unit.logPath, input, at(1), ACTOR, unit.options);
    assert.equal(requested.ok, true, `request failed: ${JSON.stringify(requested)}`);
  }

  return {
    unit,
    keys,
    tagOptions: { policy: { file: unit.policyPath }, payload: (key) => payloads.get(key) },
  };
}

function queueOf(world: Live, now: string): ChannelRequest[] {
  const queue = buildPendingQueue(world.unit.logPath, world.tagOptions, now);
  assert.equal(queue.ok, true, JSON.stringify(queue));
  return queue.ok ? queue.requests : [];
}

function recordsOf(logPath: string): EventRecord[] {
  const read = readVerifiedRecords(logPath);
  assert.equal(read.ok, true, `log did not verify: ${JSON.stringify(read)}`);
  return read.ok ? read.records : [];
}

const complaints: string[] = [];

function channelFor(overrides: Partial<TelegramConfig> = {}): TelegramChannel {
  return new TelegramChannel({
    token: TOKEN,
    chatId: CHAT,
    apiBase: assertLocal(mock.url),
    pollTimeoutSeconds: 0,
    requestTimeoutMs: 3_000,
    backoffMs: 5,
    maxBackoffMs: 20,
    log: (message) => complaints.push(message),
    ...overrides,
  } as TelegramConfig);
}

/** The runtime's decision handler, as the listener wires it. */
function handlerFor(world: Live, now: string): (decision: ChannelDecision) => DecisionOutcome {
  return (decision) =>
    recordChannelDecision(
      world.unit.logPath,
      decision,
      { actor: LAUNCH_HUMAN, channel: "telegram" },
      { ...world.unit.options, clock: fixedClock(now) },
    ).outcome;
}

interface Posted {
  status: number;
  body: Record<string, unknown>;
}

/** POST a body at a running receiver, with whatever headers the case wants. */
async function post(
  handle: TelegramWebhookHandle,
  body: string,
  options: {
    secret?: string | string[] | null;
    path?: string;
    method?: string;
    contentType?: string;
  } = {},
): Promise<Posted> {
  const headers: [string, string][] = [
    ["content-type", options.contentType ?? "application/json"],
  ];
  const secret = options.secret === undefined ? SECRET : options.secret;
  if (Array.isArray(secret)) for (const value of secret) headers.push([TELEGRAM_SECRET_HEADER, value]);
  else if (secret !== null) headers.push([TELEGRAM_SECRET_HEADER, secret]);

  const method = options.method ?? "POST";
  const response = await fetch(
    `http://127.0.0.1:${String(handle.port)}${options.path ?? handle.path}`,
    { method, headers, ...(method === "GET" ? {} : { body }) },
  );
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed as Record<string, unknown> };
}

/**
 * A POST written with `node:http`, so the request line and the headers are
 * exactly what this test says they are.
 *
 * `fetch` merges repeated headers into one comma-joined value before they
 * reach the wire, which is precisely the case the duplicate-header refusal is
 * about: a test built on `fetch` could not produce two of them at all.
 */
async function rawPost(
  handle: TelegramWebhookHandle,
  body: string,
  headers: Record<string, string | string[]>,
): Promise<Posted> {
  const { request: httpRequest } = await import("node:http");
  return await new Promise<Posted>((settle, fail) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: handle.port,
        path: handle.path,
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => {
          let parsed: unknown = {};
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { raw: text };
          }
          settle({ status: res.statusCode ?? 0, body: parsed as Record<string, unknown> });
        });
      },
    );
    req.on("error", fail);
    req.end(body);
  });
}

/** A receiver bound on an ephemeral loopback port, closed by the caller. */
async function receiverFor(
  channel: TelegramChannel,
  overrides: Partial<Parameters<typeof serveTelegramWebhook>[0]> = {},
): Promise<TelegramWebhookHandle> {
  return await serveTelegramWebhook({
    channel,
    secret: SECRET,
    host: "127.0.0.1",
    port: 0,
    log: (message) => complaints.push(message),
    ...overrides,
  });
}

/** The code on a refusal body, or null when the body carries none. */
function refusalCodeOf(posted: Posted): string | null {
  const error = posted.body["error"];
  if (typeof error !== "object" || error === null) return null;
  const code = (error as Record<string, unknown>)["code"];
  return typeof code === "string" ? code : null;
}

// ---------------------------------------------------------------------------
// The shared contract: one tap, two transports, one record
// ---------------------------------------------------------------------------

/** Values that cannot be equal across two runs in two logs. */
const VOLATILE_TOP = ["seq", "ts", "hash", "prev"] as const;
const VOLATILE_PAYLOAD = ["token_sha256", "granted_at", "expires_at", "delivery_id"] as const;

/**
 * A record with its unrepeatable values replaced by a marker.
 *
 * Each replacement asserts the field was THERE, so normalising can never hide
 * a field one transport wrote and the other did not.
 */
function normalize(record: EventRecord, where: string): Record<string, unknown> {
  const copy = { ...record } as Record<string, unknown>;
  for (const field of VOLATILE_TOP) {
    assert.ok(field in copy, `${where}: the record carries no ${field}`);
    copy[field] = `<${field}>`;
  }
  const payload = copy["payload"];
  if (typeof payload === "object" && payload !== null) {
    const fields = { ...(payload as Record<string, unknown>) };
    for (const field of VOLATILE_PAYLOAD) {
      if (field in fields) fields[field] = `<${field}>`;
    }
    copy["payload"] = fields;
  }
  return copy;
}

type Transport = "poll" | "webhook";

/**
 * Deliver one tap through `transport` and return everything the log gained.
 *
 * Both arms build the SAME `callback_query` — same callback id, same account,
 * same `callback_data` — so the only difference between the two runs is the
 * door the update came through.
 */
async function tapThrough(
  transport: Transport,
  options: {
    decision: "grant" | "reject";
    fromId?: string;
    callbackId?: string;
    keyPrefix?: string;
  },
): Promise<{ world: Live; appended: EventRecord[]; outcome?: DecisionOutcome }> {
  const now = at(2);
  const world = live(1, false, options.keyPrefix ?? `chaser-${transport}`);
  const key = world.keys[0] as string;
  const [pending] = queueOf(world, now);
  assert.ok(pending !== undefined, "the fixture produced no pending request");

  const channel = channelFor();
  channel.onDecision(handlerFor(world, now));
  await channel.notify(pending);

  const update = callbackUpdate({
    data: mock.callbackDataFor(key, options.decision),
    chatId: CHAT,
    id: options.callbackId ?? "cb-shared-contract",
    fromId: options.fromId ?? MAPPED_ACCOUNT,
  });

  const before = recordsOf(world.unit.logPath).length;
  let outcome: DecisionOutcome | undefined;
  if (transport === "poll") {
    mock.queueUpdate(update);
    const result = await channel.pollOnce();
    outcome = result.outcomes.find((entry) => entry.action_key === key)?.outcome;
  } else {
    const handle = await receiverFor(channel);
    try {
      const answer = await post(handle, JSON.stringify({ update_id: 5001, ...update }));
      assert.equal(answer.status, 200, `the webhook refused a valid post: ${JSON.stringify(answer)}`);
    } finally {
      await handle.close();
    }
  }
  assertClean(world.unit);
  const appended = recordsOf(world.unit.logPath).slice(before);
  return outcome === undefined ? { world, appended } : { world, appended, outcome };
}

for (const decision of ["grant", "reject"] as const) {
  test(`a ${decision} by webhook and by long poll produce the same record (APRV-424)`, async () => {
    const polled = await tapThrough("poll", { decision });
    const hooked = await tapThrough("webhook", { decision });

    for (const [where, run] of [
      ["poll", polled],
      ["webhook", hooked],
    ] as const) {
      assert.equal(run.appended.length, 1, `${where}: the tap appended ${run.appended.length} records`);
    }

    const left = polled.appended[0] as EventRecord;
    const right = hooked.appended[0] as EventRecord;
    assert.equal(
      left.event,
      decision === "grant" ? "approval.granted" : "approval.rejected",
      "the long poll recorded the wrong event",
    );
    // The mapping ran, and it is the reason to compare at all: neither process
    // was launched as this person.
    assert.equal(left.actor, MAPPED_HUMAN, "the long-polled tap was not attributed to the mapped approver");
    assert.notEqual(left.actor, LAUNCH_HUMAN, "the fixture does not exercise the mapping");

    // Named explicitly as well as compared, so the deepEqual below cannot pass
    // by both sides being equally empty: the account the transport
    // authenticated, and how the runtime resolved it, are on BOTH records.
    for (const [where, record] of [
      ["poll", left],
      ["webhook", right],
    ] as const) {
      const payload = record.payload as Record<string, unknown>;
      assert.equal(
        (record as unknown as Record<string, unknown>)["channel"],
        "telegram",
        `${where}: the record does not name the surface that collected the decision`,
      );
      assert.deepEqual(
        payload["sender"],
        { channel: "telegram", id: MAPPED_ACCOUNT },
        `${where}: the account the transport authenticated is not on the record`,
      );
      assert.equal(payload["sender_source"], "policy", `${where}: the mapping's source is not recorded`);
      assert.equal(record.actor, MAPPED_HUMAN, `${where}: the wrong approver`);
    }

    // Both action keys name their own fixture, so they are compared and then
    // normalised: everything else must be equal byte for byte.
    assert.match(left.action_key ?? "", /^task-424:chaser-poll-0$/u);
    assert.match(right.action_key ?? "", /^task-424:chaser-webhook-0$/u);
    const normalized = (record: EventRecord, where: string): Record<string, unknown> => {
      const copy = normalize(record, where);
      copy["action_key"] = "<action_key>";
      const payload = copy["payload"] as Record<string, unknown>;
      if ("action_key" in payload) payload["action_key"] = "<action_key>";
      return copy;
    };
    assert.deepEqual(
      normalized(right, "webhook"),
      normalized(left, "poll"),
      "a tap that arrived by webhook recorded something a tap that arrived by long poll did not",
    );
  });
}

test("an unmapped account is refused identically on both transports (APRV-424)", async () => {
  const polled = await tapThrough("poll", { decision: "grant", fromId: UNMAPPED_ACCOUNT });
  const hooked = await tapThrough("webhook", { decision: "grant", fromId: UNMAPPED_ACCOUNT });

  for (const [where, run] of [
    ["poll", polled],
    ["webhook", hooked],
  ] as const) {
    assert.equal(run.appended.length, 1, `${where}: expected exactly the refusal's audit record`);
    const record = run.appended[0] as EventRecord;
    assert.equal(
      record.event,
      "audit.decision_refused",
      `${where}: an unmapped account recorded ${record.event}`,
    );
    const payload = record.payload as Record<string, unknown>;
    assert.equal(payload["code"], "sender-unmapped", `${where}: the wrong refusal code`);
  }

  const left = normalize(polled.appended[0] as EventRecord, "poll");
  const right = normalize(hooked.appended[0] as EventRecord, "webhook");
  // The refusal message quotes the action key, which is per fixture; compare
  // everything else.
  for (const side of [left, right]) {
    const payload = side["payload"] as Record<string, unknown>;
    payload["message"] = "<message>";
    payload["action_key"] = "<action_key>";
    side["action_key"] = "<action_key>";
  }
  assert.deepEqual(right, left, "the two transports refused an unmapped account differently");
});

// ---------------------------------------------------------------------------
// The secret
// ---------------------------------------------------------------------------

test("a post without the matching secret is refused, and appends nothing (APRV-424)", async () => {
  const now = at(2);
  const world = live(1, false, "forged");
  const key = world.keys[0] as string;
  const [pending] = queueOf(world, now);
  assert.ok(pending !== undefined);

  const channel = channelFor();
  channel.onDecision(handlerFor(world, now));
  await channel.notify(pending);
  const update = JSON.stringify({
    update_id: 6001,
    ...callbackUpdate({
      data: mock.callbackDataFor(key, "grant"),
      chatId: CHAT,
      fromId: MAPPED_ACCOUNT,
    }),
  });

  const handle = await receiverFor(channel);
  try {
    const before = recordsOf(world.unit.logPath).length;

    const missing = await post(handle, update, { secret: null });
    assert.equal(missing.status, 401, "a post with no secret header was not refused");
    assert.equal(refusalCodeOf(missing), "webhook-secret-mismatch");

    const wrong = await post(handle, update, { secret: `${SECRET}x` });
    assert.equal(wrong.status, 401);
    assert.equal(refusalCodeOf(wrong), "webhook-secret-mismatch");

    const shorter = await post(handle, update, { secret: "x" });
    assert.equal(refusalCodeOf(shorter), "webhook-secret-mismatch");

    const twice = await rawPost(handle, update, {
      [TELEGRAM_SECRET_HEADER]: [SECRET, SECRET],
    });
    assert.equal(twice.status, 401);
    assert.equal(
      refusalCodeOf(twice),
      "webhook-duplicate-secret-header",
      "two secret headers must be refused rather than resolved by choosing one",
    );

    // Nothing at all reached the log, and the request is still pending: a
    // forgery is a fact about this transport and never a record in the log it
    // is trying to write to.
    assert.equal(
      recordsOf(world.unit.logPath).length,
      before,
      "a refused post appended to the log; an endpoint the internet can reach must not be able to grow it",
    );
    assert.equal(queueOf(world, at(3)).length, 1, "the request stopped being pending");
    assert.equal(handle.stats().refusals["webhook-secret-mismatch"], 3);
    assert.equal(handle.stats().refusals["webhook-duplicate-secret-header"], 1);
    assert.equal(handle.stats().updates, 0, "a refused post reached the channel");

    // And the good one still works, so the four above refused the secret and
    // not the request.
    const good = await post(handle, update);
    assert.equal(good.status, 200, JSON.stringify(good));
    assert.equal(recordsOf(world.unit.logPath).length, before + 1);
  } finally {
    await handle.close();
  }
  assertClean(world.unit);
});

test("the secret is in no response body and no complaint (APRV-424)", async () => {
  const channel = channelFor();
  channel.onDecision(() => {
    throw new Error("no decision should be reached by this case");
  });
  const handle = await receiverFor(channel);
  const seen: string[] = [];
  try {
    for (const secret of [null, `${SECRET}-wrong`, SECRET]) {
      const answer = await post(handle, "{}", { secret });
      seen.push(JSON.stringify(answer.body));
    }
    const answer = await post(handle, "not json");
    seen.push(JSON.stringify(answer.body));
  } finally {
    await handle.close();
  }
  for (const body of seen) {
    assert.ok(!body.includes(SECRET), `a response body carried the secret: ${body}`);
  }
  for (const complaint of complaints) {
    assert.ok(!complaint.includes(SECRET), `a complaint carried the secret: ${complaint}`);
  }
});

test("registering carries the secret to setWebhook, and removing it frees the bot (APRV-424)", async () => {
  const channel = channelFor();
  // The command handler is what makes the channel read `message` updates, so
  // the registered `allowed_updates` must be the list the poller would have
  // asked for. One function answers both, and this asserts the webhook does
  // not freeze a stale copy of it at registration time.
  channel.onCommand(() => undefined);
  const url = "https://gate.example/telegram/webhook";

  await channel.registerWebhook(url, SECRET);
  assert.deepEqual(
    mock.webhookRegistration(),
    { url, secretToken: SECRET },
    "setWebhook was not called with the url and the secret this runtime compares",
  );
  const call = mock.requests.filter((entry) => entry.method === "setWebhook").at(-1);
  assert.ok(call !== undefined);
  assert.deepEqual(
    call.body["allowed_updates"],
    channel.allowedUpdates(),
    "the registration asked for update types the poller would not have asked for",
  );
  assert.equal(
    call.body["drop_pending_updates"],
    false,
    "registering dropped the taps that arrived while nothing was serving",
  );

  // The Bot API now reports it, which is what the listener preflight reads in
  // order to refuse a poller. The count is whatever the mock is holding; the
  // URL is the fact the refusal turns on.
  const info = await channel.webhookInfo();
  assert.equal(info.url, url, "getWebhookInfo does not report the registration");
  assert.equal(typeof info.pendingUpdateCount, "number");

  // A failure description that quotes the secret reaches the operator
  // REDACTED. This is the one call that sends the value, so it is the one
  // place it could be printed.
  mock.fail("echo-secret");
  let thrown = "";
  try {
    await channel.registerWebhook(url, SECRET);
  } catch (cause) {
    thrown = cause instanceof Error ? cause.message : String(cause);
  } finally {
    mock.fail(null);
  }
  assert.ok(thrown.length > 0, "an ok:false setWebhook did not throw");
  assert.ok(!thrown.includes(SECRET), `the failure printed the secret: ${thrown}`);
  assert.match(thrown, /<webhook secret redacted>/u);

  await channel.deleteWebhook();
  assert.equal(mock.webhookRegistration(), null, "deleteWebhook left the registration in place");
  assert.equal(
    (await channel.webhookInfo()).url,
    "",
    "the bot is still webhook-held after deleteWebhook, so no poller could start",
  );
  const removal = mock.requests.filter((entry) => entry.method === "deleteWebhook").at(-1);
  assert.equal(
    removal?.body["drop_pending_updates"],
    false,
    "removing the webhook dropped the taps that had arrived for it",
  );
});

test("secretMatches and secretHeaderOf answer the shapes a request can take", () => {
  assert.equal(secretMatches(SECRET, SECRET), true);
  assert.equal(secretMatches(SECRET, null), false);
  assert.equal(secretMatches(SECRET, ""), false);
  // Length-independent: a longer and a shorter offer both answer false rather
  // than throwing, which is what keeps the length out of the answer.
  assert.equal(secretMatches(SECRET, SECRET.slice(0, 4)), false);
  assert.equal(secretMatches(SECRET, `${SECRET}${SECRET}`), false);

  assert.equal(secretHeaderOf([]), null);
  assert.equal(secretHeaderOf(["content-type", "application/json"]), null);
  assert.equal(secretHeaderOf(["X-Telegram-Bot-Api-Secret-Token", "abc"]), "abc");
  assert.equal(
    secretHeaderOf(["x-telegram-bot-api-secret-token", "a", "X-Telegram-Bot-Api-Secret-Token", "b"]),
    "duplicate",
  );
});

// ---------------------------------------------------------------------------
// The rest of the frozen refusal vocabulary
// ---------------------------------------------------------------------------

test("every other refusal this receiver makes has its own code (APRV-424)", async () => {
  const channel = channelFor();
  channel.onDecision(() => {
    throw new Error("no decision should be reached by this case");
  });
  const handle = await receiverFor(channel);
  const seen = new Set<string | null>();
  try {
    seen.add(refusalCodeOf(await post(handle, "{}", { path: "/nowhere" })));
    seen.add(refusalCodeOf(await post(handle, "{}", { method: "GET" })));
    seen.add(refusalCodeOf(await post(handle, "not json at all")));
    seen.add(refusalCodeOf(await post(handle, JSON.stringify([1, 2, 3]))));
    const oversized = await post(
      handle,
      JSON.stringify({ update_id: 1, filler: "x".repeat(TELEGRAM_WEBHOOK_MAX_BODY_BYTES + 1024) }),
    );
    seen.add(refusalCodeOf(oversized));
    assert.equal(oversized.status, 413, "an oversized body must be refused, not accepted");
  } finally {
    await handle.close();
  }

  assert.deepEqual(
    [...seen].sort(),
    [
      "webhook-body-too-large",
      "webhook-body-unreadable",
      "webhook-method-not-allowed",
      "webhook-not-an-update",
      "webhook-unknown-path",
    ],
    "the receiver collapsed two different facts into one code, or invented one",
  );
  for (const code of seen) {
    assert.ok(
      TELEGRAM_WEBHOOK_REFUSAL_CODES.includes(code as TelegramWebhookRefusalCode),
      `${String(code)} is not in the frozen union`,
    );
  }
});

test("a valid update whose callback is not ours is ignored, not refused (APRV-424)", async () => {
  const world = live(1, false, "foreign");
  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  const handle = await receiverFor(channel);
  try {
    const before = recordsOf(world.unit.logPath).length;
    const answer = await post(
      handle,
      JSON.stringify({
        update_id: 7001,
        ...callbackUpdate({ data: "g:nope:0000000000000000", chatId: "31337" }),
      }),
    );
    // The transport accepted it; the CHANNEL ignored it, which is the
    // foreign-chat anomaly and is counted there rather than here.
    assert.equal(answer.status, 200, JSON.stringify(answer));
    assert.equal(answer.body["ignored"], 1);
    assert.equal(answer.body["decisions"], 0);
    assert.equal(channel.anomalyCount("foreign-chat"), 1);
    assert.equal(recordsOf(world.unit.logPath).length, before, "an ignored callback reached the log");
  } finally {
    await handle.close();
  }
});

// ---------------------------------------------------------------------------
// One transport per bot
// ---------------------------------------------------------------------------

test("a channel already polling refuses to serve a webhook, and the reverse (APRV-424)", async () => {
  const polling = channelFor();
  polling.onDecision(() => {
    throw new Error("unreachable");
  });
  await polling.pollOnce();
  const claim = polling.claimTransport("webhook");
  assert.equal(claim.ok, false, "a polling channel accepted a webhook claim");
  if (!claim.ok) assert.equal(claim.code, "transport-conflict");
  await assert.rejects(
    async () => {
      await receiverFor(polling);
    },
    /already receiving updates by poll/u,
    "the receiver bound a port for a channel that cannot receive",
  );

  const hooked = channelFor();
  const handle = await receiverFor(hooked);
  try {
    await assert.rejects(
      async () => {
        await hooked.pollOnce();
      },
      TelegramTransportError,
      "a webhook channel accepted a poll",
    );
  } finally {
    await handle.close();
  }
});

/**
 * A listener setup built through the real `prepareListen`, for the preflight.
 *
 * The bot credentials are read from the process environment by `prepareListen`
 * itself (nothing under `channels/` reads one), so they are set for the call
 * and removed afterwards.
 *
 * `allowCrossInstance` is on because this suite deliberately builds a fresh
 * gate per case against ONE mock bot, which is the shape the per-machine
 * ownership registry refuses (APRV-390, and rightly). What these cases are
 * about is the transport exclusion that sits in front of that refusal, so the
 * ownership half is waved through out loud, exactly as an operator running two
 * gates on one bot would have to.
 */
function listenSetupFor(world: Live): ListenSetup {
  process.env["APPROVAL_TG_TOKEN"] = TOKEN;
  process.env["APPROVAL_TG_CHAT"] = CHAT;
  process.env["APPROVAL_HUMAN"] = LAUNCH_HUMAN;
  try {
    const prepared = prepareListen({
      logPath: world.unit.logPath,
      policy: { file: world.unit.policyPath },
      as: null,
      payloads: null,
      apiBase: assertLocal(mock.url),
      pollTimeout: null,
      once: true,
      json: false,
      allowCrossInstance: true,
      log: (message) => complaints.push(message),
    });
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    if (!prepared.ok) assert.fail("prepareListen refused a complete configuration");
    return prepared.setup;
  } finally {
    delete process.env["APPROVAL_TG_TOKEN"];
    delete process.env["APPROVAL_TG_CHAT"];
    delete process.env["APPROVAL_HUMAN"];
  }
}

/** A pid that is not this process and is running: init, on every platform. */
const FOREIGN_LIVE_PID = 1;

test("a poller already running in this gate refuses the webhook verb (APRV-424)", async () => {
  // THE FINDING, reproduced. Nothing is registered (a poller registers
  // nothing), and the ownership registry compares instance ids, which are
  // equal because this IS the same instance. Before the lease both processes
  // started, both ran their own dispatch cycle against one log, and every
  // prompt reached the phone twice under two nonces.
  const world = live(1, false, "lease-poll-first");
  const setup = listenSetupFor(world);
  mock.setWebhookInfo({ url: "" });

  const poller = takeChannelLease(world.unit.logPath, "poll", { pid: FOREIGN_LIVE_PID });
  assert.equal(poller.ok, true, JSON.stringify(poller));
  try {
    const refused = await claimListenerBot(setup, (message) => complaints.push(message), {
      webhookUrl: "https://gate.example/telegram/webhook",
      mode: "webhook",
    });
    assert.equal(refused.ok, false, "a webhook runner started beside a live poller in one gate");
    if (!refused.ok) {
      assert.equal(refused.code, "telegram-poller-running");
      assert.match(refused.message, new RegExp(`pid ${String(FOREIGN_LIVE_PID)}`, "u"));
      assert.match(refused.message, /poll mode/u);
    }
    // The refused start took nothing: the poller still holds the gate.
    assert.equal(readChannelLease(world.unit.logPath)?.pid, FOREIGN_LIVE_PID);
  } finally {
    if (poller.ok) poller.lease.release();
  }
});

test("a webhook already running in this gate refuses a poller (APRV-424)", async () => {
  const world = live(1, false, "lease-webhook-first");
  const setup = listenSetupFor(world);
  // Deliberately BEFORE the registration exists: a webhook runner holds the
  // lease from its preflight onward, so the window between "the verb started"
  // and "setWebhook returned" is covered too.
  mock.setWebhookInfo({ url: "" });

  const hooked = takeChannelLease(world.unit.logPath, "webhook", { pid: FOREIGN_LIVE_PID });
  assert.equal(hooked.ok, true, JSON.stringify(hooked));
  try {
    const refused = await claimListenerBot(setup, (message) => complaints.push(message));
    assert.equal(refused.ok, false, "a poller started beside a live webhook runner in one gate");
    if (!refused.ok) {
      // The same code the Bot API probe produces, because the repair is the
      // same: stop the webhook runner, which removes its registration too.
      assert.equal(refused.code, "webhook-registered");
      assert.match(refused.message, new RegExp(`pid ${String(FOREIGN_LIVE_PID)}`, "u"));
      assert.match(refused.message, /webhook mode/u);
    }
  } finally {
    if (hooked.ok) hooked.lease.release();
  }
});

test("the preflight releases the lease when a later check refuses (APRV-424)", async () => {
  const world = live(1, false, "lease-released-on-refusal");
  const setup = listenSetupFor(world);
  // A registration a poller cannot live with: the lease is taken first, and
  // the refusal that follows must not leave it behind for the next process to
  // reclaim.
  mock.setWebhookInfo({ url: "https://gate.example/telegram/webhook", pendingUpdateCount: 1 });
  try {
    const refused = await claimListenerBot(setup, (message) => complaints.push(message));
    assert.equal(refused.ok, false);
    assert.equal(
      readChannelLease(world.unit.logPath),
      null,
      "a refused start left its transport lease behind",
    );
    assert.equal(existsSync(channelLeasePathFor(world.unit.logPath)), false);
  } finally {
    mock.setWebhookInfo({ url: "" });
  }
});

test("a successful preflight holds the lease until it is released (APRV-424)", async () => {
  const world = live(1, false, "lease-held");
  const setup = listenSetupFor(world);
  mock.setWebhookInfo({ url: "" });

  const claimed = await claimListenerBot(setup, (message) => complaints.push(message));
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  if (!claimed.ok) return;
  const held = readChannelLease(world.unit.logPath);
  assert.equal(held?.pid, process.pid, "the preflight took no lease");
  assert.equal(held?.mode, "poll", "a poller's preflight took the wrong mode");

  claimed.lease.release();
  assert.equal(
    readChannelLease(world.unit.logPath),
    null,
    "a clean stop left the gate's transport lease behind",
  );
});

test("a registration refuses the webhook verb unless --reclaim (APRV-424)", async () => {
  // Review finding 6. "Same URL means it is me" was a bare string compare, so
  // two hosts running one configuration both read the other's registration as
  // their own restart: the second overwrote the first's secret_token, and from
  // then on every real tap arrived at the first host as a forgery.
  const world = live(1, false, "reclaim");
  const setup = listenSetupFor(world);
  const mine = "https://gate.example/telegram/webhook";
  try {
    mock.setWebhookInfo({ url: mine, pendingUpdateCount: 2 });

    const sameUrl = await claimListenerBot(setup, (message) => complaints.push(message), {
      webhookUrl: mine,
      mode: "webhook",
    });
    assert.equal(sameUrl.ok, false, "a webhook registered at this url was waved through as a restart");
    if (!sameUrl.ok) {
      assert.equal(sameUrl.code, "webhook-registered");
      assert.match(sameUrl.message, /--reclaim/u);
      assert.match(sameUrl.message, /one webhook per bot/u);
      assert.match(sameUrl.message, /take the taps|takes the taps|forgery/u);
    }

    const otherUrl = await claimListenerBot(setup, (message) => complaints.push(message), {
      webhookUrl: "https://other.example/telegram/webhook",
      mode: "webhook",
    });
    assert.equal(otherUrl.ok, false);
    if (!otherUrl.ok) assert.equal(otherUrl.code, "webhook-registered");

    // Neither refusal held the gate.
    assert.equal(readChannelLease(world.unit.logPath), null);

    // --reclaim is how an operator takes it deliberately, at the same url and
    // at a different one, and the normalised compare is what decides which
    // sentence they read: a trailing slash and an upper-case host are the same
    // endpoint.
    for (const [label, url] of [
      ["the same url", mine],
      ["the same url spelled differently", "https://GATE.example/telegram/webhook/"],
      ["a different url", "https://second.example/telegram/webhook"],
    ] as const) {
      const before = complaints.length;
      const reclaimed = await claimListenerBot(setup, (message) => complaints.push(message), {
        webhookUrl: url,
        reclaim: true,
        mode: "webhook",
      });
      assert.equal(reclaimed.ok, true, `--reclaim refused ${label}: ${JSON.stringify(reclaimed)}`);
      if (reclaimed.ok) reclaimed.lease.release();
      const said = complaints.slice(before).join("\n");
      assert.match(said, /--reclaim/u, `${label} reclaimed silently`);
      assert.match(
        said,
        label === "a different url" ? /stops being posted to/u : /re-registering/u,
        `${label} was reported as the wrong kind of reclaim: ${said}`,
      );
    }

    assert.equal(
      normaliseWebhookUrl("https://GATE.example/telegram/webhook/"),
      normaliseWebhookUrl(mine),
      "two spellings of one endpoint do not compare equal",
    );
    assert.notEqual(
      normaliseWebhookUrl("https://gate.example/telegram/Webhook"),
      normaliseWebhookUrl(mine),
      "a path's case was folded, and a webhook path is often a random token",
    );
  } finally {
    mock.setWebhookInfo({ url: "" });
  }
});

test("a listener refuses to start against a bot a webhook holds (APRV-424)", async () => {
  const world = live(1, false, "exclusive");
  const setup = listenSetupFor(world);
  try {
    // No webhook: the preflight lets it through (the ownership claim may or
    // may not succeed on a shared machine, so only the webhook code is
    // asserted about).
    mock.setWebhookInfo({ url: "" });
    const clear = await claimListenerBot(setup, (message) => complaints.push(message));
    if (!clear.ok) assert.notEqual(clear.code, "webhook-registered");
    else clear.lease.release();

    mock.setWebhookInfo({ url: "https://gate.example/telegram/webhook", pendingUpdateCount: 3 });
    const blocked = await claimListenerBot(setup, (message) => complaints.push(message));
    assert.equal(blocked.ok, false, "a listener started against a bot a webhook holds");
    if (!blocked.ok) {
      assert.equal(blocked.code, "webhook-registered");
      assert.match(blocked.message, /gate\.example/u);
      assert.match(blocked.message, /3 update\(s\)/u);
      // Origin and a redacted path, never the registered url as spelled: this
      // is another host's registration and its path may be a bearer value
      // (review finding 10).
      assert.ok(
        !blocked.message.includes("/telegram/webhook"),
        `the refusal quoted another host's webhook path: ${blocked.message}`,
      );
      assert.match(blocked.message, /path redacted/u);
    }
  } finally {
    mock.setWebhookInfo({ url: "" });
  }
});

// ---------------------------------------------------------------------------
// The verb's own preparation
// ---------------------------------------------------------------------------

function prepareWith(
  world: Live,
  overrides: Partial<Parameters<typeof prepareWebhook>[0]> = {},
): ReturnType<typeof prepareWebhook> {
  return prepareWebhook({
    logPath: world.unit.logPath,
    policy: { file: world.unit.policyPath },
    as: LAUNCH_HUMAN,
    payloads: null,
    apiBase: assertLocal(mock.url),
    json: false,
    url: "https://gate.example/telegram/webhook",
    path: null,
    host: "127.0.0.1",
    port: 0,
    cycle: null,
    env: {
      APPROVAL_TG_TOKEN: TOKEN,
      APPROVAL_TG_CHAT: CHAT,
      [TELEGRAM_WEBHOOK_SECRET_ENV]: SECRET,
    },
    log: (message) => complaints.push(message),
    ...overrides,
  });
}

test("the webhook verb refuses every configuration it cannot serve (APRV-424)", () => {
  const world = live(1, false, "prepare");
  process.env["APPROVAL_TG_TOKEN"] = TOKEN;
  process.env["APPROVAL_TG_CHAT"] = CHAT;
  try {
    const ok = prepareWith(world);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    if (ok.ok) {
      assert.equal(ok.setup.secret, SECRET);
      assert.equal(ok.setup.path, "/telegram/webhook", "the path defaults to the url's own");
      assert.equal(ok.setup.listen.actor, LAUNCH_HUMAN);
    }

    const cases: [string, Partial<Parameters<typeof prepareWebhook>[0]>, WebhookRefusalCode][] = [
      [
        "no secret",
        { env: { APPROVAL_TG_TOKEN: TOKEN, APPROVAL_TG_CHAT: CHAT } },
        "webhook-secret-missing",
      ],
      [
        "a memorable secret",
        {
          env: {
            APPROVAL_TG_TOKEN: TOKEN,
            APPROVAL_TG_CHAT: CHAT,
            [TELEGRAM_WEBHOOK_SECRET_ENV]: "hunter2",
          },
        },
        "webhook-secret-weak",
      ],
      [
        "a secret Telegram will not take",
        {
          env: {
            APPROVAL_TG_TOKEN: TOKEN,
            APPROVAL_TG_CHAT: CHAT,
            [TELEGRAM_WEBHOOK_SECRET_ENV]: `${SECRET}/with/slashes`,
          },
        },
        "webhook-secret-charset",
      ],
      ["no url", { url: null }, "webhook-url-missing"],
      ["a plain-http url", { url: "http://gate.example/hook" }, "webhook-url-insecure"],
      ["a url that is not one", { url: "gate.example/hook" }, "webhook-url-insecure"],
      ["a port Telegram will not deliver to", { url: "https://gate.example:9443/hook" }, "webhook-url-port"],
      ["a cycle that is not a duration", { cycle: "soonish" }, "webhook-cycle"],
    ];
    for (const [label, overrides, code] of cases) {
      const refused = prepareWith(world, overrides);
      assert.equal(refused.ok, false, `${label} was accepted`);
      if (!refused.ok) {
        assert.equal(refused.code, code, `${label} refused ${refused.code}`);
        assert.ok(
          WEBHOOK_REFUSAL_CODES.includes(refused.code as WebhookRefusalCode),
          `${refused.code} is not in the frozen union`,
        );
        assert.ok(
          !refused.message.includes(SECRET),
          `the ${label} refusal quoted the secret: ${refused.message}`,
        );
      }
    }

  } finally {
    delete process.env["APPROVAL_TG_TOKEN"];
    delete process.env["APPROVAL_TG_CHAT"];
  }

  // A listener refusal reaches this verb unchanged: the two need the same bot
  // token, chat, identity, log and policy, and say so in one voice. The bot
  // credentials are read from the process environment by `prepareListen`
  // itself (nothing under `channels/` reads one, and the CLI is where that
  // happens), so this case runs with them unset rather than with an injected
  // map.
  const unconfigured = prepareWith(world, {
    env: { [TELEGRAM_WEBHOOK_SECRET_ENV]: SECRET },
  });
  assert.equal(unconfigured.ok, false, "a webhook runner was prepared with no bot token at all");
  if (!unconfigured.ok) assert.equal(unconfigured.code, "not-configured");
});

test("the webhook help names the bind, the secret variable and the proxy (APRV-424)", () => {
  assert.match(TELEGRAM_WEBHOOK_HELP, /approval channel telegram webhook — /u);
  assert.match(TELEGRAM_WEBHOOK_HELP, new RegExp(TELEGRAM_WEBHOOK_SECRET_ENV, "u"));
  assert.match(TELEGRAM_WEBHOOK_HELP, /proxy or tunnel you own/u);
  assert.match(
    TELEGRAM_WEBHOOK_HELP,
    new RegExp(String(TELEGRAM_WEBHOOK_DEFAULT_PORT), "u"),
    "the help names a default port the code does not use",
  );
  assert.ok(
    WEBHOOK_MIN_SECRET_LENGTH >= 24,
    "the floor under a generated secret was lowered without a task",
  );
  assert.equal(TELEGRAM_WEBHOOK_DEFAULT_PATH, "/telegram/webhook");
});

// ---------------------------------------------------------------------------
// The conformance suite, driven through the webhook
// ---------------------------------------------------------------------------

let conformanceCounter = 0;
const conformanceChannels: TelegramChannel[] = [];

/**
 * The shared suite (`channels/conformance.ts`), with its `decide` running over
 * HTTP.
 *
 * Its own doc names this case: "press the button, answer the prompt, POST the
 * webhook — whatever makes the channel invoke the handler it was given". This
 * is the POST, and it is what acceptance criterion 4 means by the conformance
 * suite passing on this transport.
 */
const harness: ConformanceHarness = {
  setup(count: number): ConformanceCase {
    conformanceCounter += 1;
    const now = at(2 + conformanceCounter);
    const world = live(count, false, `conformance-${conformanceCounter}`);
    const requests = queueOf(world, now);
    assert.equal(requests.length, count, "the harness could not build the requested queue");
    return {
      logPath: world.unit.logPath,
      requests,
      actor: { actor: LAUNCH_HUMAN, channel: "telegram" },
      gateOptions: { ...world.unit.options, clock: fixedClock(now) },
    };
  },
  async decide(channel, decision) {
    const telegram = channel as TelegramChannel;
    const handle = await receiverFor(telegram);
    try {
      const update = callbackUpdate({
        data: mock.callbackDataFor(decision.action_key, decision.decision),
        chatId: CHAT,
        fromId: MAPPED_ACCOUNT,
      });
      conformanceCounter += 1;
      const answer = await post(
        handle,
        JSON.stringify({ update_id: 8000 + conformanceCounter, ...update }),
      );
      assert.equal(answer.status, 200, JSON.stringify(answer));
    } finally {
      await handle.close();
    }
    const outcome = telegram
      .lastRendered()
      .find((entry) => entry.action_key === decision.action_key);
    assert.ok(outcome !== undefined, "the channel rendered nothing for the decided request");
    // The suite wants the DecisionOutcome the handler produced. The receiver
    // does not hand one back (its answer is an HTTP response), so the outcome
    // is read from the log the gate just wrote, through the same verified read
    // every other caller uses.
    return lastOutcomeFor(decision);
  },
};

/** The outcome of the decision the webhook just drove, read off the log. */
function lastOutcomeFor(decision: ChannelDecision): DecisionOutcome {
  const world = conformanceWorlds.get(decision.action_key);
  assert.ok(world !== undefined, "no conformance world holds that action key");
  const records = recordsOf(world);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index] as EventRecord;
    if (record.action_key !== decision.action_key) continue;
    if (record.event === "approval.granted" || record.event === "approval.rejected") {
      return {
        ok: true,
        action_key: decision.action_key,
        decision: decision.decision,
        state: record.event === "approval.granted" ? "granted" : "rejected",
        record,
        tokenIssued: record.event === "approval.granted",
      };
    }
  }
  assert.fail(`no decision was recorded for ${decision.action_key}`);
}

const conformanceWorlds = new Map<string, string>();

test("the telegram channel passes the shared conformance suite over the webhook", async (t) => {
  await runChannelConformance(
    t,
    () => {
      const channel = channelFor();
      conformanceChannels.push(channel);
      return channel;
    },
    {
      ...harness,
      setup(count: number) {
        const unit = harness.setup(count) as ConformanceCase;
        for (const request of unit.requests) {
          conformanceWorlds.set(request.action_key.value, unit.logPath);
        }
        return unit;
      },
    },
  );
});
