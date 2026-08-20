/**
 * Telegram channel tests (APRV-26).
 *
 * Every case runs against the local mock Bot API in `tests/telegram-mock.ts`
 * and **never against the real network**: `assertLocal()` checks the `apiBase`
 * of every channel this file constructs, and the channel has no other way to
 * reach Telegram. The real-network path is the documented manual script in
 * APRV-27.
 *
 * Same discipline as every other suite here: no log line is written by hand.
 * The policy is attested through `core/attest.ts`, tasks are registered and
 * requested through `core/gate.ts`, and every decision goes through
 * `recordChannelDecision` → the human-only `decide()` — including the ones
 * driven by a simulated button press.
 *
 * The tests that matter most are the negative ones: a callback from a chat we
 * do not answer to must produce **no event at all**, a second tap must produce
 * no second event, and the listener must still be listening after the mock has
 * timed out, dropped a socket, returned a 500, answered with garbage, and been
 * killed outright.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  recordChannelDecision,
  type ChannelDecision,
  type ChannelRequest,
  type DecisionOutcome,
} from "../src/channels/contract.js";
import {
  runChannelConformance,
  type ConformanceCase,
  type ConformanceHarness,
} from "../src/channels/conformance.js";
import {
  changePayloadView,
  emailPayloadFields,
  payloadRegionText,
  BODY_BEGIN,
  BODY_END,
  CANONICAL_JSON_HEADING,
  DIFF_LINE_BUDGET,
  EDIT_VIEW_HEADING,
  EMAIL_VIEW_HEADING,
  LIVE_QUALIFIER,
  PROPOSAL_QUALIFIER,
} from "../src/channels/payload-view.js";
import { assembleBatch } from "../src/channels/batch.js";
import { buildPendingQueue, type TagOptions } from "../src/channels/tagging.js";
import {
  callbackData,
  parseCallbackData,
  TelegramChannel,
  TELEGRAM_MAX_CALLBACK_BYTES,
  type TelegramConfig,
} from "../src/channels/telegram.js";
import {
  dispatchPending,
  newDispatchState,
  type ListenSetup,
} from "../src/cli/channel-telegram.js";
import type { Streams } from "../src/cli/main.js";
import { appendAttestation } from "../src/core/attest.js";
import { register as registerCore, request as requestCore } from "../src/core/gate.js";
import { payloadHash } from "../src/core/payload.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { expire, register, request, withdraw } from "./clock-adapters.js";
import {
  assertLocal,
  callbackUpdate,
  startMockBotApi,
  type MockBotApi,
  type MockFailure,
} from "./telegram-mock.js";
import { assertClean, at, attest, fixedClock, newScenario, scratchRoot, T0, type Scenario } from "./scenario.js";

/** dist/tests/channels-telegram.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = scratchRoot("channels-telegram");

/**
 * A plausible-looking but entirely fake bot token.
 *
 * Distinctive enough that the "never anywhere" scans cannot pass by accident,
 * and obviously not a credential to anyone reading the file.
 */
const TOKEN = "7654321:AA-approval-md-fake-token-for-tests-only-DO-NOT-USE";
const CHAT = "9911";
const OTHER_CHAT = "31337";

const TASK = "task-100";
const ACTOR = "agent:drafter";
const HUMAN = "human:carter";

const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "24h"',
  "  on_expiry: reject",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  communicate.email.external:",
  "    autonomy: manual",
  "    limits:",
  "      per_action_usd: 1",
  "      daily_actions: 5",
  "```",
  "",
].join("\n");

let mock: MockBotApi;

before(async () => {
  mock = await startMockBotApi(TOKEN);
});

after(async () => {
  await mock.close();
  scratch.cleanup();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * An email-shaped payload, in the shape `adapters/email.ts` executes.
 *
 * Deliberately awkward, because this is the value the approver reads: the
 * subject carries markup that must never become markup, the body is multi-line
 * (the APRV-100 complaint: a JSON rendering shows those breaks as literal `\n`)
 * and carries a `£`, which must survive byte for byte through escaping,
 * chunking and the mock transport.
 */
function payloadFor(index: number): Record<string, unknown> {
  return {
    from: "ap@approval.example",
    to: [`ap-${index}@vendor.example`],
    subject: `Invoice ${41 + index} chaser <urgent> & overdue`,
    body: [
      `Following up on invoice ${41 + index}, now ${14 + index} days overdue.`,
      "",
      `The balance is £1,200 <b>including</b> VAT & late fees.`,
      "",
      "Thanks,",
      "Accounts",
    ].join("\n"),
  };
}

function actionKeyFor(prefix: string, index: number): string {
  return `${TASK}:${prefix}-${index}`;
}

interface Live {
  unit: Scenario;
  keys: string[];
  payloads: Map<string, unknown>;
  tagOptions: TagOptions;
}

let fixtureCounter = 0;

/**
 * `count` live manual requests in a fresh log, built through the real gate.
 *
 * `realClock` builds them at the actual current instant, which the subprocess
 * cases need: a child process cannot be handed an injected clock, so a fixture
 * pinned to 2026-08-05 would be long expired by the time its own TTL was
 * judged against the wall clock.
 */
function live(
  count: number,
  realClock = false,
  /** The payload each request binds to. Overridden by the APRV-124 cases. */
  makePayload: (index: number) => Record<string, unknown> = payloadFor,
): Live {
  fixtureCounter += 1;
  const prefix = `chaser${fixtureCounter}`;
  const unit = newScenario(scratch.root, POLICY);

  if (realClock) {
    const attested = appendAttestation(unit.logPath, unit.policyPath, HUMAN, {});
    assert.equal(attested.ok, true, "attestation append failed");
  } else {
    attest(unit, T0);
  }

  const payloads = new Map<string, unknown>();
  const keys: string[] = [];
  const actions = [];
  for (let index = 0; index < count; index += 1) {
    const key = actionKeyFor(prefix, index);
    const payload = makePayload(index);
    keys.push(key);
    payloads.set(key, payload);
    actions.push({
      class: "communicate.email.external",
      idempotency_key: key,
      summary: `chase invoice ${41 + index}`,
      reversible: false,
      est_cost_usd: 0.02,
      payload_hash: payloadHash(payload),
    });
  }

  const source = {
    task: TASK,
    envelope: {
      origin: { app: "manual", created_by: ACTOR },
      state: "awaiting",
      actions,
    },
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
      est_cost_usd: 0.02,
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
    payloads,
    tagOptions: { policy: { file: unit.policyPath }, payload: (key) => payloads.get(key) },
  };
}

function queueOf(world: Live, now: string): ChannelRequest[] {
  const queue = buildPendingQueue(world.unit.logPath, world.tagOptions, now);
  assert.equal(queue.ok, true, JSON.stringify(queue));
  return queue.ok ? queue.requests : [];
}

function recordsOf(logPath: string) {
  const read = readVerifiedRecords(logPath);
  assert.equal(read.ok, true, `log did not verify: ${JSON.stringify(read)}`);
  return read.ok ? read.records : [];
}

const complaints: string[] = [];

function channelFor(overrides: Partial<TelegramConfig> = {}): TelegramChannel {
  const base: TelegramConfig = {
    token: TOKEN,
    chatId: CHAT,
    apiBase: assertLocal(mock.url),
    pollTimeoutSeconds: 0,
    requestTimeoutMs: 3_000,
    backoffMs: 5,
    maxBackoffMs: 20,
    log: (message) => complaints.push(message),
  };
  return new TelegramChannel({ ...base, ...overrides } as TelegramConfig);
}

function handlerFor(
  world: Live,
  now: string,
): (decision: ChannelDecision) => DecisionOutcome {
  return (decision) =>
    recordChannelDecision(
      world.unit.logPath,
      decision,
      { actor: HUMAN, channel: "telegram" },
      { ...world.unit.options, clock: fixedClock(now) },
    ).outcome;
}

/** Press a button: queue the callback Telegram would deliver, then poll once. */
async function press(
  channel: TelegramChannel,
  actionKey: string,
  decision: "grant" | "reject",
  chatId: string = CHAT,
): Promise<DecisionOutcome | undefined> {
  mock.queueUpdate(
    callbackUpdate({ data: mock.callbackDataFor(actionKey, decision), chatId }),
  );
  const result = await channel.pollOnce();
  return result.outcomes.find((entry) => entry.action_key === actionKey)?.outcome;
}

/**
 * Every `editMessageText` the mock has received for one message id.
 *
 * The mock is shared by the whole file and `edits()` accumulates across tests,
 * so every assertion about "how many times was THIS message edited" filters by
 * its id (APRV-113: successful taps edit their own messages now, so a global
 * count is a count of the whole suite).
 */
function editsFor(messageId: string | number): { text: string; replyMarkup: unknown }[] {
  return mock.edits().filter((entry) => entry.messageId === Number(messageId));
}

/**
 * A 64-hex run: the shape of an execution token, and of nothing else this
 * channel legitimately prints (a payload sha256 is 64 hex too, which is why the
 * sweep below runs over EDITS, where no hash belongs, rather than over sends).
 */
const HEX64 = /\b[0-9a-f]{64}\b/u;

/** No edit this suite ever produced may carry anything token-shaped. */
function assertNoTokenInEdits(): void {
  for (const edit of mock.edits()) {
    assert.doesNotMatch(
      edit.text,
      HEX64,
      `an annotation carried a 64-hex run — the execution token is never sent to Telegram: ${edit.text}`,
    );
  }
}

async function until(predicate: () => boolean, label: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// The shared conformance suite (APRV-22), unmodified
// ---------------------------------------------------------------------------

let caseCounter = 0;

const harness: ConformanceHarness = {
  setup(count: number): ConformanceCase {
    caseCounter += 1;
    const world = live(count);
    const now = at(2 + caseCounter);
    const requests = queueOf(world, now);
    assert.equal(requests.length, count, "the harness could not build the requested queue");
    return {
      logPath: world.unit.logPath,
      requests,
      actor: { actor: HUMAN, channel: "telegram" },
      gateOptions: { ...world.unit.options, clock: fixedClock(now) },
    };
  },
  async decide(channel, decision) {
    const outcome = await press(
      channel as TelegramChannel,
      decision.action_key,
      decision.decision,
    );
    assert.ok(outcome !== undefined, "the callback produced no decision");
    return outcome;
  },
};

test("the telegram channel passes the shared conformance suite", async (t) => {
  await runChannelConformance(t, () => channelFor(), harness);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test("computed and claimed are separated, and the payload is sent verbatim", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  const before = mock.sentTexts().length;
  const deliveryId = await channel.notify(request_);
  assert.match(deliveryId, /^\d+$/u, "the delivery id is the message_id Telegram returned");

  const texts = mock.sentTexts().slice(before);
  const whole = texts.join("\n");
  assert.match(whole, /COMPUTED — derived by the runtime/u);
  assert.match(whole, /CLAIMED — authored by agent:drafter, NOT verified/u);
  assert.match(whole, /FULL PAYLOAD/u);
  assert.match(whole, new RegExp(`<code>${key}</code>`, "u"), "the action key is shown verbatim");

  // The payload arrives verbatim — and HTML-escaped, which is the whole reason
  // this channel uses HTML mode rather than MarkdownV2: the agent-authored
  // subject carries "<urgent> & overdue" and must not become markup.
  const rendered = channel.lastRendered();
  assert.equal(rendered.length, 1);
  const region = rendered[0]?.fullPayloadText ?? "";
  assert.match(region, /Invoice 41 chaser <urgent> & overdue/u);
  assert.match(whole, /Invoice 41 chaser &lt;urgent&gt; &amp; overdue/u);
  assert.equal(whole.includes("<urgent>"), false, "raw markup reached the message");

  // §10.4: the payload region is not the agent's summary.
  assert.notEqual(rendered[0]?.fullPayloadText, request_.summary.value);

  // Every message stays inside Telegram's limit.
  for (const text of texts) {
    assert.ok(text.length <= 4096, `a message exceeded Telegram's 4096-character limit`);
  }

  // And nothing was written to the log by rendering it.
  assert.equal(recordsOf(world.unit.logPath).length, 3);
  assert.ok(key.length > 0);
});

test("an email-shaped payload is rendered field by field, body as the human reads it", async () => {
  const world = live(1);
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  const before = mock.sentTexts().length;
  await channel.notify(request_);
  const whole = mock.sentTexts().slice(before).join("\n");

  // The labelled fields, in order, escaped exactly as everything else is.
  assert.match(whole, /\nfrom: ap@approval\.example\n/u);
  assert.match(whole, /\nto: ap-0@vendor\.example\n/u);
  assert.match(whole, /\nsubject: Invoice 41 chaser &lt;urgent&gt; &amp; overdue\n/u);
  assert.equal(whole.includes("<urgent>"), false, "raw markup reached the message");
  assert.equal(whole.includes("<b>including</b>"), false, "raw markup reached the message");

  // The body region: real line breaks, escaped markup, non-ASCII untouched.
  const start = whole.indexOf(BODY_BEGIN);
  const end = whole.indexOf(BODY_END);
  assert.ok(start > 0 && end > start, "the body block delimiters are missing");
  const body = whole.slice(start + BODY_BEGIN.length + 1, end);
  assert.equal(
    body,
    [
      "Following up on invoice 41, now 14 days overdue.",
      "",
      "The balance is £1,200 &lt;b&gt;including&lt;/b&gt; VAT &amp; late fees.",
      "",
      "Thanks,",
      "Accounts",
      "",
    ].join("\n"),
    "the body is not rendered as the human will read it",
  );
  assert.equal(body.includes("\\n"), false, "the body still carries literal \\n escapes");
  assert.ok(whole.includes("£1,200"), "the non-ASCII amount did not survive verbatim");

  // The exact bytes are still on screen, underneath, JSON escapes and all.
  assert.ok(whole.includes(CANONICAL_JSON_HEADING), "the canonical JSON was dropped");
  assert.match(whole, /"body": "Following up on invoice 41[^"]*\\n/u);

  // And the binding line — the one computed thing in this region — is intact.
  assert.match(
    whole,
    new RegExp(`payload sha256:</b> ${request_.payload_hash.value}`, "u"),
    "the computed binding line changed",
  );
  assert.ok(
    whole.includes(`--- full payload (sha256 ${request_.payload_hash.value}) ---`),
    "the payload region lost its hash label",
  );

  // The reading aid announces itself as claimed, so legible never reads as verified.
  assert.ok(whole.includes(EMAIL_VIEW_HEADING.replace(/&/gu, "&amp;")));

  assert.equal(recordsOf(world.unit.logPath).length, 3);
});

test("only structurally email-shaped payloads leave the JSON rendering", () => {
  const json = (value: unknown): string => JSON.stringify(value, null, 2);
  const view = (value: unknown, truncated = false): string =>
    payloadRegionText({ value, text: json(value), hash: "h", truncated });

  // Recognised: the adapter's shape, with `to` as a list or as a bare string.
  assert.notEqual(emailPayloadFields({ to: ["a@b.example"], subject: "s", body: "b" }), null);
  assert.notEqual(emailPayloadFields({ to: "a@b.example", subject: "s", body: "b" }), null);

  // A self-declared kind buys nothing: it is simply a key this view cannot
  // show, so the payload falls back to JSON rather than being half-rendered.
  const declared = { kind: "email", to: ["a@b.example"], subject: "s", body: "b" };
  assert.equal(emailPayloadFields(declared), null);
  assert.equal(view(declared), json(declared), "a self-declared field changed the rendering");

  // Wrong types, missing required fields, and non-objects all stay JSON.
  for (const value of [
    { to: [1], subject: "s", body: "b" },
    { to: ["a@b.example"], subject: "s" },
    { from: "a@b.example", subject: "s", body: "b" },
    { to: ["a@b.example"], subject: "s", body: 3 },
    ["a@b.example"],
    "just a string",
    null,
    42,
  ]) {
    assert.equal(emailPayloadFields(value), null, `wrongly recognised ${json(value)}`);
    assert.equal(view(value), json(value), `rendering changed for ${json(value)}`);
  }

  // A truncated rendering keeps today's text: `value` holds more than `text`
  // admits to showing, and expanding it here would silently un-truncate it.
  const whole = { to: ["a@b.example"], subject: "s", body: "b" };
  assert.equal(view(whole, true), json(whole));

  // `bcc` and `content_type` are shown, never dropped: a field the reader
  // cannot see is a hidden payload wearing a friendlier face.
  const full = emailPayloadFields({
    from: "a@b.example",
    to: ["c@d.example"],
    cc: ["e@f.example"],
    bcc: ["g@h.example"],
    subject: "s",
    content_type: "text/plain",
    body: "b",
  });
  assert.deepEqual(
    full?.map((field) => field.label),
    ["from", "to", "cc", "bcc", "subject", "content_type", "body"],
  );

  // `cc` is omitted when absent rather than rendered empty.
  const noCc = emailPayloadFields({ to: ["c@d.example"], subject: "s", body: "b" });
  assert.equal(
    noCc?.some((field) => field.label === "cc"),
    false,
  );
});

test("callback_data is bounded, and the nonce — not the wire's key — is authoritative", () => {
  const short = callbackData("g", "abc123", "task-1:x");
  assert.equal(short, "g:abc123:task-1:x");
  assert.deepEqual(parseCallbackData(short), {
    decision: "grant",
    nonce: "abc123",
    actionKey: "task-1:x",
  });

  const long = callbackData("r", "abc123", "task-1:".padEnd(200, "x"));
  assert.ok(
    Buffer.byteLength(long, "utf8") <= TELEGRAM_MAX_CALLBACK_BYTES,
    "callback_data must fit Telegram's 64-byte limit",
  );
  assert.deepEqual(parseCallbackData(long), {
    decision: "reject",
    nonce: "abc123",
    actionKey: null,
  });

  assert.equal(parseCallbackData("x:abc"), null);
  assert.equal(parseCallbackData("g:"), null);
  assert.equal(parseCallbackData(42), null);
});

// ---------------------------------------------------------------------------
// The token is nowhere it should not be
// ---------------------------------------------------------------------------

test("the bot token never reaches a message body, a toast, or the log", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  await channel.notify(request_);
  const outcome = await press(channel, key, "grant");
  assert.equal(outcome?.ok, true, JSON.stringify(outcome));

  // Every byte the channel sent as a BODY, and every byte in the log.
  for (const entry of mock.requests) {
    assert.equal(
      entry.raw.includes(TOKEN),
      false,
      `the token appeared in a ${entry.method} request body`,
    );
  }
  const logBytes = readFileSync(world.unit.logPath, "utf8");
  assert.equal(logBytes.includes(TOKEN), false, "the token appeared in the log");
  for (const complaint of complaints) {
    assert.equal(complaint.includes(TOKEN), false, "the token appeared on stderr");
  }

  // Where it DOES appear, necessarily: the URL. The Bot API authenticates by
  // path — https://api.telegram.org/bot<token>/<method> — and there is no
  // header form. Asserted rather than hidden, so the one place it lives is a
  // documented fact and not an oversight.
  assert.ok(
    mock.requests.every((entry) => entry.path.startsWith(`/bot${TOKEN}/`)),
    "the Bot API carries the token in the URL path; that is the only place it may be",
  );

  // And the grant's token: minted, returned to the runtime, never to the chat.
  const granted = recordsOf(world.unit.logPath).find(
    (record) => record.event === "approval.granted",
  );
  assert.ok(granted !== undefined);
  const result = recordChannelDecision(
    world.unit.logPath,
    { action_key: key, decision: "grant", deliveryId: "x" },
    { actor: HUMAN },
    { ...world.unit.options, clock: fixedClock(at(3)) },
  );
  assert.equal(result.outcome.ok, false, "a second grant must be refused");
  assertClean(world.unit);
});

// ---------------------------------------------------------------------------
// Callbacks that must never become decisions
// ---------------------------------------------------------------------------

test("a callback from an unconfigured chat is ignored, counted, and never logged", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  await channel.notify(request_);

  const before = recordsOf(world.unit.logPath).length;
  const beforeAnomalies = channel.anomalyCount("foreign-chat");

  const result = await (async () => {
    mock.queueUpdate(
      callbackUpdate({ data: mock.callbackDataFor(key, "grant"), chatId: OTHER_CHAT }),
    );
    return channel.pollOnce();
  })();

  assert.equal(result.outcomes.length, 0, "a foreign callback must produce no decision");
  assert.deepEqual(result.ignored.map((entry) => entry.kind), ["foreign-chat"]);
  assert.equal(channel.anomalyCount("foreign-chat"), beforeAnomalies + 1);
  assert.equal(
    recordsOf(world.unit.logPath).length,
    before,
    "an ignored callback must append nothing at all — not a decision, not a note",
  );
  assert.match(channel.health().detail ?? "", /ignored callback/u);
  assert.equal(channel.health().ok, true, "an anomaly is not a health failure");
  assert.match(
    mock.answerTexts().join("\n"),
    /only accepts decisions from its configured approval chat/u,
  );

  // The request is still live, and the configured chat can still decide it.
  const outcome = await press(channel, key, "grant");
  assert.equal(outcome?.ok, true, JSON.stringify(outcome));
  assertClean(world.unit);
});

test("a callback whose nonce this listener never issued is ignored", async () => {
  const world = live(1);
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);
  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  await channel.notify(request_);

  const before = recordsOf(world.unit.logPath).length;
  mock.queueUpdate(callbackUpdate({ data: "g:nosuchnonce", chatId: CHAT }));
  const unknown = await channel.pollOnce();
  assert.deepEqual(unknown.ignored.map((entry) => entry.kind), ["unknown-callback"]);

  mock.queueUpdate(callbackUpdate({ data: "not-a-callback", chatId: CHAT }));
  const malformed = await channel.pollOnce();
  assert.deepEqual(malformed.ignored.map((entry) => entry.kind), ["malformed-callback"]);

  // A well-formed nonce carrying somebody else's action key: the nonce wins,
  // and the disagreement is an anomaly rather than a decision on either key.
  const issued = mock.callbackDataFor(request_.action_key.value, "grant");
  const nonce = issued.split(":")[1] as string;
  mock.queueUpdate(callbackUpdate({ data: `g:${nonce}:task-999:elsewhere`, chatId: CHAT }));
  const mismatched = await channel.pollOnce();
  assert.deepEqual(mismatched.ignored.map((entry) => entry.kind), ["key-mismatch"]);

  assert.equal(recordsOf(world.unit.logPath).length, before, "nothing was appended");
  assertClean(world.unit);
});

test("a duplicate callback is refused and appends no second event", async () => {
  // APRV-113 changed which layer refuses the SECOND tap, deliberately. The
  // first tap's annotation forgets the delivery's nonce (that is what disarms a
  // button the edit did not manage to remove), so a redelivered callback is an
  // `unknown-callback` anomaly rather than a decision the gate then refuses as
  // `already-decided`. Both refuse; neither appends. The property this test
  // exists for — a second tap can never produce a second event — is unchanged,
  // and the gate's own idempotency is still pinned by `tests/gate.test.ts`.
  const world = live(1);
  const key = world.keys[0] as string;
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  await channel.notify(request_);

  const first = await press(channel, key, "grant");
  assert.equal(first?.ok, true, JSON.stringify(first));
  const after_ = recordsOf(world.unit.logPath).length;

  mock.queueUpdate(
    callbackUpdate({ data: mock.callbackDataFor(key, "grant"), chatId: CHAT }),
  );
  const second = await channel.pollOnce();
  assert.deepEqual(second.outcomes, [], "a second tap must reach no decision at all");
  assert.deepEqual(
    second.ignored.map((entry) => entry.kind),
    ["unknown-callback"],
  );
  assert.equal(
    recordsOf(world.unit.logPath).length,
    after_,
    "a second tap must never produce a second event",
  );
  assert.match(mock.answerTexts().join("\n"), /This button is no longer live/u);
  assertClean(world.unit);
});

// ---------------------------------------------------------------------------
// Terminal states are annotated on the message (APRV-113)
// ---------------------------------------------------------------------------

test("a tap edits its own message to the outcome and takes the buttons away", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  const messageId = await channel.notify(request_);

  const outcome = await press(channel, key, "grant");
  assert.equal(outcome?.ok, true, JSON.stringify(outcome));

  const edits = editsFor(messageId);
  assert.equal(edits.length, 1, JSON.stringify(edits));
  const text = String(edits[0]?.text);
  assert.match(text, /^<b>✓ APPROVED<\/b>\n/u);
  assert.match(text, new RegExp(`<code>${key}</code>`, "u"));
  assert.match(text, /by human:carter at \d\d:\d\d UTC \(seq \d+\)/u);
  assert.doesNotMatch(text, /APPROVAL REQUIRED/u, "the prompt text is replaced, not appended to");
  assert.equal(edits[0]?.replyMarkup, undefined, "the buttons must be gone");

  // The terminal panel is unchanged: the token goes to stdout, never to a chat.
  assertNoTokenInEdits();
  assertClean(world.unit);
});

test("a rejection edits its message too", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  const messageId = await channel.notify(request_);

  assert.equal((await press(channel, key, "reject"))?.ok, true);
  const text = String(editsFor(messageId)[0]?.text);
  assert.match(text, /^<b>✗ REJECTED<\/b>/u);
  assert.match(text, /by human:carter at \d\d:\d\d UTC \(seq \d+\)/u);
  assertClean(world.unit);
});

test("a failed edit does not block the decision or the loop", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);

  // Only `editMessageText` fails. Failing the whole transport would fail the
  // poll instead, which is a different (already tested) path; the property here
  // is that the ONE call the annotation makes can fail without touching either
  // the decision or the loop.
  const passthrough = globalThis.fetch as unknown as NonNullable<TelegramConfig["fetch"]>;
  const channel = channelFor({
    fetch: async (url, init) => {
      if (url.endsWith("/editMessageText")) {
        return { ok: false, status: 500, text: async () => "mock: edit refused" };
      }
      return await passthrough(url, init);
    },
  });
  channel.onDecision(handlerFor(world, at(2)));
  const messageId = await channel.notify(request_);

  const before = complaints.length;
  const outcome = await press(channel, key, "grant");
  assert.equal(outcome?.ok, true, JSON.stringify(outcome));

  const granted = recordsOf(world.unit.logPath).filter(
    (record) => record.event === "approval.granted" && record.action_key === key,
  );
  assert.equal(granted.length, 1, "the decision must be recorded whatever the edit did");
  assert.equal(editsFor(messageId).length, 0, "no edit landed");
  assert.match(
    complaints.slice(before).join("\n"),
    /could not annotate the decided .* — the decision is recorded; only the message is stale/u,
  );

  // And the loop is still a loop: the next poll works.
  const next = await channel.pollOnce();
  assert.equal(next.updates, 0);
  assertClean(world.unit);
});

test("a decision taken at another surface annotates the chat prompt on the next cycle", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const setup = setupFor(world, channelFor());
  const state = newDispatchState();

  const first = await dispatchPending(setup, capture().streams, state, at(2));
  const messageId = first.delivered[0]?.delivery_id as string;
  assert.ok(messageId !== undefined, JSON.stringify(first));

  // The human answers at the CLI instead, while the chat prompt is still up.
  const decided = recordChannelDecision(
    world.unit.logPath,
    { action_key: key, decision: "grant", deliveryId: "cli" },
    { actor: HUMAN, channel: "cli" },
    { ...world.unit.options, clock: fixedClock(at(3)) },
  );
  assert.equal(decided.outcome.ok, true, JSON.stringify(decided.outcome));

  const { streams, out } = capture();
  const second = await dispatchPending(setup, streams, state, at(4));
  assert.deepEqual(
    second.annotated.map((entry) => [entry.action_key, entry.outcome]),
    [[key, "granted"]],
  );
  assert.ok(out.join("").includes(`annotated ${key} (message ${messageId}): granted`));

  const text = String(editsFor(messageId)[0]?.text);
  assert.match(text, /^<b>✓ APPROVED<\/b>/u);
  assert.match(text, /by human:carter at \d\d:\d\d UTC \(seq \d+\)/u);
  assert.equal(editsFor(messageId)[0]?.replyMarkup, undefined, "the buttons must be gone");

  // And once only.
  const third = await dispatchPending(setup, capture().streams, state, at(5));
  assert.deepEqual(third.annotated, []);
  assert.equal(editsFor(messageId).length, 1);
  assertNoTokenInEdits();
  assertClean(world.unit);
});

test("an expiry appended by the daemon annotates the prompt as EXPIRED", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const setup = setupFor(world, channelFor());
  const state = newDispatchState();

  const first = await dispatchPending(setup, capture().streams, state, at(2));
  const messageId = first.delivered[0]?.delivery_id as string;
  assert.ok(messageId !== undefined, JSON.stringify(first));

  // Past the 24h TTL: the daemon writes `approval.expired` at 1500 minutes.
  const lapsed = expire(world.unit.logPath, key, at(1500), world.unit.options);
  assert.equal(lapsed.ok, true, JSON.stringify(lapsed));

  const second = await dispatchPending(setup, capture().streams, state, at(1501));
  assert.deepEqual(
    second.annotated.map((entry) => entry.outcome),
    ["expired"],
  );
  const text = String(editsFor(messageId)[0]?.text);
  assert.match(text, /^<b>✗ EXPIRED — the approval window closed<\/b>/u);
  assert.match(text, /no answer arrived before the deadline · recorded at \d\d:\d\d UTC \(seq \d+\)/u);
  assert.equal(editsFor(messageId)[0]?.replyMarkup, undefined, "the buttons must be gone");
  assertClean(world.unit);
});

test("a batch annotates member by member: one decided, the rest still armed", async () => {
  // Telegram's batch is one message per member, each with its own keyboard and
  // its own delivery id, so per-member annotation needs no shared state to
  // re-render from: deciding one member edits exactly one message.
  const world = live(2);
  const [firstKey, secondKey] = world.keys as [string, string];
  const requests = queueOf(world, at(2));
  assert.equal(requests.length, 2);

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  const assembled = assembleBatch(requests);
  assert.equal(assembled.ok, true, JSON.stringify(assembled));
  if (!assembled.ok) return;
  await channel.notify(assembled.batch);

  assert.equal(channel.lastRendered().length, 2, "a batch is rendered member by member");

  const editedBefore = mock.edits().length;
  assert.equal((await press(channel, firstKey, "grant"))?.ok, true);
  const afterFirst = mock.edits().slice(editedBefore);
  assert.equal(afterFirst.length, 1, "exactly one member's message may be edited");
  assert.match(String(afterFirst[0]?.text), new RegExp(`<code>${firstKey}</code>`, "u"));
  assert.equal(afterFirst[0]?.replyMarkup, undefined);

  // The undecided member is untouched and still answerable.
  assert.equal((await press(channel, secondKey, "reject"))?.ok, true);
  const afterSecond = mock.edits().slice(editedBefore + 1);
  assert.equal(afterSecond.length, 1, "the last member decided leaves no armed message");
  assert.match(String(afterSecond[0]?.text), new RegExp(`<code>${secondKey}</code>`, "u"));
  assert.match(String(afterSecond[0]?.text), /✗ REJECTED/u);
  assertNoTokenInEdits();
  assertClean(world.unit);
});

// ---------------------------------------------------------------------------
// Withdrawal (APRV-106)
// ---------------------------------------------------------------------------

test("the prompt carries the age and the deadline an answer has to beat", async () => {
  const world = live(1);
  const [request_] = queueOf(world, at(32));
  assert.ok(request_ !== undefined);
  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(32)));
  await channel.notify(request_);

  // Requested at at(1), rendered at at(32): 31 minutes of a 1h TTL gone, so an
  // answer has until 10:01 UTC. A COMPUTED line, under the computed heading.
  const sent = mock.sentTexts().join("\n");
  assert.match(sent, /waiting:<\/b> requested 31 min ago · expires 10:01 UTC/u);
  const rendered = channel.lastRendered()[0];
  assert.equal(
    rendered?.fields.find((field) => field.field === "waiting")?.kind,
    "computed",
  );
  assertClean(world.unit);
});

test("a hook request's declared wait deadline is shown instead of the TTL", async () => {
  // APRV-106: the hook waits nine minutes, not the policy's hour, and the
  // approver is told the deadline that actually applies to them. It can only
  // read as MORE urgent than the TTL, never less, which is why a
  // requester-authored instant is safe on this line.
  const world = live(1);
  const key = hookedRequest(world);
  const [, hooked] = queueOf(world, at(2));
  assert.ok(hooked !== undefined, "the hooked request is not in the queue");
  assert.equal(hooked.action_key.value, key);

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  await channel.notify(hooked);

  // Requested at at(1), the hook waits until at(10): 10:10 UTC, not the TTL's
  // 11:01. And the line is still computed.
  assert.match(
    mock.sentTexts().join("\n"),
    /waiting:<\/b> requested 1 min ago · requester waits until 10:10 UTC/u,
  );
  assert.equal(
    channel.lastRendered()[0]?.fields.find((field) => field.field === "waiting")?.kind,
    "computed",
  );
  assertClean(world.unit);
});

/**
 * Register and request one harness-executed action carrying a `wait_until`,
 * the way `approval hook claude-code` does. Returns its action key.
 */
function hookedRequest(world: Live): string {
  const key = "task-101:amend";
  const payload = { command: "git commit --amend", cwd: "/repo" };
  const registered = register(
    world.unit.logPath,
    {
      task: "task-101",
      envelope: {
        origin: { app: "claude-code-hook", created_by: ACTOR },
        state: "proposed",
        actions: [
          {
            class: "communicate.email.external",
            idempotency_key: key,
            summary: "git commit --amend",
            reversible: false,
            est_cost_usd: 0,
            payload_hash: payloadHash(payload),
          },
        ],
      },
    },
    at(1),
    ACTOR,
    world.unit.options,
  );
  assert.equal(registered.ok, true, JSON.stringify(registered));

  const requested = request(
    world.unit.logPath,
    {
      task: "task-101",
      actionKey: key,
      cls: "communicate.email.external",
      est_cost_usd: 0,
      reversible: false,
      summary: "git commit --amend",
      payload_hash: payloadHash(payload),
      payload: { value: payload },
      execution: "harness",
      wait_until: at(10),
    },
    at(1),
    ACTOR,
    world.unit.options,
  );
  assert.equal(requested.ok, true, JSON.stringify(requested));
  world.payloads.set(key, payload);
  return key;
}

test("a withdrawn request is annotated on the phone and its buttons removed", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const setup = setupFor(world, channelFor());
  const state = newDispatchState();

  const first = await dispatchPending(setup, capture().streams, state, at(2));
  assert.equal(first.delivered.length, 1, JSON.stringify(first));
  const messageId = first.delivered[0]?.delivery_id as string;

  // The requester gives up.
  const gone = withdraw(world.unit.logPath, key, ACTOR, at(11), {
    ...world.unit.options,
    reason: "timeout",
  });
  assert.equal(gone.ok, true, gone.ok ? "" : gone.message);

  const second = await dispatchPending(setup, capture().streams, state, at(12));
  assert.deepEqual(
    second.annotated.map((entry) => entry.action_key),
    [key],
  );
  assert.deepEqual(
    second.annotated.map((entry) => entry.outcome),
    ["withdrawn"],
  );

  // ONE editMessageText: the annotation and the disarming land together, so
  // there is no window in which the message reads "withdrawn" and still offers
  // a tap.
  const edits = editsFor(messageId);
  assert.equal(edits.length, 1, JSON.stringify(edits));
  assert.match(String(edits[0]?.text), /WITHDRAWN — no decision is needed/u);
  assert.match(
    String(edits[0]?.text),
    /withdrawn by the requester at 10:11 UTC \(timeout\) · nothing to do/u,
  );
  assert.equal(edits[0]?.replyMarkup, undefined, "the buttons must be gone");

  // Idempotent: a third cycle edits nothing further.
  const third = await dispatchPending(setup, capture().streams, state, at(13));
  assert.deepEqual(third.annotated, []);
  assert.equal(editsFor(messageId).length, 1);
  assertClean(world.unit);
});

test("a tap on a withdrawn request is refused and appends nothing", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(12)));
  await channel.notify(request_);

  assert.equal(
    withdraw(world.unit.logPath, key, ACTOR, at(11), {
      ...world.unit.options,
      reason: "timeout",
    }).ok,
    true,
  );

  const before = recordsOf(world.unit.logPath).length;
  const outcome = await press(channel, key, "grant");
  assert.equal(outcome?.ok, false, "a withdrawn request must not be grantable");
  if (outcome !== undefined && !outcome.ok) assert.equal(outcome.code, "request-withdrawn");
  assert.equal(recordsOf(world.unit.logPath).length, before, "nothing was appended");
  assert.match(
    mock.answerTexts().join("\n"),
    /Withdrawn — the requester took this back and is no longer waiting/u,
  );
  assertClean(world.unit);
});

test("a fresh listener never sends a withdrawn request at all", async () => {
  // The sent-message memory is process-local (APRV-88), so this is the restart
  // case: the new process re-derives pending from the verified log, and a
  // withdrawn request is not pending. Nothing to remember, nothing to retract.
  const world = live(1);
  const key = world.keys[0] as string;
  assert.equal(
    withdraw(world.unit.logPath, key, ACTOR, at(11), {
      ...world.unit.options,
      reason: "timeout",
    }).ok,
    true,
  );

  const setup = setupFor(world, channelFor());
  const result = await dispatchPending(setup, capture().streams, newDispatchState(), at(12));
  assert.deepEqual(result.delivered, []);
  assert.deepEqual(result.annotated, []);
  assert.equal(messagesMentioning(key), 0, "a withdrawn request must never be sent");
  assertClean(world.unit);
});

test("reject records the documented note, since an inline keyboard collects no text", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  await channel.notify(request_);
  const outcome = await press(channel, key, "reject");
  assert.equal(outcome?.ok, true, JSON.stringify(outcome));

  const rejected = recordsOf(world.unit.logPath).find(
    (record) => record.event === "approval.rejected",
  );
  assert.ok(rejected !== undefined);
  const payload = (rejected.payload ?? {}) as Record<string, unknown>;
  assert.match(String(payload["note"]), /^rejected via telegram \(callback cb-/u);
  assertClean(world.unit);
});

// ---------------------------------------------------------------------------
// The listener survives the network
// ---------------------------------------------------------------------------

/**
 * One resilience case: break the transport, watch the loop complain and retry,
 * heal it, and assert the very next button press still lands in the log.
 *
 * A listener that dies on a transient failure fails exactly when it matters —
 * at 3am, with the queue filling up — so "it resumed" is asserted through a
 * real decision, not through a counter alone.
 */
async function survives(mode: MockFailure): Promise<void> {
  const world = live(1);
  const key = world.keys[0] as string;
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);

  // A tight transport timeout so the "accepted and never answered" case is a
  // test rather than a coffee break; the loop's arithmetic is the same at 300ms
  // as at the 35s default.
  const channel = channelFor({ pollTimeoutSeconds: 1, requestTimeoutMs: 300 });
  channel.onDecision(handlerFor(world, at(2)));
  await channel.notify(request_);

  const before = channel.stats().pollErrors;
  const running = channel.listen();
  try {
    mock.fail(mode);
    await until(
      () => channel.stats().pollErrors >= before + 2,
      `two recovered ${mode} poll failures`,
    );
  } finally {
    // Whatever happened, the next test starts against a healthy server.
    mock.fail(null);
  }

  mock.queueUpdate(callbackUpdate({ data: mock.callbackDataFor(key, "grant"), chatId: CHAT }));
  await until(
    () =>
      recordsOf(world.unit.logPath).some((record) => record.event === "approval.granted"),
    `the grant to land after a ${mode} failure`,
  );

  channel.stop();
  await running;
  assert.ok(
    complaints.some((message) => /retrying in \d+ms — the listener is still up/u.test(message)),
    "the loop must say on stderr that it is still up",
  );
  assertClean(world.unit);
}

test("the listener survives a getUpdates timeout and resumes", async () => {
  await survives("timeout");
});

test("the listener survives a dropped connection and resumes", async () => {
  await survives("drop");
});

test("the listener survives a 500 and resumes", async () => {
  await survives("500");
});

test("the listener survives a malformed JSON response and resumes", async () => {
  await survives("malformed");
});

test("the listener survives the server disappearing mid-poll and resumes", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);

  const channel = channelFor({ pollTimeoutSeconds: 1 });
  channel.onDecision(handlerFor(world, at(2)));
  await channel.notify(request_);

  const before = channel.stats().pollErrors;
  const running = channel.listen();
  await mock.kill();
  await until(
    () => channel.stats().pollErrors >= before + 2,
    "the loop to notice the server is gone",
  );

  await mock.restart();
  mock.queueUpdate(callbackUpdate({ data: mock.callbackDataFor(key, "grant"), chatId: CHAT }));
  await until(
    () => recordsOf(world.unit.logPath).some((r) => r.event === "approval.granted"),
    "the grant to land after the server came back",
  );

  channel.stop();
  await running;
  assertClean(world.unit);
});

// ---------------------------------------------------------------------------
// The verb, end to end, as a child process
// ---------------------------------------------------------------------------

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function cliEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const name of [
    "APPROVAL_HUMAN",
    "APPROVAL_TG_TOKEN",
    "APPROVAL_TG_CHAT",
    // APRV-72's renamed pair, scrubbed for the same reason as the defaults.
    "MY_BOT_TOKEN",
    "MY_BOT_CHAT",
  ]) {
    if (extra[name] === undefined) delete env[name];
  }
  return env;
}

function runCli(args: string[], env: Record<string, string> = {}): Run {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    encoding: "utf8",
    env: cliEnv(env),
    cwd: scratch.root,
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test("listen without the environment is a usage error naming both variables", () => {
  const run = runCli(["channel", "telegram", "listen"]);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /APPROVAL_TG_TOKEN/u);
  assert.match(run.stderr, /APPROVAL_TG_CHAT/u);

  const half = runCli(["channel", "telegram", "listen"], { APPROVAL_TG_TOKEN: TOKEN });
  assert.equal(half.code, 2);
  assert.match(half.stderr, /APPROVAL_TG_CHAT is unset or empty/u);
  assert.equal(half.stderr.includes(TOKEN), false, "the token must not be echoed back");

  const health = runCli(["channel", "telegram", "health", "--json"], {
    APPROVAL_TG_TOKEN: TOKEN,
    APPROVAL_TG_CHAT: CHAT,
  });
  assert.equal(health.code, 0);
  const parsed = JSON.parse(health.stdout) as Record<string, unknown>;
  assert.equal(parsed["ok"], true);
  assert.equal(parsed["token_set"], true);
  assert.equal(health.stdout.includes(TOKEN), false, "health must not print the token");
});

// ---------------------------------------------------------------------------
// The policy names the variables (APRV-72)
// ---------------------------------------------------------------------------

const RENAMED_TOKEN_ENV = "MY_BOT_TOKEN";
const RENAMED_CHAT_ENV = "MY_BOT_CHAT";

let policyCounter = 0;

/** A policy file in the scratch tree, returned by path. */
function policyFile(text: string): string {
  policyCounter += 1;
  const path = join(scratch.root, `policy-${policyCounter}.md`);
  writeFileSync(path, text, "utf8");
  return path;
}

/** {@link POLICY} plus a `channels.telegram` block renaming both variables. */
const RENAMED_POLICY = POLICY.replace(
  "```\n",
  [
    "channels:",
    "  telegram:",
    `    token_env: ${RENAMED_TOKEN_ENV}`,
    `    chat_id_env: ${RENAMED_CHAT_ENV}`,
    "```",
    "",
  ].join("\n"),
);

test("health reads and reports the variables the policy declared", () => {
  const path = policyFile(RENAMED_POLICY);

  const renamed = runCli(["channel", "telegram", "health", "--json", "--policy", path], {
    [RENAMED_TOKEN_ENV]: TOKEN,
    [RENAMED_CHAT_ENV]: CHAT,
  });
  assert.equal(renamed.code, 0, renamed.stderr);
  const parsed = JSON.parse(renamed.stdout) as Record<string, unknown>;
  assert.equal(parsed["ok"], true);
  assert.equal(parsed["token_env"], RENAMED_TOKEN_ENV);
  assert.equal(parsed["chat_env"], RENAMED_CHAT_ENV);
  assert.equal(parsed["token_set"], true);
  assert.equal(parsed["chat_id"], CHAT);
  assert.equal(renamed.stdout.includes(TOKEN), false, "health must not print the token");

  // The defaults are NOT consulted once the policy has named something else:
  // a runtime that read both would silently accept a variable the operator's
  // policy never mentions.
  const defaults = runCli(["channel", "telegram", "health", "--json", "--policy", path], {
    APPROVAL_TG_TOKEN: TOKEN,
    APPROVAL_TG_CHAT: CHAT,
  });
  assert.equal(defaults.code, 1);
  const missed = JSON.parse(defaults.stdout) as Record<string, unknown>;
  assert.equal(missed["ok"], false);
  assert.equal(missed["token_env"], RENAMED_TOKEN_ENV);
  assert.equal(missed["token_set"], false);
});

test("listen's not-configured usage error names the policy's variable", () => {
  const path = policyFile(RENAMED_POLICY);

  const run = runCli(["channel", "telegram", "listen", "--policy", path], {
    [RENAMED_TOKEN_ENV]: TOKEN,
  });
  assert.equal(run.code, 2);
  // The first line is the error itself; the help text follows it, and the help
  // text legitimately names the defaults.
  const message = run.stderr.split("\n")[0] ?? "";
  assert.match(message, /MY_BOT_CHAT is unset or empty/u);
  assert.equal(
    message.includes("APPROVAL_TG_"),
    false,
    "the error must name the variable this policy asked for, not the default",
  );
  assert.equal(run.stderr.includes(TOKEN), false, "the token must not be echoed back");
});

test("a policy declaring neither variable falls back to the reference defaults", () => {
  const path = policyFile(POLICY);

  const health = runCli(["channel", "telegram", "health", "--json", "--policy", path], {
    APPROVAL_TG_TOKEN: TOKEN,
    APPROVAL_TG_CHAT: CHAT,
  });
  assert.equal(health.code, 0, health.stderr);
  const parsed = JSON.parse(health.stdout) as Record<string, unknown>;
  assert.equal(parsed["ok"], true);
  assert.equal(parsed["token_env"], "APPROVAL_TG_TOKEN");
  assert.equal(parsed["chat_env"], "APPROVAL_TG_CHAT");
});

test("an unparseable policy falls back rather than locking the channel out", () => {
  // Fail-closed governs autonomy and budgets. A variable NAME is not a
  // permission (SPEC.md §5.2, as for vault.passphrase_env), so a policy typo
  // must not make an operator's own credentials unreachable.
  const path = policyFile(["# Policy", "", "```yaml approval-policy", "version: [", "```", ""].join("\n"));

  const health = runCli(["channel", "telegram", "health", "--json", "--policy", path], {
    APPROVAL_TG_TOKEN: TOKEN,
    APPROVAL_TG_CHAT: CHAT,
  });
  assert.equal(health.code, 0, health.stderr);
  const parsed = JSON.parse(health.stdout) as Record<string, unknown>;
  assert.equal(parsed["ok"], true);
  assert.equal(parsed["token_env"], "APPROVAL_TG_TOKEN");

  const listen = runCli(["channel", "telegram", "listen", "--policy", path]);
  assert.equal(listen.code, 2);
  assert.match(listen.stderr, /APPROVAL_TG_TOKEN and APPROVAL_TG_CHAT are unset or empty/u);
});

test("listen with no human identity is a usage error", () => {
  const run = runCli(["channel", "telegram", "listen"], {
    APPROVAL_TG_TOKEN: TOKEN,
    APPROVAL_TG_CHAT: CHAT,
  });
  assert.equal(run.code, 2);
  assert.match(run.stderr, /no human identity/u);
});

test("--once: pending request → message → callback → grant → token on stdout", async () => {
  const world = live(1, true);
  const key = world.keys[0] as string;
  const payloadsPath = join(world.unit.dir, "payloads.json");
  writeFileSync(
    payloadsPath,
    JSON.stringify(Object.fromEntries(world.payloads.entries())),
    "utf8",
  );

  const child = spawn(
    process.execPath,
    [
      CLI_ENTRY,
      "channel",
      "telegram",
      "listen",
      "--once",
      "--api-base",
      assertLocal(mock.url),
      "--log",
      world.unit.logPath,
      "--policy",
      world.unit.policyPath,
      "--payloads",
      payloadsPath,
      "--poll-timeout",
      "5",
    ],
    {
      env: cliEnv({
        APPROVAL_TG_TOKEN: TOKEN,
        APPROVAL_TG_CHAT: CHAT,
        APPROVAL_HUMAN: HUMAN,
      }),
      cwd: world.unit.dir,
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  // Wait for the bot message, then press Approve exactly as Telegram would.
  await until(() => {
    try {
      mock.callbackDataFor(key, "grant");
      return true;
    } catch {
      return false;
    }
  }, "the listener to deliver the pending request");
  mock.queueUpdate(callbackUpdate({ data: mock.callbackDataFor(key, "grant"), chatId: CHAT }));

  const code = await new Promise<number>((resolve) => {
    child.on("exit", (status) => resolve(status ?? -1));
  });

  assert.equal(code, 0, `listener exited ${code}: ${stderr}`);
  assert.match(stdout, /notified task-100:/u);
  assert.match(stdout, /granted task-100:.* by human:carter via telegram/u);
  const token = /execution token +\S+\n {2}(\S+)/u.exec(stdout);
  assert.ok(token !== null, `no execution token on stdout: ${stdout}`);
  assert.ok((token[1] as string).length >= 20, "the printed token looks too short to be one");
  assert.match(stdout, /not sent to Telegram/u);

  // The token reached stdout and nothing else: not the chat, not the log.
  const sent = mock.sentTexts().join("\n");
  assert.equal(sent.includes(token[1] as string), false, "the token was sent to Telegram");
  const logBytes = readFileSync(world.unit.logPath, "utf8");
  assert.equal(logBytes.includes(token[1] as string), false, "the raw token reached the log");
  assert.equal(logBytes.includes(TOKEN), false, "the bot token reached the log");

  const granted = recordsOf(world.unit.logPath).find((r) => r.event === "approval.granted");
  assert.ok(granted !== undefined, "no approval.granted was appended");
  assert.equal(granted.actor, HUMAN);
  assert.equal(granted.action_key, key);
  assertClean(world.unit);
});

// ---------------------------------------------------------------------------
// Dispatch: requests that arrive while the listener is already running
// (APRV-55)
// ---------------------------------------------------------------------------

/**
 * The M5 proof only ever exercised the startup send: the request existed before
 * the listener did. These cases exercise the other order, which is the ordinary
 * one in a running system — a session appends `approval.requested` at 14:00 and
 * the listener has been up since breakfast.
 *
 * They drive `dispatchPending` directly, one call per cycle, with an explicit
 * `now` rather than a clock read: that is the unit the listener calls before
 * every `getUpdates`, and calling it in a loop here is the same code path with
 * the same state. Nothing is hand-written into a log; every request is appended
 * through the real gate and every decision through `recordChannelDecision`.
 */

/** A staged world: `count` actions registered, none requested yet. */
function staged(count: number): Live {
  fixtureCounter += 1;
  const prefix = `staged${fixtureCounter}`;
  const unit = newScenario(scratch.root, POLICY);
  attest(unit, T0);

  const payloads = new Map<string, unknown>();
  const keys: string[] = [];
  const actions = [];
  for (let index = 0; index < count; index += 1) {
    const key = actionKeyFor(prefix, index);
    const payload = payloadFor(index);
    keys.push(key);
    payloads.set(key, payload);
    actions.push({
      class: "communicate.email.external",
      idempotency_key: key,
      summary: `chase invoice ${41 + index}`,
      reversible: false,
      est_cost_usd: 0.02,
      payload_hash: payloadHash(payload),
    });
  }

  const registered = register(
    unit.logPath,
    {
      task: TASK,
      envelope: { origin: { app: "manual", created_by: ACTOR }, state: "awaiting", actions },
    },
    T0,
    ACTOR,
    unit.options,
  );
  assert.equal(registered.ok, true, `registration failed: ${JSON.stringify(registered)}`);

  return {
    unit,
    keys,
    payloads,
    tagOptions: { policy: { file: unit.policyPath }, payload: (key) => payloads.get(key) },
  };
}

/** Append one `approval.requested` through the real gate, at a chosen instant. */
function requestAt(world: Live, index: number, ts: string): string {
  const key = world.keys[index] as string;
  const result = request(
    world.unit.logPath,
    {
      task: TASK,
      actionKey: key,
      cls: "communicate.email.external",
      est_cost_usd: 0.02,
      reversible: false,
      summary: `chase invoice ${41 + index}`,
    },
    ts,
    ACTOR,
    world.unit.options,
  );
  assert.equal(result.ok, true, `request failed: ${JSON.stringify(result)}`);
  return key;
}

function capture(): { streams: Streams; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    streams: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) },
    out,
    err,
  };
}

function setupFor(world: Live, channel: TelegramChannel): ListenSetup {
  return {
    channel,
    logPath: world.unit.logPath,
    actor: HUMAN,
    json: false,
    once: false,
    gateOptions: world.unit.options,
    tagOptions: world.tagOptions,
  };
}

/** How many bot messages mention this action key. One delivery is one or more. */
function messagesMentioning(key: string): number {
  return mock.sentTexts().filter((text) => text.includes(key)).length;
}

test("a request appended after startup is delivered on the next cycle, exactly once", async () => {
  const world = staged(3);
  const channel = channelFor();
  const setup = setupFor(world, channel);
  const state = newDispatchState();
  const { streams, err } = capture();

  const a = requestAt(world, 0, at(1));

  // Cycle 1 is the startup send: the same call, with an empty delivered set.
  const first = await dispatchPending(setup, streams, state, at(2));
  assert.deepEqual(
    first.delivered.map((entry) => entry.action_key),
    [a],
  );
  assert.equal(first.failed.length, 0);
  const aMessages = messagesMentioning(a);
  assert.ok(aMessages > 0, "the first cycle sent nothing");

  // A request the listener could not have known about when it started.
  const b = requestAt(world, 1, at(3));

  const second = await dispatchPending(setup, streams, state, at(4));
  assert.deepEqual(
    second.delivered.map((entry) => entry.action_key),
    [b],
    "the newly requested action was not delivered without a restart",
  );
  assert.equal(messagesMentioning(a), aMessages, "the first request was sent a second time");
  assert.ok(messagesMentioning(b) > 0, "the second request never reached the chat");

  // A decision through the real callback path, then a cycle that must be quiet:
  // the derivation no longer holds A, and B is already delivered.
  channel.onDecision(handlerFor(world, at(5)));
  const outcome = await press(channel, a, "grant");
  assert.equal(outcome?.ok, true, `grant refused: ${JSON.stringify(outcome)}`);

  const third = await dispatchPending(setup, streams, state, at(6));
  assert.equal(third.delivered.length, 0, "a settled cycle still sent something");
  assert.equal(third.failed.length, 0);

  // C is requested and then left to lapse: the TTL is 24h in this policy, and a
  // cycle a week later must not put an expired request in front of a human.
  const c = requestAt(world, 2, at(7));
  const late = await dispatchPending(setup, streams, state, at(7 * 24 * 60));
  assert.equal(late.delivered.length, 0, "an expired request was delivered");
  assert.equal(messagesMentioning(c), 0, "an expired request reached the chat");

  assert.deepEqual(err, [], `unexpected stderr: ${err.join("")}`);
  assertClean(world.unit);
});

test("a send that fails leaves the request pending and the next cycle retries it", async () => {
  const world = staged(1);
  const channel = channelFor();
  const setup = setupFor(world, channel);
  const state = newDispatchState();
  const { streams } = capture();

  const key = requestAt(world, 0, at(1));

  mock.fail("500");
  const failed = await dispatchPending(setup, streams, state, at(2));
  mock.fail(null);
  assert.equal(failed.delivered.length, 0);
  assert.deepEqual(
    failed.failed.map((entry) => entry.action_key),
    [key],
  );
  assert.equal(failed.failed[0]?.attempts, 1);
  // The Bot API refused, so there is no delivery to press a button on. (The
  // mock records the attempt, which is why this asserts on the channel's answer
  // rather than on the text log.)
  assert.throws(() => mock.callbackDataFor(key, "grant"));

  const retried = await dispatchPending(setup, streams, state, at(3));
  assert.deepEqual(
    retried.delivered.map((entry) => entry.action_key),
    [key],
    "the failed request was not retried on the next cycle",
  );
  assert.ok(messagesMentioning(key) > 0);
  assert.doesNotThrow(() => mock.callbackDataFor(key, "grant"));
  assertClean(world.unit);
});

test("a fresh listener re-sends everything still pending: a duplicate, never silence", async () => {
  const world = staged(1);
  const channel = channelFor();
  const setup = setupFor(world, channel);
  const { streams } = capture();

  const key = requestAt(world, 0, at(1));

  const before = newDispatchState();
  await dispatchPending(setup, streams, before, at(2));
  const once = messagesMentioning(key);
  assert.ok(once > 0);

  // The process died. Its delivery bookkeeping went with it (SPEC.md §10.3),
  // and the pending set is re-derived from the log rather than remembered.
  const after = newDispatchState();
  const restarted = await dispatchPending(setup, streams, after, at(3));
  assert.deepEqual(
    restarted.delivered.map((entry) => entry.action_key),
    [key],
  );
  assert.equal(messagesMentioning(key), once * 2, "the restart did not re-send the request");
  assertClean(world.unit);
});

test("an unreadable log is a reported cycle failure, not a send and not a crash", async () => {
  const world = staged(1);
  const channel = channelFor();
  // A directory where a log should be: unreadable in a way an absent file is
  // not (an absent log is an empty log, and an empty queue is a valid answer).
  const setup = { ...setupFor(world, channel), logPath: world.unit.dir };
  const { streams } = capture();

  const result = await dispatchPending(setup, streams, newDispatchState(), at(2));
  assert.equal(result.delivered.length, 0);
  assert.ok(result.queueError !== undefined, "an unreadable log produced no queue error");
});

test("listen runs the dispatch hook before every poll, including after a poll error", async () => {
  const channel = channelFor();

  let calls = 0;
  await channel.listen({
    once: true,
    beforePoll: async () => {
      calls += 1;
    },
  });
  assert.equal(calls, 1, "--once did not run exactly one dispatch cycle");

  // Steady state: the hook runs at the top of every iteration, so a request
  // appended between two polls is picked up by the next one.
  calls = 0;
  await channel.listen({
    beforePoll: async () => {
      calls += 1;
      if (calls === 3) channel.stop();
    },
  });
  assert.equal(calls, 3);

  // And a poll that fails does not cost a dispatch cycle: the loop retries the
  // whole iteration, hook included.
  calls = 0;
  mock.fail("500");
  await channel.listen({
    beforePoll: async () => {
      calls += 1;
      if (calls === 2) {
        mock.fail(null);
        channel.stop();
      }
    },
  });
  mock.fail(null);
  assert.ok(calls >= 2, `the hook did not run again after a poll error (${calls})`);
});

// ---------------------------------------------------------------------------
// File changes on the phone (APRV-124)
// ---------------------------------------------------------------------------

test("a file-change payload renders as a diff, and every other shape stays JSON", () => {
  const json = (value: unknown): string => JSON.stringify(value, null, 2);
  const view = (value: unknown, truncated = false): string =>
    payloadRegionText({ value, text: json(value), hash: "h", truncated });

  const edit = {
    tool: "Edit",
    rule: "protected-path",
    file: "/repo/.github/workflows/ci.yml",
    before: "  - run: npm test\n  - run: npm run lint",
    after: "  - run: npm test",
  };
  const rendered = view(edit);
  assert.ok(rendered.startsWith(EDIT_VIEW_HEADING), rendered);
  assert.ok(rendered.includes("file: /repo/.github/workflows/ci.yml"), rendered);
  assert.ok(rendered.includes(`note: ${LIVE_QUALIFIER}`), rendered);
  assert.ok(rendered.includes("-  - run: npm run lint"), rendered);
  assert.ok(rendered.includes("+  - run: npm test"), rendered);
  // The exact bytes stay underneath: the diff is an aid, never a replacement.
  assert.ok(rendered.includes(CANONICAL_JSON_HEADING), rendered);
  assert.ok(rendered.endsWith(json(edit)), rendered);

  // The proposal tier renders its own qualifier, from the same key.
  assert.ok(view({ ...edit, rule: "protected-path-proposal" }).includes(PROPOSAL_QUALIFIER));

  // A whole-file write: no removed side, and the absence is stated.
  const write = { tool: "Write", rule: "protected-path", file: "/repo/APPROVAL.md", content: "a\nb" };
  assert.ok(view(write).includes("the whole file as it will be written (2 lines)"), view(write));
  assert.ok(view(write).includes("+a\n+b"), view(write));

  // Half a change, an unknown key, a wrong type, a truncated rendering: JSON.
  for (const value of [
    { tool: "Edit", file: "/repo/x", before: "a" },
    { tool: "Edit", file: "/repo/x", after: "a" },
    { tool: "Edit", file: "/repo/x", before: "a", after: "b", extra: 1 },
    { tool: "Edit", file: "/repo/x", before: "a", after: "b", content: "c" },
    { tool: "Edit", file: 3, before: "a", after: "b" },
    { tool: "Edit", file: "/repo/x", before: "a", after: "b", replace_all: "yes" },
    { file: "/repo/x" },
    "just a string",
    null,
  ]) {
    assert.equal(changePayloadView(value), null, `wrongly recognised ${json(value)}`);
    assert.equal(view(value), json(value), `rendering changed for ${json(value)}`);
  }
  assert.equal(view(edit, true), json(edit), "a truncated rendering must not be re-expanded");

  // `replace_all` is part of the question and is shown when the call sets it.
  assert.ok(view({ ...edit, replace_all: true }).includes("replace_all: true"));
});

test("a very long change folds with an explicit marker, never silently", () => {
  const after = Array.from({ length: DIFF_LINE_BUDGET + 25 }, (_, index) => `line ${index}`).join(
    "\n",
  );
  const payload = { tool: "Write", rule: "protected-path", file: "/repo/CLAUDE.md", content: after };
  const text = payloadRegionText({
    value: payload,
    text: JSON.stringify(payload, null, 2),
    hash: "h",
    truncated: false,
  });
  assert.ok(text.includes(`+line ${String(DIFF_LINE_BUDGET - 1)}`), "the budget is spent in full");
  assert.equal(text.includes(`+line ${String(DIFF_LINE_BUDGET)}`), false, "the fold did not happen");
  assert.ok(text.includes("… 25 more lines (hash covers all bytes)"), text);
  // And the folded lines are still on screen, in the canonical JSON underneath.
  assert.ok(text.includes(JSON.stringify(after)), "the exact bytes left the message");
});

test("a diff reaches Telegram escaped, chunked and complete", async () => {
  // The end-to-end of the APRV-124 complaint: the approver reads the CHANGE,
  // through the real transport, with markup in it that must not become markup.
  const change = {
    tool: "Edit",
    rule: "protected-path-proposal",
    file: "/repo/.github/workflows/ci.yml",
    before: "run: npm test <all> & lint",
    after: "run: npm test --silent",
  };
  const world = live(1, false, () => change);
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  const before = mock.sentTexts().length;
  await channel.notify(request_);
  const texts = mock.sentTexts().slice(before);
  const whole = texts.join("\n");

  assert.ok(whole.includes("rule: protected-path-proposal"), whole);
  assert.ok(whole.includes(PROPOSAL_QUALIFIER), whole);
  assert.ok(whole.includes("-run: npm test &lt;all&gt; &amp; lint"), whole);
  assert.ok(whole.includes("+run: npm test --silent"), whole);
  assert.equal(whole.includes("<all>"), false, "raw markup reached the message");
  assert.ok(
    whole.includes(`--- full payload (sha256 ${request_.payload_hash.value}) ---`),
    "the payload region lost its hash label",
  );
  for (const text of texts) {
    assert.ok(text.length <= 4096, "a message exceeded Telegram's 4096-character limit");
  }
  assert.equal(recordsOf(world.unit.logPath).length, 3);
});
