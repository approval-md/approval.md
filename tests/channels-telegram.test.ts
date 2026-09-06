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
  batchDeliveryIdOf,
  claimed,
  computed,
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
  commandPayloadView,
  emailPayloadFields,
  markEscapes,
  payloadRegionText,
  rawBytesLine,
  ABSENT,
  BODY_BEGIN,
  BODY_END,
  CANONICAL_JSON_HEADING,
  COMMAND_BEGIN,
  COMMAND_END,
  COMMAND_VIEW_HEADING,
  EDIT_VIEW_HEADING,
  EMAIL_VIEW_HEADING,
  ESCAPE_LEGEND,
  LIVE_QUALIFIER,
  OPAQUE_VIEW_HEADING,
  PROPOSAL_QUALIFIER,
} from "../src/channels/payload-view.js";
import { assembleBatch } from "../src/channels/batch.js";
import { buildPendingQueue, type TagOptions } from "../src/channels/tagging.js";
import {
  actionRefOf,
  callbackData,
  digestCallbackData,
  digestKeyOf,
  groupForDigest,
  isMessageNotModified,
  parseCallbackData,
  payloadShapeKey,
  renderTelegram,
  PAYLOAD_CHUNK_LABEL_TAIL,
  TELEGRAM_ANOMALY_MARK,
  TelegramApiError,
  TelegramChannel,
  TELEGRAM_DEFAULT_RETENTION_MS,
  TELEGRAM_DIGEST_MAX_MEMBERS,
  TELEGRAM_GLOSS_SUFFIX,
  TELEGRAM_ACK_FALLBACK,
  TELEGRAM_ACK_HEARD,
  TELEGRAM_HANDLER_FAILED,
  TELEGRAM_NOT_RECORDED,
  TELEGRAM_MAX_CALLBACK_BYTES,
  TELEGRAM_PROMPT_HEADING,
  TELEGRAM_STALE_COPY_PREFIX,
  TELEGRAM_STALE_UNKNOWN,
  parseBotCommand,
  TELEGRAM_COMMANDS,
  type TelegramConfig,
  type TelegramPollResult,
} from "../src/channels/telegram.js";
import {
  telegramDeliveryFor,
  TELEGRAM_DEFAULT_DELIVERY,
  type TelegramDelivery,
} from "../src/core/telegram-config.js";
import {
  bannerLines,
  commandHandlerFor,
  describeActionFor,
  dispatchPending,
  glossWiring,
  newDispatchState,
  queueLines,
  summaryLines,
  DISPATCH_RETENTION_MS,
  type ListenSetup,
} from "../src/cli/channel-telegram.js";
import { parseFlags } from "../src/cli/args.js";
import {
  glossFor,
  glossPrompt,
  tidyGloss,
  GLOSS_AUTHOR,
  GLOSS_EDIT_INSTRUCTION,
  GLOSS_EMAIL_INSTRUCTION,
  GLOSS_INSTRUCTION,
  GLOSS_MAX_CHARS,
  GLOSS_MAX_INPUT_CHARS,
  GLOSS_TRUNCATION_NOTE,
  type GlossRunner,
} from "../src/cli/gloss.js";
import type { Streams } from "../src/cli/main.js";
import { appendAttestation } from "../src/core/attest.js";
import type { BudgetVerdict } from "../src/core/budgets.js";
import { register as registerCore, request as requestCore } from "../src/core/gate.js";
import { payloadHash } from "../src/core/payload.js";
import { loadPolicy } from "../src/core/policy-load.js";
import { applyPromptBlock, TELEGRAM_PROMPT_LAYOUT } from "../src/core/prompt-layout.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { expire, register, request, withdraw } from "./clock-adapters.js";
import { fakeClaudeEnv, FAKE_GLOSS_SENTENCE } from "./fake-claude.js";
import {
  assertLocal,
  callbackUpdate,
  messageUpdate,
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

/** The class the payload-view tests render under; no view reads it (APRV-119). */
const VIEW_CLASS = "record.write";

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

/**
 * The same policy with room for a long run (APRV-135).
 *
 * The bounded-size test decides dozens of prompts in a row, and the fixture's
 * five-a-day cap would stop it at the sixth grant — a budget refusal, which is
 * a different subject entirely.
 */
const POLICY_LONG_RUN = POLICY.replace("      daily_actions: 5", "      daily_actions: 500");

/**
 * The same policy with one class's ceiling raised (APRV-235).
 *
 * Attested after a request has already been routed, this is what
 * `policy-drift` is about: nothing is unattested, nothing is unverified, and
 * the rules on the approver's screen are a different set of rules.
 */
const POLICY_REATTESTED = POLICY.replace("      per_action_usd: 1", "      per_action_usd: 2");

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
  /** The policy the fixture runs under. Widened by the APRV-135 long run. */
  policyText: string = POLICY,
): Live {
  fixtureCounter += 1;
  const prefix = `chaser${fixtureCounter}`;
  const unit = newScenario(scratch.root, policyText);

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
      est_cost_usd: "0.02",
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
  assert.match(whole, /WHAT THIS DOES — CLAIMED by agent:drafter, NOT verified by the runtime/u);
  assert.ok(whole.includes(PAYLOAD_CHUNK_LABEL_TAIL), whole);
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

// ---------------------------------------------------------------------------
// The computed block: what a healthy prompt shows, and what an unhealthy one
// adds (APRV-163). `renderTelegram` is pure, so these render directly rather
// than through the mock: the question is which rows exist, not how they ship.
// ---------------------------------------------------------------------------

/** The `field` of every computed row the renderer produced, in order. */
function computedFields(request_: ChannelRequest): string[] {
  return renderTelegram(request_)
    .lines.filter((entry) => entry.kind === "computed")
    .map((entry) => entry.field);
}

/** One live request, healthy: manual autonomy, budgets passing, policy attested. */
function healthy(): ChannelRequest {
  const [request_] = queueOf(live(1), at(2));
  assert.ok(request_ !== undefined);
  assert.equal(request_.autonomy.value, "manual");
  assert.equal(request_.attestation.value.status, "attested");
  assert.ok(
    request_.budgets.value.every((verdict) => verdict.pass),
    "the fixture request already fails a budget; the healthy baseline is not healthy",
  );
  return request_;
}

const FAILING_VERDICT: BudgetVerdict = {
  limit: "daily_usd",
  scope: "class",
  window: "rolling-24h",
  consumed: "9.99",
  requested: "0.02",
  remaining: "-0.01",
  pass: false,
};

test("a healthy prompt carries only the rows that drive the decision", () => {
  const request_ = healthy();
  assert.deepEqual(
    computedFields(request_),
    ["class", "waiting"],
    "the healthy computed block is not the decision-driving set",
  );

  // The six bookkeeping rows are gone from the message and still on the
  // request, which is what keeps `--json`, `approval queue` and the web page
  // whole while the phone screen shrinks.
  const header = renderTelegram(request_).header;
  for (const label of ["resolved by", "payload sha256", "requested", "chain", "task", "state"]) {
    assert.equal(header.includes(`<b>${label}:</b>`), false, `the header still renders ${label}`);
  }
  for (const field of [
    request_.provenance,
    request_.payload_hash,
    request_.requested_ts,
    request_.chain,
    request_.task,
    request_.state,
  ]) {
    assert.equal(field.kind, "computed", "a dropped row lost its field on the request");
  }
});

test("the commands and protected-path rows render under the class they explain", () => {
  const request_: ChannelRequest = {
    ...healthy(),
    command_breakdown: computed("npm test — run the test suite", "classifier"),
    protected_path: computed("APPROVAL.md", "policy"),
  };
  assert.deepEqual(computedFields(request_), [
    "class",
    "command_breakdown",
    "protected_path",
    "waiting",
  ]);
});

test("budgets renders only when a verdict fails, and shouts when it does", () => {
  const base = healthy();
  const passing = { ...FAILING_VERDICT, remaining: "5", pass: true };

  assert.equal(
    computedFields({ ...base, budgets: computed([], "budgets") }).includes("budgets"),
    false,
    "a prompt with no limits still spent a row saying so",
  );
  assert.equal(
    computedFields({ ...base, budgets: computed([passing], "budgets") }).includes("budgets"),
    false,
    "a passing budget still spent a row saying everything is fine",
  );

  const over = renderTelegram({
    ...base,
    budgets: computed([passing, FAILING_VERDICT], "budgets"),
  });
  assert.ok(over.lines.some((entry) => entry.field === "budgets"));
  assert.ok(
    over.header.includes(`<b>${TELEGRAM_ANOMALY_MARK}budgets:</b>`),
    "the failing budget row carries no anomaly mark",
  );
  assert.ok(over.header.includes("EXCEEDED class.daily_usd"), over.header);
});

test("the policy row renders only when the attestation is anything but attested", () => {
  const base = healthy();
  assert.equal(computedFields(base).includes("attestation"), false);

  const abnormal = [
    { status: "not-attested" as const },
    {
      status: "hash-mismatch" as const,
      attestedSha256: "a".repeat(64),
      liveSha256: "b".repeat(64),
      seq: 2,
    },
    { status: "unreadable" as const, message: "policy file is not YAML" },
  ];
  const shouts = ["NOT ATTESTED", "HASH MISMATCH", "UNREADABLE"];
  for (const [index, status] of abnormal.entries()) {
    const rendered = renderTelegram({ ...base, attestation: computed(status, "policy") });
    assert.ok(
      rendered.lines.some((entry) => entry.field === "attestation"),
      `${status.status} did not render a policy row`,
    );
    assert.ok(
      rendered.header.includes(`<b>${TELEGRAM_ANOMALY_MARK}policy:</b>`),
      `${status.status} rendered without the anomaly mark`,
    );
    assert.ok(rendered.header.includes(shouts[index] as string), rendered.header);
  }
});

test("autonomy renders only when the policy did not say manual", () => {
  const base = healthy();
  assert.equal(computedFields(base).includes("autonomy"), false);

  for (const value of ["supervised", "autonomous"] as const) {
    const rendered = renderTelegram({ ...base, autonomy: computed(value, "policy") });
    assert.ok(
      rendered.lines.some((entry) => entry.field === "autonomy"),
      `${value} did not render an autonomy row`,
    );
    assert.ok(
      rendered.header.includes(`<b>${TELEGRAM_ANOMALY_MARK}autonomy:</b> ${value}`),
      rendered.header,
    );
  }
});

test("an attestation prompt still shows the diff and the loads it asks about", () => {
  const rendered = renderTelegram({
    ...healthy(),
    policy_diff: computed("-autonomy: manual\n+autonomy: autonomous", "policy"),
    policy_load: computed("2 rules load; 0 refused", "policy"),
    attestation: computed({ status: "not-attested" }, "policy"),
  });
  assert.deepEqual(
    rendered.lines.filter((entry) => entry.kind === "computed").map((entry) => entry.field),
    ["class", "policy_diff", "policy_load", "attestation", "waiting"],
  );
  assert.ok(rendered.header.includes("<b>policy diff:</b>"), rendered.header);
  assert.ok(rendered.header.includes("<b>policy loads:</b>"), rendered.header);
});

// ---------------------------------------------------------------------------
// The layout the policy chose (APRV-218)
// ---------------------------------------------------------------------------

test("a policy layout reaches the messages the bot actually sends (APRV-218)", async () => {
  const world = live(1);
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);

  // The operator who wants the task id and the chain position on every prompt,
  // and does not want the "waiting" prose. Everything here was already on the
  // request: the layout chooses among facts, and teaches the channel nothing
  // new about the log.
  const channel = channelFor({
    layout: applyPromptBlock(TELEGRAM_PROMPT_LAYOUT, {
      rows: ["task", "class"],
      always: ["task", "chain"],
      hide: ["waiting"],
    }),
  });
  channel.onDecision(handlerFor(world, at(2)));
  const before = mock.sentTexts().length;
  await channel.notify(request_);
  const whole = mock.sentTexts().slice(before).join("\n");

  assert.ok(whole.includes("<b>task:</b>"), whole);
  assert.ok(whole.includes("<b>chain:</b>"), whole);
  assert.equal(whole.includes("<b>waiting:</b>"), false, whole);
  assert.ok(whole.indexOf("<b>task:</b>") < whole.indexOf("<b>class:</b>"), whole);

  // What a layout may not touch: the action key, the canonical block, and the
  // claimed heading that keeps an agent's sentences off the runtime's side of
  // the line.
  assert.ok(whole.includes(`<code>${world.keys[0] as string}</code>`), whole);
  assert.ok(whole.includes(PAYLOAD_CHUNK_LABEL_TAIL), whole);
  assert.match(whole, CLAIMED_HEADING_ANYWHERE);

  // And rendering under a layout wrote nothing: 3 records in, 3 records out.
  assert.equal(recordsOf(world.unit.logPath).length, 3);
});

const CLAIMED_HEADING_ANYWHERE = /<b>WHAT THIS DOES — CLAIMED by [^<]+, NOT verified by the runtime<\/b>/u;

// ---------------------------------------------------------------------------
// The claimed block beside the buttons (APRV-165)
// ---------------------------------------------------------------------------

/** Every `sendMessage` the bot has issued, with the markup each carried. */
function sends(): { text: string; replyMarkup: unknown }[] {
  return mock.requests
    .filter((entry) => entry.method === "sendMessage")
    .map((entry) => ({
      text: String(entry.body["text"] ?? ""),
      replyMarkup: entry.body["reply_markup"],
    }));
}

const CLAIMED_HEADING = /^<b>WHAT THIS DOES — CLAIMED by [^<]+, NOT verified by the runtime<\/b>/u;

test("the claimed block is the last message of a prompt, and carries the buttons", async () => {
  const world = live(2);
  const [request_, second] = queueOf(world, at(2));
  assert.ok(request_ !== undefined && second !== undefined);

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  const before = sends().length;
  const deliveryId = await channel.notify(request_);

  const messages = sends().slice(before);
  assert.ok(messages.length >= 3, `a prompt with a payload is at least three messages: ${messages.length}`);

  // The order the reader meets it in: what the runtime derived, the bytes, then
  // what the act means — which is the message the thumb is next to.
  const first = messages[0]?.text ?? "";
  assert.ok(first.startsWith(`<b>${TELEGRAM_PROMPT_HEADING}</b>`), first);
  assert.ok(first.includes("COMPUTED — derived by the runtime"), first);
  assert.equal(first.includes("WHAT THIS DOES"), false, "the claimed block is still in the header");

  const middle = messages.slice(1, -1).map((message) => message.text).join("\n");
  assert.ok(middle.includes(PAYLOAD_CHUNK_LABEL_TAIL), "the payload is not between the two blocks");

  const last = messages[messages.length - 1] as { text: string; replyMarkup: unknown };
  assert.match(last.text, CLAIMED_HEADING);
  assert.ok(last.text.includes(`<b>summary:</b> chase invoice 41`), last.text);
  assert.ok(last.text.includes("<b>est. cost:</b> $0.02"), last.text);

  // AC1: the keyboard is on that message and on no other, and the delivery id
  // the channel reports (which the callback arming keys on) is its id.
  assert.ok(last.replyMarkup !== undefined, "the claimed message carries no buttons");
  for (const message of messages.slice(0, -1)) {
    assert.equal(message.replyMarkup, undefined, "a message above the claimed block was buttoned");
  }
  // The delivery id is the buttoned message's id, which is the LAST one sent:
  // a second prompt's id advances by exactly the number of messages it sent.
  const mark = sends().length;
  const nextId = await channel.notify(second);
  assert.equal(
    Number(nextId) - Number(deliveryId),
    sends().length - mark,
    "the delivery id is not the last message of the prompt",
  );

  // And the buttons on it are this request's: pressing them decides it.
  assert.equal((await press(channel, world.keys[0] as string, "grant"))?.ok, true);
  assertClean(world.unit);
});

test("the gloss leads the claimed block, above the summary", async () => {
  const world = live(1);
  const [base] = queueOf(world, at(2));
  assert.ok(base !== undefined);
  const request_: ChannelRequest = {
    ...base,
    gloss: claimed("Emails a vendor about an overdue invoice.", "model:haiku"),
  };

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  const before = sends().length;
  await channel.notify(request_);

  const block = (sends().at(-1) as { text: string }).text;
  assert.match(block, CLAIMED_HEADING);
  assert.ok(
    block.indexOf("<b>gloss:</b>") < block.indexOf("<b>summary:</b>"),
    `the gloss does not lead the claimed block: ${block}`,
  );
  assert.ok(block.includes(`${TELEGRAM_GLOSS_SUFFIX} <i>(model:haiku)</i>`), block);
  assert.equal(sends().slice(before, -1).some((message) => message.text.includes("gloss:")), false);
});

test("a request with nothing to say still sends the claimed message, saying so", async () => {
  // AC4. Absence is a thing the approver must SEE: a prompt whose author wrote
  // no summary, no rationale and no gloss is exactly the one where a missing
  // block would read as "nothing to worry about".
  const world = live(1);
  const [base] = queueOf(world, at(2));
  assert.ok(base !== undefined);
  const request_: ChannelRequest = { ...base, summary: claimed(null, ACTOR) };
  assert.equal(request_.gloss, undefined);
  assert.equal(request_.rationale, undefined);

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  await channel.notify(request_);

  const last = sends().at(-1) as { text: string; replyMarkup: unknown };
  assert.match(last.text, CLAIMED_HEADING);
  assert.ok(last.text.includes("<b>summary:</b> (none given)"), last.text);
  assert.equal(last.text.includes("<b>rationale:</b>"), false, last.text);
  assert.ok(last.replyMarkup !== undefined, "the keyboard lost its home");
});

test("an unbounded rationale becomes more claimed messages, buttons on the last", async () => {
  // AC3. A rationale is agent-authored text with no length bound, so it chunks
  // exactly as a payload does — split, never shortened — and the split never
  // lands inside a tag or an entity, which would reach Telegram as a parse
  // error rather than as a long explanation.
  const world = live(1);
  const [base] = queueOf(world, at(2));
  assert.ok(base !== undefined);
  const marker = "the vendor & <counsel> both asked. ";
  const request_: ChannelRequest = {
    ...base,
    rationale: claimed(marker.repeat(400), ACTOR),
  };

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  const before = sends().length;
  await channel.notify(request_);

  const messages = sends().slice(before);
  const claimedChunks = messages.filter((message) => message.text.includes("WHAT THIS DOES"));
  assert.ok(claimedChunks.length >= 2, `the oversized rationale did not chunk: ${claimedChunks.length}`);
  for (const message of messages) {
    assert.ok(message.text.length <= 4096, "a claimed chunk exceeded Telegram's limit");
  }
  // Every chunk says whose words these are and that nobody checked them.
  for (const chunk of claimedChunks.slice(1)) {
    assert.ok(chunk.text.startsWith("<b>WHAT THIS DOES (continued)"), chunk.text);
  }
  // Complete, and escaped: the whole rationale arrived, as text. The
  // continuation headings are dropped first, because they are the only thing
  // the chunking ADDS to what was rendered.
  const whole = claimedChunks
    .map((chunk) => chunk.text.replace(/^<b>WHAT THIS DOES \(continued\)[^\n]*\n/u, ""))
    .join("");
  assert.equal(
    whole.split("the vendor &amp; &lt;counsel&gt; both asked.").length - 1,
    400,
    "the rationale was shortened on its way to the phone",
  );
  assert.equal(whole.includes("<counsel>"), false, "raw markup reached the message");
  // No chunk ends mid-tag or mid-entity.
  for (const chunk of claimedChunks) {
    assert.equal(/<[^>]*$/u.test(chunk.text), false, chunk.text.slice(-40));
    assert.equal(/&[^;\s]*$/u.test(chunk.text), false, chunk.text.slice(-40));
  }

  const last = messages[messages.length - 1] as { text: string; replyMarkup: unknown };
  assert.ok(last.text.includes("WHAT THIS DOES"), "the keyboard left the claimed block");
  assert.ok(last.replyMarkup !== undefined, "the keyboard is not on the final chunk");
  assert.equal(
    claimedChunks[claimedChunks.length - 2]?.replyMarkup,
    undefined,
    "an earlier claimed chunk carried buttons",
  );
});

test("a payload-less request is two messages: computed, then claimed with the buttons", async () => {
  const world = live(1);
  const [base] = queueOf(world, at(2));
  assert.ok(base !== undefined);
  const request_: ChannelRequest = { ...base, fullPayload: computed(null, "payload") };

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  const before = sends().length;
  await channel.notify(request_);

  const messages = sends().slice(before);
  assert.equal(messages.length, 2, JSON.stringify(messages.map((message) => message.text)));
  assert.ok((messages[0] as { text: string }).text.includes("COMPUTED — derived by the runtime"));
  assert.match((messages[1] as { text: string }).text, CLAIMED_HEADING);
  assert.ok((messages[1] as { replyMarkup: unknown }).replyMarkup !== undefined);
});

test("a digest member keeps the same order and no buttons at all", async () => {
  // AC5: the ordering is the ordering, whether or not the message can be
  // answered on. A member prompt's answer lives on the digest below it.
  const world = live(3);
  const channel = channelFor();
  const setup = setupFor(world, channel);
  channel.onDecision(handlerFor(world, at(3)));

  const before = sends().length;
  const { streams } = capture();
  const cycle = await dispatchPending(setup, streams, newDispatchState(), at(2));
  assert.equal(cycle.digests.length, 1, JSON.stringify(cycle.digests));

  const messages = sends().slice(before);
  const digest = messages[messages.length - 1] as { text: string; replyMarkup: unknown };
  assert.match(digest.text, /3 REQUESTS AWAITING APPROVAL/u);
  assert.ok(digest.replyMarkup !== undefined, "the digest lost its keyboard");

  const members = messages.slice(0, -1);
  for (const message of members) {
    assert.equal(message.replyMarkup, undefined, "a member prompt was buttoned");
  }
  // Each member: its own header, its payload, then its claimed block last.
  for (const [index, key] of world.keys.entries()) {
    const start = members.findIndex((message) => message.text.includes(`REQUEST ${index + 1} OF 3`));
    assert.ok(start >= 0, `${key} was never prompted`);
    const end = members.findIndex(
      (message, position) => position > start && message.text.includes("REQUEST "),
    );
    const own = members.slice(start, end < 0 ? undefined : end);
    assert.ok((own[0] as { text: string }).text.includes("COMPUTED — derived by the runtime"));
    assert.match((own[own.length - 1] as { text: string }).text, CLAIMED_HEADING);
    assert.ok(
      own.slice(1, -1).some((message) => message.text.includes(PAYLOAD_CHUNK_LABEL_TAIL)),
      `${key} lost its payload between the two blocks`,
    );
  }
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

  // The field-by-field view is the whole reading (APRV-162): no second copy of
  // the same bytes as JSON, and the store path is the route back to them.
  assert.equal(whole.includes(CANONICAL_JSON_HEADING), false, "the payload was shown twice");
  assert.ok(whole.includes(rawBytesLine(request_.payload_hash.value)), whole);

  // The binding is stated once, inside the canonical block (APRV-163): the
  // header row that repeated it is gone, and the block's own line is the only
  // place the sha256 has to be, because it is the block it binds.
  assert.equal(
    whole.includes(`payload sha256:</b> ${request_.payload_hash.value}`),
    false,
    "the header still carries a second copy of the binding",
  );
  // The canonical block states the binding itself, so the region carries no
  // second sha256 prefix above it.
  assert.ok(whole.includes(`payload sha256: ${request_.payload_hash.value}`), whole);
  assert.equal(whole.includes("--- full payload (sha256"), false, whole);

  // The reading aid announces itself as claimed, so legible never reads as verified.
  assert.ok(whole.includes(EMAIL_VIEW_HEADING.replace(/&/gu, "&amp;")));

  assert.equal(recordsOf(world.unit.logPath).length, 3);
});

test("only structurally email-shaped payloads leave the JSON rendering", () => {
  const json = (value: unknown): string => JSON.stringify(value, null, 2);
  const view = (value: unknown, truncated = false): string =>
    payloadRegionText({ value, text: json(value), hash: "h", truncated }, VIEW_CLASS);

  // Recognised: the adapter's shape, with `to` as a list or as a bare string.
  assert.notEqual(emailPayloadFields({ to: ["a@b.example"], subject: "s", body: "b" }), null);
  assert.notEqual(emailPayloadFields({ to: "a@b.example", subject: "s", body: "b" }), null);

  // An unrecognised shape renders `opaque` (APRV-119): the canonical block
  // still surrounds it, still names the renderer and the binding, and carries
  // the payload's own bytes whole with no structural view over them.
  const opaque = (value: unknown): void => {
    const text = view(value);
    assert.ok(text.includes(OPAQUE_VIEW_HEADING), `no opaque heading for ${json(value)}`);
    assert.equal(text.includes(EMAIL_VIEW_HEADING), false, `email view for ${json(value)}`);
    assert.ok(text.includes(json(value)), `the bytes are not shown whole for ${json(value)}`);
  };

  // A self-declared kind buys nothing: it is simply a key this view cannot
  // show, so the payload stays opaque rather than being half-rendered.
  const declared = { kind: "email", to: ["a@b.example"], subject: "s", body: "b" };
  assert.equal(emailPayloadFields(declared), null);
  opaque(declared);

  // Wrong types, missing required fields, and non-objects all stay opaque.
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
    opaque(value);
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

  // The shape recogniser reports only the fields the payload carries…
  const noCc = emailPayloadFields({ to: ["c@d.example"], subject: "s", body: "b" });
  assert.equal(
    noCc?.some((field) => field.label === "cc"),
    false,
  );
  // …and the RENDERING prints the closed set anyway, absent members marked
  // (APRV-119). An omitted line and an empty value are different facts.
  const sparse = view({ to: ["c@d.example"], subject: "s", body: "b" });
  for (const label of ["from", "cc", "bcc", "content_type"]) {
    assert.ok(sparse.includes(`${label}: ${ABSENT}`), `${label} was omitted rather than marked`);
  }
});

test("callback_data is bounded, and the nonce — not the wire's key — is authoritative", () => {
  const short = callbackData("g", "abc123", "task-1:x");
  assert.equal(short, `g:abc123:${actionRefOf("task-1:x")}`);
  assert.deepEqual(parseCallbackData(short), {
    decision: "grant",
    scope: "one",
    nonce: "abc123",
    actionRef: actionRefOf("task-1:x"),
  });

  // APRV-196: the reference is a fixed-width digest, so the cross-check the
  // old plain-key form dropped for a long key is now always carried — and it
  // is the same for two copies of one request delivered by two processes,
  // which is what lets a pre-restart button resolve at all.
  const longKey = "task-1:".padEnd(200, "x");
  const long = callbackData("r", "abc123", longKey);
  assert.ok(
    Buffer.byteLength(long, "utf8") <= TELEGRAM_MAX_CALLBACK_BYTES,
    "callback_data must fit Telegram's 64-byte limit",
  );
  assert.deepEqual(parseCallbackData(long), {
    decision: "reject",
    scope: "one",
    nonce: "abc123",
    actionRef: actionRefOf(longKey),
  });
  assert.equal(actionRefOf(longKey).length, 16);
  assert.notEqual(actionRefOf(longKey), actionRefOf("task-1:x"));
  assert.equal(
    actionRefOf(longKey),
    actionRefOf(longKey),
    "the reference is a function of the action key alone",
  );

  // The cap still binds the whole string. A nonce long enough to break it is
  // not one this class issues, and the guard drops the reference rather than
  // the button: `callback_data` over 64 bytes is refused by `sendMessage`, so
  // overflowing would cost delivery and not merely a lookup.
  const overlong = "n".repeat(80);
  assert.equal(callbackData("g", overlong, "task-1:x"), `g:${overlong}`);
  assert.equal(parseCallbackData(callbackData("g", overlong, "task-1:x"))?.actionRef, null);

  // APRV-115: an "all" button names a delivery and never a set of keys, so the
  // set it decides cannot be chosen by whatever sent the bytes back.
  assert.equal(digestCallbackData("G", "abc123"), "G:abc123");
  assert.deepEqual(parseCallbackData("G:abc123"), {
    decision: "grant",
    scope: "all",
    nonce: "abc123",
    actionRef: null,
  });
  assert.deepEqual(parseCallbackData("R:abc123"), {
    decision: "reject",
    scope: "all",
    nonce: "abc123",
    actionRef: null,
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
  // button the edit did not manage to remove), so a redelivered callback never
  // reaches the gate. APRV-196 renamed what that refusal is CALLED — the
  // button now carries an action reference, so the channel can tell "a copy of
  // a request I am not holding open" (`stale-copy`) from "bytes I cannot place
  // at all" (`unknown-callback`) — and gave it a toast that says so. The
  // property this test exists for — a second tap can never produce a second
  // event — is unchanged, and the gate's own idempotency is still pinned by
  // `tests/gate.test.ts`.
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
    ["stale-copy"],
  );
  assert.equal(
    recordsOf(world.unit.logPath).length,
    after_,
    "a second tap must never produce a second event",
  );
  assert.equal(
    mock.answerTexts().at(-1),
    TELEGRAM_STALE_UNKNOWN,
    "a second tap must still be acked, and with a sentence about the request",
  );
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

// ---------------------------------------------------------------------------
// "message is not modified" (APRV-277)
//
// The report: after a tap that visibly worked, the listener printed
//   approval: telegram could not annotate the granted <key> (message N):
//   editMessageText: HTTP 400 — the buttons are stale but the gate refuses a
//   tap on them
// with the phone already showing the annotated message. Telegram answers 400
// "Bad Request: message is not modified" when an edit would change nothing,
// which is what a second annotation of an already-annotated message is. The
// warning was false, and the bare status was why nobody could tell: the
// transport threw the status away along with the Bot API's own description.
// ---------------------------------------------------------------------------

/** A fetch that fails `editMessageText` with one Bot API error body. */
function editFailsWith(
  status: number,
  description: string | null,
): NonNullable<TelegramConfig["fetch"]> {
  const passthrough = globalThis.fetch as unknown as NonNullable<TelegramConfig["fetch"]>;
  const body =
    description === null
      ? "<html>gateway</html>"
      : JSON.stringify({ ok: false, error_code: status, description });
  return async (url, init) => {
    if (url.endsWith("/editMessageText")) {
      return { ok: false, status, text: async () => body };
    }
    return await passthrough(url, init);
  };
}

const NOT_MODIFIED_DESCRIPTION = "Bad Request: message is not modified";

test("a 400 that says the message is not modified is not reported (APRV-277)", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);

  const channel = channelFor({ fetch: editFailsWith(400, NOT_MODIFIED_DESCRIPTION) });
  channel.onDecision(handlerFor(world, at(2)));
  await channel.notify(request_);

  const before = complaints.length;
  const outcome = await press(channel, key, "grant");
  assert.equal(outcome?.ok, true, JSON.stringify(outcome));

  // Nothing on the operator's terminal: the message already reads the way the
  // annotation wanted it to read, so there is no staleness to warn about.
  assert.deepEqual(
    complaints.slice(before).filter((entry) => entry.includes("could not annotate")),
    [],
    "an edit that changed nothing was reported as a failure",
  );

  // And the silence cost the decision nothing.
  assert.equal(
    recordsOf(world.unit.logPath).filter(
      (record) => record.event === "approval.granted" && record.action_key === key,
    ).length,
    1,
  );
  const next = await channel.pollOnce();
  assert.equal(next.updates, 0);
  assertClean(world.unit);
});

test("every other 400 is still reported, and says what the Bot API said (APRV-277)", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);

  // Same status, a different reason: this one really is a stale message, and an
  // operator who is not told cannot know the phone stopped agreeing with the
  // log.
  const channel = channelFor({
    fetch: editFailsWith(400, "Bad Request: message to edit not found"),
  });
  channel.onDecision(handlerFor(world, at(2)));
  await channel.notify(request_);

  const before = complaints.length;
  const outcome = await press(channel, key, "grant");
  assert.equal(outcome?.ok, true, JSON.stringify(outcome));

  const said = complaints.slice(before).join("\n");
  assert.match(
    said,
    /could not annotate the decided .* — the decision is recorded; only the message is stale/u,
  );
  // The status alone was the whole complaint before this task, which is why the
  // false one and the real one read identically.
  assert.match(said, /editMessageText: HTTP 400 \(Bad Request: message to edit not found\)/u);
  assertClean(world.unit);
});

test("the not-modified predicate reads the Bot API's own description (APRV-277)", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);

  /** What `annotate` throws when the edit fails this way. */
  const thrownBy = async (
    status: number,
    description: string | null,
  ): Promise<TelegramApiError> => {
    const channel = channelFor({ fetch: editFailsWith(status, description) });
    const messageId = await channel.notify(request_ as ChannelRequest);
    try {
      await channel.annotate(messageId, "GRANTED", ["by carter"], key);
    } catch (cause) {
      assert.ok(cause instanceof TelegramApiError, `not a TelegramApiError: ${String(cause)}`);
      return cause;
    }
    return assert.fail("the failing edit did not throw");
  };

  const notModified = await thrownBy(400, NOT_MODIFIED_DESCRIPTION);
  assert.equal(notModified.status, 400);
  assert.equal(notModified.description, NOT_MODIFIED_DESCRIPTION);
  assert.equal(isMessageNotModified(notModified), true);

  // Every other 400, every other status, and a body with nothing quotable in it
  // are all ordinary failures. The predicate is deliberately narrow: 400 is
  // also every malformed edit and every message the bot can no longer reach.
  const otherReason = await thrownBy(400, "Bad Request: message to edit not found");
  assert.equal(isMessageNotModified(otherReason), false);
  const otherStatus = await thrownBy(500, NOT_MODIFIED_DESCRIPTION);
  assert.equal(otherStatus.status, 500);
  assert.equal(isMessageNotModified(otherStatus), false);

  const noBody = await thrownBy(502, null);
  assert.equal(noBody.status, 502);
  assert.equal(noBody.description, null);
  assert.equal(noBody.message, "editMessageText: HTTP 502");
  assert.equal(isMessageNotModified(noBody), false);

  // And nothing that is not one of these errors is ever mistaken for one.
  assert.equal(isMessageNotModified(new Error(NOT_MODIFIED_DESCRIPTION)), false);
  assert.equal(isMessageNotModified(NOT_MODIFIED_DESCRIPTION), false);
  assert.equal(isMessageNotModified(null), false);
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

test("a digest annotates member by member: one decided, the rest still armed", async () => {
  // APRV-115: a batch is now ONE digest message carrying every member's row, so
  // per-member annotation is a redraw of that message rather than an edit of a
  // message of its own. The property is unchanged and is the one that matters:
  // deciding one member must leave the others answerable.
  const world = live(2);
  const [firstKey, secondKey] = world.keys as [string, string];
  const requests = queueOf(world, at(2));
  assert.equal(requests.length, 2);

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  const assembled = assembleBatch(requests);
  assert.equal(assembled.ok, true, JSON.stringify(assembled));
  if (!assembled.ok) return;
  const delivered = await channel.notifyBatch(assembled.batch);
  assert.ok(delivered.digestId !== null, "two similar requests must digest");

  assert.equal(channel.lastRendered().length, 2, "a batch is rendered member by member");

  const editedBefore = mock.edits().length;
  assert.equal((await press(channel, firstKey, "grant"))?.ok, true);
  const afterFirst = mock.edits().slice(editedBefore);
  assert.equal(afterFirst.length, 1, "one member decided is one redraw of the digest");
  const mixed = String(afterFirst[0]?.text);
  assert.match(mixed, /1 OF 2 REQUESTS STILL AWAITING APPROVAL/u);
  assert.match(mixed, /✓ APPROVED/u);
  assert.ok(mixed.includes(firstKey) && mixed.includes(secondKey), "a member left the digest");

  // The still-open member keeps its buttons; the decided one has lost them, and
  // with one left there is no "all" row to press by accident.
  const keyboard = afterFirst[0]?.replyMarkup as
    | { inline_keyboard: { text: string }[][] }
    | undefined;
  assert.deepEqual(
    keyboard?.inline_keyboard.map((row) => row.map((button) => button.text)),
    [["✅ Approve 2", "🛑 Reject 2"]],
  );

  // And it really is still answerable.
  assert.equal((await press(channel, secondKey, "reject"))?.ok, true);
  const afterSecond = mock.edits().slice(editedBefore + 1);
  assert.equal(afterSecond.length, 1);
  assert.match(String(afterSecond[0]?.text), /ALL 2 REQUESTS DECIDED/u);
  assert.match(String(afterSecond[0]?.text), /✗ REJECTED/u);
  assert.equal(afterSecond[0]?.replyMarkup, undefined, "a fully decided digest keeps no buttons");
  assertNoTokenInEdits();
  assertClean(world.unit);
});

// ---------------------------------------------------------------------------
// Digests (APRV-115)
// ---------------------------------------------------------------------------

/**
 * A research session once produced forty near-identical `network.call` prompts
 * in twenty minutes, one Telegram message each. These cases are about the two
 * halves of the fix and about the line between them:
 *
 * - the listener groups only requests that really are the same question, and
 * - a digest never gets a human closer to a grant than they were to the bytes.
 *
 * Nothing here writes a log line by hand. The all-button case in particular
 * drives the real callback path into the real handler into `decide()`, which is
 * the only way the "one event per member" property means anything.
 */

/** Press a digest's "all" button, and return the poll that carried it. */
async function pressAll(
  channel: TelegramChannel,
  decision: "grant" | "reject",
): Promise<TelegramPollResult> {
  mock.queueUpdate(callbackUpdate({ data: mock.digestAllDataFor(decision), chatId: CHAT }));
  return await channel.pollOnce();
}

test("only same-class, same-origin, same-shape requests share a digest", () => {
  const world = live(4);
  const requests = queueOf(world, at(2));
  const [a, b, c, d] = requests as [
    ChannelRequest,
    ChannelRequest,
    ChannelRequest,
    ChannelRequest,
  ];

  // Same class, same task, same payload shape for A and D. B declares another
  // class and C another task, and each of those is enough to split.
  const mixed: ChannelRequest[] = [
    a,
    { ...b, class: computed("network.call", "log") },
    { ...c, task: computed("task-999", "log") },
    d,
  ];

  assert.deepEqual(
    groupForDigest(mixed).map((group) => group.map((entry) => entry.action_key.value)),
    [[a.action_key.value, d.action_key.value], [b.action_key.value], [c.action_key.value]],
    "the grouping key is not (class, task, shape)",
  );
  assert.equal(digestKeyOf(a), digestKeyOf(d));
  assert.notEqual(digestKeyOf(a), digestKeyOf(mixed[1] as ChannelRequest));
  assert.notEqual(digestKeyOf(a), digestKeyOf(mixed[2] as ChannelRequest));
  assertClean(world.unit);
});

test("a command payload groups by argv[0]; anything else by its key set", () => {
  // Forty curls are one decision with forty URLs in it. A curl next to an rm is
  // not, and the shape token has to say so.
  assert.equal(payloadShapeKey({ command: "curl -s https://a.example", cwd: "/w" }), "argv0:curl");
  assert.equal(payloadShapeKey({ command: "curl -s https://b.example", cwd: "/w" }), "argv0:curl");
  assert.equal(payloadShapeKey({ command: "rm -rf /tmp/x", cwd: "/w" }), "argv0:rm");

  // Key order is not shape: the same object written two ways is one group.
  assert.equal(payloadShapeKey({ to: ["a@b.example"], subject: "s", body: "b" }), "keys:body,subject,to");
  assert.equal(payloadShapeKey({ body: "b", subject: "s", to: ["a@b.example"] }), "keys:body,subject,to");
  assert.notEqual(payloadShapeKey({ to: ["a@b.example"], subject: "s" }), "keys:body,subject,to");

  // A self-declared "kind" is just another key, never a way to choose a group.
  assert.equal(
    payloadShapeKey({ kind: "curl", command: "curl x", cwd: "/w" }),
    "keys:command,cwd,kind",
  );

  assert.equal(payloadShapeKey(null), "null");
  assert.equal(payloadShapeKey([1, 2]), "array");
  assert.equal(payloadShapeKey("text"), "scalar:string");
});

test("a burst larger than the cap becomes several digests, never one wall", () => {
  const world = live(5);
  const requests = queueOf(world, at(2));
  assert.deepEqual(
    groupForDigest(requests, 2).map((group) => group.length),
    [2, 2, 1],
    "a group past the cap must close and a fresh one open",
  );
  assert.equal(
    groupForDigest(requests).length,
    1,
    `five similar requests are one digest under the default cap of ${TELEGRAM_DIGEST_MAX_MEMBERS}`,
  );
  assertClean(world.unit);
});

test("a burst of similar requests yields one digest, and mixed decisions land per member", async () => {
  const world = live(3);
  const [first, second, third] = world.keys as [string, string, string];
  const channel = channelFor();
  const setup = setupFor(world, channel);
  channel.onDecision(handlerFor(world, at(3)));

  const before = mock.sentTexts().length;
  const { streams, out } = capture();
  const cycle = await dispatchPending(setup, streams, newDispatchState(), at(2));

  assert.equal(cycle.digests.length, 1, `three similar requests must digest: ${JSON.stringify(cycle.digests)}`);
  assert.deepEqual(cycle.digests[0]?.action_keys, [first, second, third]);
  const digestId = cycle.digests[0]?.delivery_id as string;
  assert.deepEqual(
    cycle.delivered.map((entry) => entry.delivery_id),
    [digestId, digestId, digestId],
    "every member's annotation must target the one digest message",
  );
  assert.ok(out.join("").includes(`notified ${first} (digest ${digestId}, 3 requests)`));

  const texts = mock.sentTexts().slice(before);
  const digestText = texts[texts.length - 1] as string;

  // AC3, structurally: the buttons are on the LAST message, and every member's
  // payload arrived in a message above it.
  assert.match(digestText, /3 REQUESTS AWAITING APPROVAL/u);
  const above = texts.slice(0, -1).join("\n");
  for (const [index, key] of world.keys.entries()) {
    assert.ok(digestText.includes(key), `${key} has no line on the digest`);
    assert.ok(above.includes(key), `${key} was never prompted above the digest`);
    assert.ok(
      above.includes(`Invoice ${41 + index} chaser`),
      `the payload of ${key} was not on screen before the buttons`,
    );
    assert.ok(
      above.includes(`REQUEST ${index + 1} OF 3`),
      "a digest member's prompt must say which request it is",
    );
  }
  assert.equal(
    above.includes(TELEGRAM_PROMPT_HEADING),
    false,
    "a member prompt carries no buttons and must not claim to be answerable",
  );

  // Mixed per-member decisions, through the real callback path.
  assert.equal((await press(channel, second, "grant"))?.ok, true);
  assert.equal((await press(channel, first, "reject"))?.ok, true);

  const records = recordsOf(world.unit.logPath);
  const decisions = records.filter(
    (record) => record.event === "approval.granted" || record.event === "approval.rejected",
  );
  assert.deepEqual(
    decisions.map((record) => [record.event, record.action_key]),
    [
      ["approval.granted", second],
      ["approval.rejected", first],
    ],
    "a mixed digest decided the wrong requests",
  );

  // The untouched member is still answerable, and the digest still says so.
  assert.equal((await press(channel, third, "grant"))?.ok, true);
  assertNoTokenInEdits();
  assertClean(world.unit);
});

test("Approve all is N decisions: one event per member, each bound to its own action", async () => {
  const world = live(3);
  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(3)));

  const assembled = assembleBatch(queueOf(world, at(2)));
  assert.equal(assembled.ok, true, JSON.stringify(assembled));
  if (!assembled.ok) return;
  const delivered = await channel.notifyBatch(assembled.batch);
  assert.ok(delivered.digestId !== null);

  const before = recordsOf(world.unit.logPath).length;
  const poll = await pressAll(channel, "grant");

  // One outcome per member, in member order, from the ONE tap.
  assert.deepEqual(
    poll.outcomes.map((entry) => entry.action_key),
    world.keys,
  );

  const records = recordsOf(world.unit.logPath);
  const appended = records.slice(before);
  assert.equal(appended.length, 3, "one tap over three requests must append exactly three events");

  for (const [index, record] of appended.entries()) {
    const key = world.keys[index] as string;
    assert.equal(record.event, "approval.granted");
    // No event spans actions: each names one action key, and the log has no
    // shape in which it could name two.
    assert.equal(record.action_key, key);
    assert.equal(typeof record.action_key, "string");
    // And each is bound to ITS OWN payload, not to the batch's first one.
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    assert.equal(
      payload["payload_hash"],
      payloadHash(world.payloads.get(key)),
      "a batched grant must carry the payload hash of its own action",
    );
    // The one thing tying the three back together for audit (SPEC.md §10.3).
    assert.equal(batchDeliveryIdOf(record), delivered.batchDeliveryId);
  }

  // Compare-and-append: three appends, three consecutive sequence numbers, and
  // the chain verifies. A concurrent writer would have refused one member with
  // `append-failed` rather than producing this.
  assert.deepEqual(
    appended.map((record) => record.seq),
    [before + 1, before + 2, before + 3],
  );
  assertClean(world.unit);

  // The digest now says so, and offers nothing further.
  const edits = editsFor(delivered.digestId as string);
  assert.equal(edits.length, 1, "one tap over the set is one redraw");
  assert.match(String(edits[0]?.text), /ALL 3 REQUESTS DECIDED/u);
  assert.equal(edits[0]?.replyMarkup, undefined);
  // APRV-206: the tap's one answer is the early ack, sent before any of the
  // three decisions ran. The tally the toast used to carry is on the operator's
  // terminal, and the outcome the approver reads is the redraw above.
  assert.equal(mock.answerTexts().at(-1), TELEGRAM_ACK_HEARD);
  assert.ok(
    complaints.some((line) => line.includes("Approved 3 — one log event each.")),
    `no digest tally on the operator stream: ${complaints.join("\n")}`,
  );
  assertNoTokenInEdits();
});

test("Approve all after a member was decided elsewhere records only the rest", async () => {
  const world = live(3);
  const [first] = world.keys as [string, string, string];
  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(4)));

  const assembled = assembleBatch(queueOf(world, at(2)));
  assert.equal(assembled.ok, true, JSON.stringify(assembled));
  if (!assembled.ok) return;
  await channel.notifyBatch(assembled.batch);

  // The human answered this one at the CLI a moment ago. The digest has not
  // been redrawn yet, so its button is still there — and the gate is what
  // refuses it, not the channel's memory.
  const early = recordChannelDecision(
    world.unit.logPath,
    { action_key: first, decision: "grant", deliveryId: "cli" },
    { actor: HUMAN, channel: "cli" },
    { ...world.unit.options, clock: fixedClock(at(3)) },
  );
  assert.equal(early.outcome.ok, true, JSON.stringify(early.outcome));

  const before = recordsOf(world.unit.logPath).length;
  const poll = await pressAll(channel, "grant");
  assert.equal(poll.outcomes.length, 3, "every open member is still attempted");
  assert.deepEqual(
    poll.outcomes.map((entry) => (entry.outcome.ok ? "ok" : entry.outcome.code)),
    ["already-decided", "ok", "ok"],
  );
  // Two grants and, since APRV-235, the audit trail of the refused member: the
  // human tapped over it too, and a decision that could not be taken is still a
  // decision that was made. What matters here is unchanged — the refused member
  // produced no `approval.*` decision, and it did not stop the other two.
  assert.deepEqual(
    recordsOf(world.unit.logPath)
      .slice(before)
      .map((record) => record.event)
      .sort(),
    ["approval.granted", "approval.granted", "audit.decision_refused"],
    "a refused member recorded a decision, or stopped the others",
  );
  // APRV-206: acked before the members were decided, so the tally is the
  // operator's line rather than the toast.
  assert.equal(mock.answerTexts().at(-1), TELEGRAM_ACK_HEARD);
  assert.ok(
    complaints.some((line) => /Approved 2; 1 refused \(already-decided\)/u.test(line)),
    `no digest tally on the operator stream: ${complaints.join("\n")}`,
  );
  assertClean(world.unit);
});

test("a digest too large to render falls back to one message per member", async () => {
  // Eight members whose claimed summaries are long enough that their eight
  // digest lines cannot fit one message. Each member's own prompt still fits,
  // which is the point: the fallback is more messages, never a shorter digest.
  const world = live(8);
  const requests = queueOf(world, at(2)).map((request) => ({
    ...request,
    summary: claimed("chase ".repeat(80), ACTOR),
  }));

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  const assembled = assembleBatch(requests);
  assert.equal(assembled.ok, true, JSON.stringify(assembled));
  if (!assembled.ok) return;

  const before = mock.sentTexts().length;
  const delivered = await channel.notifyBatch(assembled.batch);
  assert.equal(delivered.digestId, null, "an oversized digest must fall back, never truncate");
  assert.equal(
    new Set(delivered.members.map((member) => member.delivery_id)).size,
    8,
    "the fallback is one message per member, so each has its own delivery id",
  );
  for (const text of mock.sentTexts().slice(before)) {
    assert.ok(text.length <= 4096, "a fallback message exceeded Telegram's limit");
  }

  // Still one batch delivery id, so audit granularity survives the fallback.
  const [firstKey, secondKey] = world.keys as [string, string];
  assert.equal((await press(channel, firstKey, "grant"))?.ok, true);
  assert.equal((await press(channel, secondKey, "grant"))?.ok, true);
  for (const record of recordsOf(world.unit.logPath).filter(
    (entry) => entry.event === "approval.granted",
  )) {
    assert.equal(batchDeliveryIdOf(record), delivered.batchDeliveryId);
  }
  assertClean(world.unit);
});

test("a withdrawn digest member is annotated on its own line; the rest stay armed", async () => {
  const world = live(2);
  const [first, second] = world.keys as [string, string];
  const setup = setupFor(world, channelFor());
  const state = newDispatchState();

  const cycle = await dispatchPending(setup, capture().streams, state, at(2));
  const digestId = cycle.digests[0]?.delivery_id as string;
  assert.ok(digestId !== undefined, JSON.stringify(cycle));

  const gone = withdraw(world.unit.logPath, first, ACTOR, at(11), {
    ...world.unit.options,
    reason: "timeout",
  });
  assert.equal(gone.ok, true, gone.ok ? "" : gone.message);

  const next = await dispatchPending(setup, capture().streams, state, at(12));
  assert.deepEqual(
    next.annotated.map((entry) => [entry.action_key, entry.outcome]),
    [[first, "withdrawn"]],
  );

  const edits = editsFor(digestId);
  assert.equal(edits.length, 1, "one member settling is one redraw");
  const text = String(edits[0]?.text);
  assert.match(text, /1 OF 2 REQUESTS STILL AWAITING APPROVAL/u);
  assert.match(text, /WITHDRAWN — no decision is needed/u);
  assert.match(text, /withdrawn by the requester at 10:11 UTC \(timeout\) · nothing to do/u);
  assert.ok(text.includes(second), "the surviving member left the digest");

  // Mixed state, and the survivor keeps exactly its own buttons.
  const keyboard = edits[0]?.replyMarkup as
    | { inline_keyboard: { text: string }[][] }
    | undefined;
  assert.deepEqual(
    keyboard?.inline_keyboard.map((row) => row.map((button) => button.text)),
    [["✅ Approve 2", "🛑 Reject 2"]],
  );

  // Idempotent, exactly as the single-prompt case is.
  const again = await dispatchPending(setup, capture().streams, state, at(13));
  assert.deepEqual(again.annotated, []);
  assert.equal(editsFor(digestId).length, 1);
  assertClean(world.unit);
});

test("a digest expired by the daemon annotates its member, and the tap is refused", async () => {
  const world = live(2);
  const [first] = world.keys as [string, string];
  const channel = channelFor();
  const setup = setupFor(world, channel);
  channel.onDecision(handlerFor(world, at(1502)));
  const state = newDispatchState();

  const cycle = await dispatchPending(setup, capture().streams, state, at(2));
  const digestId = cycle.digests[0]?.delivery_id as string;
  assert.ok(digestId !== undefined, JSON.stringify(cycle));

  const lapsed = expire(world.unit.logPath, first, at(1500), world.unit.options);
  assert.equal(lapsed.ok, true, JSON.stringify(lapsed));

  const next = await dispatchPending(setup, capture().streams, state, at(1501));
  assert.deepEqual(
    next.annotated.map((entry) => entry.outcome),
    ["expired"],
  );
  assert.match(String(editsFor(digestId)[0]?.text), /EXPIRED — the approval window closed/u);

  // Its nonce went with the redraw, so a stale tap resolves to nothing rather
  // than reaching the gate at all.
  const before = recordsOf(world.unit.logPath).length;
  mock.queueUpdate(
    callbackUpdate({ data: mock.callbackDataFor(first, "grant"), chatId: CHAT }),
  );
  const poll = await channel.pollOnce();
  assert.deepEqual(
    poll.ignored.map((entry) => entry.kind),
    ["stale-copy"],
  );
  assert.equal(recordsOf(world.unit.logPath).length, before, "a stale tap appended something");
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

  // Requested at at(1), rendered at at(32): 31 minutes of a 24h TTL gone, so an
  // answer has until 10:01 UTC on the FOLLOWING day. A COMPUTED line, under the
  // computed heading.
  //
  // APRV-143 lives in the word "tomorrow". This assertion used to read `expires
  // 10:01 UTC`, which is the bug: a deadline 23½ hours away rendered as a time
  // thirty minutes in the past, and an approver doing the arithmetic on their
  // phone concluded the question was already dead.
  const sent = mock.sentTexts().join("\n");
  assert.match(sent, /waiting:<\/b> requested 31 min ago · expires tomorrow 10:01 UTC/u);
  const rendered = channel.lastRendered()[0];
  assert.equal(
    rendered?.fields.find((field) => field.field === "waiting")?.kind,
    "computed",
  );
  // APRV-143: the `ttl:` line is gone. `expires` above carries the same fact,
  // as the instant a reader acts on rather than as a duration they must add to
  // a timestamp, and the value itself stays on the request for `--json`.
  assert.doesNotMatch(sent, /<b>ttl:<\/b>/u);
  assert.equal(
    rendered?.fields.find((field) => field.field === "ttl_remaining_ms"),
    undefined,
    "the prompt still renders a ttl line",
  );
  assert.equal(request_.ttl_remaining_ms.kind, "computed");
  assert.ok(
    (request_.ttl_remaining_ms.value ?? 0) > 0,
    "the TTL left the request as well as the prompt",
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

test("the requester's own deadline gets the same day word the TTL does", async () => {
  // APRV-143 #1: both waiting-line variants share one implementation, so the
  // `requester waits until` branch gains "tomorrow" without a second copy of
  // the day arithmetic that could disagree with the first.
  const world = live(1);
  hookedRequest(world, { waitUntil: at(1_500) });
  const [, hooked] = queueOf(world, at(2));
  assert.ok(hooked !== undefined);

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  await channel.notify(hooked);

  // at(1500) is 25 hours after T0: 11:00 UTC on 6 August, the next UTC day.
  assert.match(
    mock.sentTexts().join("\n"),
    /waiting:<\/b> requested 1 min ago · requester waits until tomorrow 11:00 UTC/u,
  );
  assertClean(world.unit);
});

test("the prompt names the protected path that earned the class", async () => {
  // APRV-143 #3, end to end through the renderer: the approver reads WHICH
  // file, as a computed line, without opening the payload block.
  const world = live(1);
  hookedRequest(world, { command: "cp draft.md .github/workflows/ci.yml" });
  const [, hooked] = queueOf(world, at(2));
  assert.ok(hooked !== undefined);

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  await channel.notify(hooked);

  const sent = mock.sentTexts().join("\n");
  assert.match(
    sent,
    /<b>protected path:<\/b> \.github\/workflows\/ci\.yml \(rule protected-path\) <i>\(classifier\)<\/i>/u,
  );
  assert.equal(
    channel.lastRendered()[0]?.fields.find((field) => field.field === "protected_path")?.kind,
    "computed",
  );
  assertClean(world.unit);
});

test("a prompt with no protected path carries no protected-path line", async () => {
  const world = live(1);
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);
  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  await channel.notify(request_);

  // `mock.sentTexts()` accumulates across the file, so the absence is asserted
  // on THIS prompt's own rendering report rather than on the whole transcript.
  const fields = channel.lastRendered()[0]?.fields ?? [];
  assert.equal(
    fields.find((field) => field.field === "protected_path"),
    undefined,
    "an email payload was given a protected-path line",
  );
  assertClean(world.unit);
});

/** What a {@link hookedRequest} may vary. Everything else is the hook's shape. */
interface HookedOptions {
  /** The requester's own declared deadline. Defaults to `at(10)`. */
  waitUntil?: string;
  /** The command in the bound payload. Defaults to a local amend. */
  command?: string;
}

/**
 * Register and request one harness-executed action carrying a `wait_until`,
 * the way `approval hook claude-code` does. Returns its action key.
 */
function hookedRequest(world: Live, options: HookedOptions = {}): string {
  const command = options.command ?? "git commit --amend";
  const waitUntil = options.waitUntil ?? at(10);
  const key = "task-101:amend";
  const payload = { command, cwd: "/repo" };
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
            summary: command,
            reversible: false,
            est_cost_usd: "0",
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
      est_cost_usd: "0",
      reversible: false,
      summary: command,
      payload_hash: payloadHash(payload),
      payload: { value: payload },
      execution: "harness",
      wait_until: waitUntil,
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
  // APRV-235: one record, and it is the audit trail of the refusal rather than
  // a decision. No `approval.*` event was written, nothing was granted, and the
  // request is as withdrawn as it was — `tests/decision-refusal.test.ts` is
  // where the state, budget and sampling comparison says so.
  assert.deepEqual(
    recordsOf(world.unit.logPath)
      .slice(before)
      .map((record) => record.event),
    ["audit.decision_refused"],
  );
  // APRV-206. The tap's one answer went out before the gate ran, so the refusal
  // is in the message edit — where it outlives the toast that used to carry it.
  assert.equal(mock.answerTexts().at(-1), TELEGRAM_ACK_HEARD);
  const refused = mock.edits().at(-1);
  assert.match(String(refused?.text), /NOT RECORDED/u);
  assert.match(
    String(refused?.text),
    /Withdrawn — the requester took this back and is no longer waiting/u,
  );
  assert.equal(refused?.replyMarkup, undefined, "a refused tap must leave no live button");
  assertClean(world.unit);
});

test("a tap refused for policy drift is told so on the message, and the request is withdrawn (APRV-235)", async () => {
  // The 2026-09-02 scenario, end to end. Carter tapped approve on a request
  // asked under the previous policy; the gate refused, correctly, and the
  // reason went to the operator's terminal. The person holding the phone saw
  // nothing at all, and the request stayed pending on Telegram and in QUEUE.md.
  const world = live(1);
  const key = world.keys[0] as string;
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(12)));
  const messageId = await channel.notify(request_);

  // A human re-attests between the routing and the tap.
  writeFileSync(world.unit.policyPath, POLICY_REATTESTED, "utf8");
  assert.equal(
    appendAttestation(world.unit.logPath, world.unit.policyPath, HUMAN, {
      clock: fixedClock(at(11)),
    }).ok,
    true,
  );

  const before = recordsOf(world.unit.logPath).length;
  const outcome = await press(channel, key, "grant");
  assert.equal(outcome?.ok, false, "a drifted request must not be grantable");
  if (outcome !== undefined && !outcome.ok) assert.equal(outcome.code, "policy-drift");

  // Two records, in this order: what happened to the human's answer, then the
  // state change that follows from it.
  const written = recordsOf(world.unit.logPath).slice(before);
  assert.deepEqual(
    written.map((record) => record.event),
    ["audit.decision_refused", "approval.withdrawn"],
  );

  // The tapper is told, on the message, in one line, and the buttons go with
  // it: a request the gate has declared void has no decision left to collect.
  const edits = editsFor(messageId);
  const refused = edits.at(-1);
  assert.match(String(refused?.text), /NOT RECORDED/u);
  assert.match(String(refused?.text), /Policy changed after this was asked/u);
  assert.match(String(refused?.text), /has been withdrawn/u);
  assert.equal(refused?.replyMarkup, undefined, "a refused tap must leave no live button");

  // And the listener stops offering it: a fresh dispatch re-derives pending
  // from the verified log, where the request is now settled.
  const setup = setupFor(world, channelFor());
  const next = await dispatchPending(setup, capture().streams, newDispatchState(), at(13));
  assert.deepEqual(next.delivered, [], "the void request was sent again");
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
        // APRV-197. The listener asks for a gloss by default now, and this is
        // the one case in this file that runs the REAL verb, so without a fake
        // binary in front of it the suite would call a language model and wait
        // ~13s for it. The stub answers instantly and deterministically, which
        // also makes the assertion below a real check that the verb is wired.
        ...fakeClaudeEnv(world.unit.dir),
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

  // APRV-197. The listener asks for a gloss without being told to, and the
  // stub's sentence arrives on the prompt labelled as a model's. This is the
  // only assertion in the suite that the VERB is wired to a runner at all —
  // every other gloss test injects one directly.
  assert.ok(
    sent.includes(`${FAKE_GLOSS_SENTENCE} ${TELEGRAM_GLOSS_SUFFIX}`),
    `the default-on gloss did not reach the prompt: ${sent}`,
  );
  const logBytes = readFileSync(world.unit.logPath, "utf8");
  assert.equal(logBytes.includes(FAKE_GLOSS_SENTENCE), false, "the gloss reached the log");
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

/**
 * A payload whose top-level key set is unique to `index` (APRV-216).
 *
 * `digestKeyOf` groups by payload SHAPE, so the ordinary fixture's requests are
 * all one digest — which is right, and is exactly what the paced cases must not
 * accidentally rely on when they are counting messages. A per-index key makes
 * every request its own group, so "one summary and one request" is a claim
 * about pacing rather than about grouping.
 */
function distinctPayloadFor(index: number): Record<string, unknown> {
  return { ...payloadFor(index), [`thread_${String(index)}`]: `ref-${String(index)}` };
}

/** A staged world: `count` actions registered, none requested yet. */
function staged(
  count: number,
  makePayload: (index: number) => Record<string, unknown> = payloadFor,
): Live {
  fixtureCounter += 1;
  const prefix = `staged${fixtureCounter}`;
  const unit = newScenario(scratch.root, POLICY);
  attest(unit, T0);

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
      est_cost_usd: "0.02",
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
      est_cost_usd: "0.02",
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

function setupFor(
  world: Live,
  channel: TelegramChannel,
  gloss?: GlossRunner,
  /**
   * APRV-216. The PRODUCT default is `paced`; this helper defaults to `burst`
   * because the cases below it were written against burst and are what proves
   * `delivery: burst` still restores that behaviour (AC 5). The paced cases
   * ask for `paced` by name, so both modes are exercised and neither is
   * exercised by accident.
   */
  delivery: TelegramDelivery = "burst",
): ListenSetup {
  return {
    channel,
    logPath: world.unit.logPath,
    actor: HUMAN,
    json: false,
    once: false,
    delivery,
    gateOptions: world.unit.options,
    tagOptions: world.tagOptions,
    // APRV-257. Present because `ListenSetup` requires it, and inert in this
    // suite: these fixtures declare no `audit.checkpoint_every` and no
    // `audit.checkpoint_keys`, so `checkpointOfferFor` gives up on the policy
    // read and no dispatch cycle below ever offers one. The tap's own cases are
    // `tests/checkpoint-tap.test.ts`.
    checkpoint: {
      logPath: world.unit.logPath,
      policy: world.tagOptions.policy ?? {},
      keyFile: null,
      vault: null,
    },
    // Absent unless a test hands one over. No suite in this repository may
    // invoke a model, so the production runner is never the default here.
    ...(gloss === undefined ? {} : { gloss }),
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
    payloadRegionText({ value, text: json(value), hash: "h", truncated }, VIEW_CLASS);

  const edit = {
    tool: "Edit",
    rule: "protected-path",
    file: "/repo/.github/workflows/ci.yml",
    before: "  - run: npm test\n  - run: npm run lint",
    after: "  - run: npm test",
  };
  const rendered = view(edit);
  assert.ok(rendered.includes(EDIT_VIEW_HEADING), rendered);
  assert.ok(rendered.includes("file: /repo/.github/workflows/ci.yml"), rendered);
  assert.ok(rendered.includes(`note: ${LIVE_QUALIFIER}`), rendered);
  assert.ok(rendered.includes("-  - run: npm run lint"), rendered);
  assert.ok(rendered.includes("+  - run: npm test"), rendered);
  // The diff IS the rendering (APRV-162): no JSON copy of the same bytes, and
  // the store path names where the bytes themselves are.
  assert.equal(rendered.includes(CANONICAL_JSON_HEADING), false, rendered);
  assert.ok(rendered.includes(rawBytesLine(payloadHash(edit))), rendered);

  // The proposal tier renders its own qualifier, from the same key.
  assert.ok(view({ ...edit, rule: "protected-path-proposal" }).includes(PROPOSAL_QUALIFIER));

  // A whole-file write: no removed side, and the absence is stated.
  const write = { tool: "Write", rule: "protected-path", file: "/repo/APPROVAL.md", content: "a\nb" };
  assert.ok(view(write).includes("the whole file as it will be written (2 lines)"), view(write));
  assert.ok(view(write).includes("+a\n+b"), view(write));

  // Half a change, an unknown key, a wrong type: opaque, never half a diff.
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
    const text = view(value);
    assert.ok(text.includes(OPAQUE_VIEW_HEADING), `no opaque heading for ${json(value)}`);
    assert.equal(text.includes(EDIT_VIEW_HEADING), false, `diff view for ${json(value)}`);
    assert.ok(text.includes(json(value)), `the bytes are not shown whole for ${json(value)}`);
  }
  assert.equal(view(edit, true), json(edit), "a truncated rendering must not be re-expanded");

  // `replace_all` is part of the question. Shown when the call sets it, and
  // marked absent when it does not (APRV-119's closed field set): "replace one"
  // and "a renderer that does not show this" must not look the same.
  assert.ok(view({ ...edit, replace_all: true }).includes("replace_all: true"));
  assert.ok(rendered.includes(`replace_all: ${ABSENT}`), rendered);
});

test("a very long change renders whole (APRV-162: the view is the only reading)", () => {
  const lines = Array.from({ length: 300 }, (_, index) => `line ${String(index)}`);
  const after = lines.join("\n");
  const payload = { tool: "Write", rule: "protected-path", file: "/repo/CLAUDE.md", content: after };
  const text = payloadRegionText(
    { value: payload, text: JSON.stringify(payload, null, 2), hash: "h", truncated: false },
    VIEW_CLASS,
  );
  for (const line of lines) assert.ok(text.includes(`+${line}`), `${line} is not on screen`);
  assert.equal(/more lines \(hash covers all bytes\)/u.test(text), false, "a fold survived");
  assert.ok(text.includes(rawBytesLine(payloadHash(payload))), text);
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
    whole.includes(`payload sha256: ${request_.payload_hash.value}`),
    "the canonical block lost its binding line",
  );
  assert.equal(whole.includes("--- full payload (sha256"), false, whole);
  for (const text of texts) {
    assert.ok(text.length <= 4096, "a message exceeded Telegram's 4096-character limit");
  }
  assert.equal(recordsOf(world.unit.logPath).length, 3);
});

// ---------------------------------------------------------------------------
// Shell commands on the phone (APRV-126)
// ---------------------------------------------------------------------------

test("a command payload renders over its real lines, with cwd and the store path", () => {
  const json = (value: unknown): string => JSON.stringify(value, null, 2);
  const view = (value: unknown, truncated = false): string =>
    payloadRegionText({ value, text: json(value), hash: "deadbeef", truncated }, VIEW_CLASS);

  const command = [
    "gh pr create --title 'ship it' --body 'first line",
    "second line",
    "",
    "a literal escape: a\\nb'",
  ].join("\n");
  const payload = { command, cwd: "/repo" };
  const rendered = view(payload);

  assert.ok(rendered.includes(COMMAND_VIEW_HEADING), rendered);
  assert.ok(rendered.includes(ESCAPE_LEGEND), rendered);
  assert.ok(rendered.includes("command (4 lines):"), rendered);
  assert.ok(rendered.includes(`${COMMAND_BEGIN}\ngh pr create`), rendered);
  assert.ok(rendered.includes("\nsecond line\n"), "the line break was not rendered as one");
  // The two literal bytes are marked, so they cannot be read as a line break.
  assert.ok(rendered.includes("a literal escape: a«\\n»b'"), rendered);
  // cwd on its own line, beneath the command block.
  assert.ok(rendered.includes(`${COMMAND_END}\ncwd: /repo`), rendered);
  // And where the exact bytes are, said in the prompt itself, under the hash
  // the renderer recomputes from the payload rather than one a caller supplied.
  assert.ok(rendered.includes(rawBytesLine(payloadHash(payload))), rendered);

  // The command view IS the rendering (APRV-162): the bytes are not repeated
  // beneath it as JSON, and the store path is what leads back to them.
  assert.equal(rendered.includes(CANONICAL_JSON_HEADING), false, rendered);
  assert.equal(rendered.includes(json(payload)), false, rendered);

  // A payload without a cwd says so rather than rendering an empty line.
  assert.ok(view({ command: "ls" }).includes("cwd: (none declared)"));
});

test("only structurally command-shaped payloads leave the JSON rendering", () => {
  const json = (value: unknown): string => JSON.stringify(value, null, 2);
  const view = (value: unknown, truncated = false): string =>
    payloadRegionText({ value, text: json(value), hash: "h", truncated }, VIEW_CLASS);

  assert.deepEqual(commandPayloadView({ command: "ls", cwd: "/repo" }), {
    command: "ls",
    cwd: "/repo",
  });
  assert.deepEqual(commandPayloadView({ command: "ls" }), { command: "ls", cwd: null });

  // An unknown key or a wrong type: opaque, every time. A key this view cannot
  // show would be a hidden payload wearing a friendlier face, which is the
  // failure the email view was careful about first.
  for (const value of [
    { command: "ls", cwd: "/repo", shell: "zsh" },
    { command: "ls", cwd: 3 },
    { command: 3, cwd: "/repo" },
    { cwd: "/repo" },
    ["ls"],
    "just a string",
    null,
  ]) {
    assert.equal(commandPayloadView(value), null, `wrongly recognised ${json(value)}`);
    const text = view(value);
    assert.ok(text.includes(OPAQUE_VIEW_HEADING), `no opaque heading for ${json(value)}`);
    assert.equal(text.includes(COMMAND_VIEW_HEADING), false, `command view for ${json(value)}`);
    assert.ok(text.includes(json(value)), `the bytes are not shown whole for ${json(value)}`);
  }
  const whole = { command: "ls", cwd: "/repo" };
  assert.equal(view(whole, true), json(whole), "a truncated rendering must not be re-expanded");
});

test("two distinct byte strings never render identically (property)", () => {
  // The rendering the command block applies to the bytes: split on real
  // newlines, mark literal escape sequences on each line. If this were not
  // injective an agent could write one payload and have the approver read
  // another, which is the whole reason the marker exists.
  const display = (bytes: string): string => bytes.split("\n").map(markEscapes).join("\n");

  // The case the acceptance criterion names, stated on its own so a failure
  // reads as the thing it is rather than as a generator seed.
  assert.notEqual(display("a\\nb"), display("a\nb"));
  assert.equal(display("a\\nb"), "a«\\n»b");
  assert.equal(display("a\nb"), "a\nb");

  // And the general property, over an alphabet built from exactly the
  // characters that could collide: the escape letters, the backslash, real
  // control characters, and the marker delimiters themselves.
  const alphabet = ["\\", "n", "r", "t", "\n", "\r", "\t", "«", "»", "a", " "];
  let seed = 0x5eed_1260;
  const next = (): number => {
    seed = (seed + 0x6d2b_79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  const seen = new Map<string, string>();
  for (let index = 0; index < 4_000; index += 1) {
    const length = 1 + Math.floor(next() * 6);
    let bytes = "";
    for (let position = 0; position < length; position += 1) {
      bytes += alphabet[Math.floor(next() * alphabet.length)] as string;
    }
    const shown = display(bytes);
    const first = seen.get(shown);
    if (first === undefined) {
      seen.set(shown, bytes);
      continue;
    }
    assert.equal(
      first,
      bytes,
      `two distinct byte strings rendered identically: ${JSON.stringify(first)} and ${JSON.stringify(bytes)} both render ${JSON.stringify(shown)}`,
    );
  }
  assert.ok(seen.size > 1_000, `the generator produced too few distinct strings (${seen.size})`);
});

test("a very long command renders whole (APRV-162: the view is the only reading)", () => {
  const commandLines = Array.from({ length: 300 }, (_, index) => `echo ${String(index)}`);
  const command = commandLines.join("\n");
  const payload = { command, cwd: "/repo" };
  const text = payloadRegionText(
    { value: payload, text: JSON.stringify(payload, null, 2), hash: "h", truncated: false },
    VIEW_CLASS,
  );

  for (const line of commandLines) assert.ok(text.includes(`${line}\n`), `${line} is not on screen`);
  assert.equal(/more lines \(hash covers all bytes\)/u.test(text), false, "a fold survived");
  // The store path names the RECOMPUTED binding (APRV-119): the renderer takes
  // the payload and derives the hash itself, so a caller cannot label a
  // rendering with somebody else's content address.
  assert.ok(text.includes(rawBytesLine(payloadHash(payload))), text);
});

test("a command reaches Telegram escaped, chunked and complete", async () => {
  // The end-to-end of the APRV-126 complaint: the approver reads the COMMAND,
  // through the real transport, with markup in it that must not become markup.
  const command = "gh pr create --body 'a <b> & c\nsecond line'";
  const payload = { command, cwd: "/repo" };
  const world = live(1, false, () => payload);
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  const before = mock.sentTexts().length;
  await channel.notify(request_);
  const texts = mock.sentTexts().slice(before);
  const whole = texts.join("\n");

  assert.ok(whole.includes("gh pr create --body 'a &lt;b&gt; &amp; c"), whole);
  assert.ok(whole.includes("\nsecond line'"), "the line break did not survive the transport");
  assert.equal(whole.includes("<b> &"), false, "raw markup reached the message");
  assert.ok(whole.includes(`cwd: /repo`), whole);
  assert.ok(whole.includes(rawBytesLine(request_.payload_hash.value)), whole);
  assert.ok(
    whole.includes(`payload sha256: ${request_.payload_hash.value}`),
    "the canonical block lost its binding line",
  );
  assert.equal(whole.includes("--- full payload (sha256"), false, whole);
  for (const text of texts) {
    assert.ok(text.length <= 4096, "a message exceeded Telegram's 4096-character limit");
  }
  assert.equal(recordsOf(world.unit.logPath).length, 3);
});

// ---------------------------------------------------------------------------
// The command summary states what the command does (APRV-144)
// ---------------------------------------------------------------------------

/** The `commands` breakdown line of a prompt built from `command`. */
function breakdownLineFor(command: string): string | undefined {
  const payload = { command, cwd: "/repo" };
  const world = live(1, false, () => payload);
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);
  assert.equal(request_.command_breakdown?.kind, "computed");
  return request_.command_breakdown?.value;
}

test("a compound command is broken down segment by segment", () => {
  // The shape of the real complaint: a records commit, where the summary an
  // approver used to read was `git add .approval/log/…` and nothing else, so
  // the push and the PR at the end of the chain were invisible.
  assert.equal(
    breakdownLineFor(
      "git add .approval/log/events.jsonl && git commit -m 'APRV-93: records' && " +
        "git push origin main:records-2026-08-25 && gh pr create --fill",
    ),
    "git add .approval/log/events.jsonl · git commit · " +
      "git push origin main:records-2026-08-25 · gh pr create",
  );
});

test("a flag's value is not mistaken for the segment's argument", () => {
  // `-m` takes a value, and a breakdown that showed the commit message as the
  // salient argument would be describing the prose rather than the effect.
  assert.equal(breakdownLineFor("git commit -m 'a long commit message here'"), "git commit");
  // A flag carrying its own value leaves the next word alone.
  assert.equal(breakdownLineFor("git push --force-with-lease origin main"), "git push origin main");
});

test("a long segment folds with an ellipsis rather than running off the screen", () => {
  const line = breakdownLineFor(
    "git push origin main:records-2026-08-25-a-very-long-branch-name-indeed",
  );
  assert.ok(line !== undefined);
  assert.ok(line.endsWith("…"), line);
  assert.ok(line.length <= 40, `segment budget exceeded: ${line}`);
  assert.ok(line.startsWith("git push origin main:records-"), line);
});

test("a breakdown past the segment cap says how many it did not show", () => {
  const line = breakdownLineFor(Array.from({ length: 11 }, () => "pwd").join(" && "));
  assert.ok(line !== undefined);
  assert.equal(line.split(" · ").length, 9, line);
  assert.ok(line.endsWith("… 3 more"), line);
});

test("the breakdown comes from the classifier's parse, quotes and all", () => {
  // One tokenizer, not two: the quoted argument arrives unquoted because that
  // is how `lex` read it when it chose the class, and a display layer that
  // re-split the string could disagree.
  assert.equal(breakdownLineFor("cp 'my notes.md' docs/"), "cp my notes.md docs/");
});

test("a command the tokenizer refuses gets no breakdown, and no guess", () => {
  const payload = { command: "echo 'unterminated", cwd: "/repo" };
  const world = live(1, false, () => payload);
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);
  assert.equal(request_.command_breakdown, undefined);
});

test("a non-command payload carries no breakdown", () => {
  const world = live(1);
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);
  assert.equal(request_.command_breakdown, undefined);
});

test("the prompt shows the breakdown as computed, above the raw command", async () => {
  const command = "git add . && git push origin main";
  const payload = { command, cwd: "/repo" };
  const world = live(1, false, () => payload);
  const [request_] = queueOf(world, at(2));
  assert.ok(request_ !== undefined);

  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  const before = mock.sentTexts().length;
  await channel.notify(request_);
  const whole = mock.sentTexts().slice(before).join("\n");

  assert.match(
    whole,
    /<b>commands:<\/b> git add \. · git push origin main <i>\(classifier\)<\/i>/u,
  );
  assert.equal(
    channel.lastRendered()[0]?.fields.find((field) => field.field === "command_breakdown")?.kind,
    "computed",
  );
  // APRV-144 #3: the raw-command headline stays, and the breakdown sits above
  // it rather than replacing it.
  assert.ok(whole.indexOf("<b>commands:</b>") < whole.indexOf("--- command begins ---"), whole);
  // The raw command in full, escaped by the channel exactly as it always was:
  // `&&` is markup-significant in Telegram's HTML mode and reaches the chat as
  // text. The breakdown is an aid ABOVE the bytes, never a replacement for them.
  assert.ok(whole.includes("git add . &amp;&amp; git push origin main"), whole);
  assert.equal(command, "git add . && git push origin main");
});

// ---------------------------------------------------------------------------
// The model gloss (APRV-144 #2, #3)
// ---------------------------------------------------------------------------

/** A world with one pending request over `payload`, and its dispatch setup. */
function glossWorldFor(payload: Record<string, unknown>, runner?: GlossRunner) {
  const world = live(1, false, () => payload);
  const channel = channelFor();
  return { world, channel, setup: setupFor(world, channel, runner) };
}

/** A world with one pending command-shaped request, and its dispatch setup. */
function glossWorld(command: string, runner?: GlossRunner) {
  return glossWorldFor({ command, cwd: "/repo" }, runner);
}

/** The file-change payload the APRV-164 cases gloss: an `Edit` on a live file. */
function editPayload(): Record<string, unknown> {
  return {
    tool: "Edit",
    file: "src/cli/gloss.ts",
    before: "export const GLOSS_MAX_CHARS = 200;",
    after: "export const GLOSS_MAX_CHARS = 400;",
  };
}

test("a gloss the runner answers is rendered, labelled model-authored", async () => {
  const asked: string[] = [];
  const { world, channel, setup } = glossWorld("rm -rf build && npm ci", (prompt) => {
    asked.push(prompt);
    return "Removes the build directory and reinstalls dependencies from the lockfile.\n";
  });

  const before = mock.sentTexts().length;
  const result = await dispatchPending(setup, capture().streams, newDispatchState(), at(2));
  assert.equal(result.delivered.length, 1, JSON.stringify(result));
  const whole = mock.sentTexts().slice(before).join("\n");

  // The command reached the model as data inside the instruction, and the
  // sentence came back onto the prompt with the label on the line itself.
  assert.equal(asked.length, 1);
  assert.match(asked[0] ?? "", /rm -rf build && npm ci/u);
  assert.match(
    whole,
    /<b>gloss:<\/b> Removes the build directory and reinstalls dependencies from the lockfile\. \(model, unverified\) <i>\(model:haiku\)<\/i>/u,
  );

  // CLAIMED, never computed: a model is not a derivation.
  const rendered = channel.lastRendered()[0];
  assert.equal(rendered?.fields.find((field) => field.field === "gloss")?.kind, "claimed");
  // And it sits in the claimed block, below every computed line.
  assert.ok(whole.indexOf("CLAIMED") < whole.indexOf("<b>gloss:</b>"), whole);
  assertClean(world.unit);
});

test("every way of getting no gloss renders the prompt without one", async () => {
  const runners: Record<string, GlossRunner> = {
    "a timeout, or any other silence": () => null,
    "an empty answer": () => "",
    "whitespace only": () => "   \n  ",
    "a subprocess that throws": () => {
      throw new Error("spawn claude ENOENT");
    },
  };

  for (const [why, runner] of Object.entries(runners)) {
    const { world, channel, setup } = glossWorld("git status", runner);
    const before = mock.sentTexts().length;
    const result = await dispatchPending(setup, capture().streams, newDispatchState(), at(2));
    assert.equal(result.delivered.length, 1, `${why}: the prompt was not delivered`);
    assert.doesNotMatch(mock.sentTexts().slice(before).join("\n"), /<b>gloss:<\/b>/u, why);
    assert.equal(
      channel.lastRendered()[0]?.fields.find((field) => field.field === "gloss"),
      undefined,
      why,
    );
    assertClean(world.unit);
  }
});

test("no runner at all is the default, and spawns nothing", async () => {
  // Every caller that is not the listener verb gets no gloss, so nothing in
  // this suite — or in any programmatic driver — depends on a model binary.
  const { world, channel, setup } = glossWorld("git status");
  assert.equal(setup.gloss, undefined);
  const before = mock.sentTexts().length;
  await dispatchPending(setup, capture().streams, newDispatchState(), at(2));
  assert.doesNotMatch(mock.sentTexts().slice(before).join("\n"), /<b>gloss:<\/b>/u);
  assert.equal(
    channel.lastRendered()[0]?.fields.find((field) => field.field === "gloss"),
    undefined,
  );
  assertClean(world.unit);
});

test("the listener verb asks for a gloss by default; --no-gloss is how you stop it", () => {
  // APRV-197. The decision, pinned where it is made. The phone is the surface
  // the gloss was asked for and a dispatch cycle blocks nobody, so this verb
  // defaults ON — the opposite of `channel cli`, where a person is waiting at
  // the prompt and the flag is `--gloss`. `dispatchPending` itself still
  // defaults to no runner (the test above), which is what keeps a model out of
  // every programmatic driver; the flag decides only for the VERB.
  const wiring = (argv: string[]) => {
    const parsed = parseFlags(argv, { "--gloss": "boolean", "--no-gloss": "boolean" });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (!parsed.ok) throw new Error("unreachable");
    return glossWiring(parsed.flags);
  };

  assert.equal(typeof wiring([]).gloss, "function", "the listener must gloss by default");
  assert.equal(typeof wiring(["--gloss"]).gloss, "function", "--gloss restates the default");
  assert.equal("gloss" in wiring(["--no-gloss"]), false, "--no-gloss removes the key entirely");
  // The flag that takes a language model OUT of the path never loses a tie.
  assert.equal("gloss" in wiring(["--gloss", "--no-gloss"]), false);
});

test("an opaque payload is never sent to a model at all (APRV-164 #3)", async () => {
  // A shape no view recognises is rendered as canonical JSON and nothing else,
  // so there is no material to describe that the approver is not already
  // reading verbatim.
  let calls = 0;
  const { world, channel, setup } = glossWorldFor({ ledger: "ap", entries: 3 }, () => {
    calls += 1;
    return "should never be asked";
  });

  const before = mock.sentTexts().length;
  await dispatchPending(setup, capture().streams, newDispatchState(), at(2));
  assert.equal(calls, 0, "an opaque payload was sent to a model");
  assert.doesNotMatch(mock.sentTexts().slice(before).join("\n"), /<b>gloss:<\/b>/u);
  assert.equal(
    channel.lastRendered()[0]?.fields.find((field) => field.field === "gloss"),
    undefined,
  );
  assertClean(world.unit);
});

test("a file change is glossed from the file-edit instruction (APRV-164 #1)", async () => {
  const asked: string[] = [];
  const { world, channel, setup } = glossWorldFor(editPayload(), (prompt) => {
    asked.push(prompt);
    return "Doubles the cap on how many characters a gloss may occupy.\n";
  });

  const before = mock.sentTexts().length;
  const result = await dispatchPending(setup, capture().streams, newDispatchState(), at(2));
  assert.equal(result.delivered.length, 1, JSON.stringify(result));
  const whole = mock.sentTexts().slice(before).join("\n");

  // The edit instruction, and the path plus both sides of the change as data
  // beneath it. Nothing about the command wording reaches a diff.
  assert.equal(asked.length, 1);
  const prompt = asked[0] ?? "";
  assert.ok(prompt.startsWith(GLOSS_EDIT_INSTRUCTION), prompt);
  assert.equal(prompt.includes(GLOSS_INSTRUCTION), false, "the command instruction leaked");
  assert.match(prompt, /file: src\/cli\/gloss\.ts/u);
  assert.match(prompt, /export const GLOSS_MAX_CHARS = 200;/u);
  assert.match(prompt, /export const GLOSS_MAX_CHARS = 400;/u);
  assert.equal(prompt.includes(GLOSS_TRUNCATION_NOTE), false, "a short edit was marked truncated");

  assert.match(
    whole,
    /<b>gloss:<\/b> Doubles the cap on how many characters a gloss may occupy\. \(model, unverified\) <i>\(model:haiku\)<\/i>/u,
  );
  assert.equal(
    channel.lastRendered()[0]?.fields.find((field) => field.field === "gloss")?.kind,
    "claimed",
  );
  assertClean(world.unit);
});

test("an email is glossed from the email instruction (APRV-164 #2)", async () => {
  const asked: string[] = [];
  const { world, channel, setup } = glossWorldFor(payloadFor(0), (prompt) => {
    asked.push(prompt);
    return "Chases an overdue invoice with a vendor contact.\n";
  });

  const before = mock.sentTexts().length;
  const result = await dispatchPending(setup, capture().streams, newDispatchState(), at(2));
  assert.equal(result.delivered.length, 1, JSON.stringify(result));
  const whole = mock.sentTexts().slice(before).join("\n");

  assert.equal(asked.length, 1);
  const prompt = asked[0] ?? "";
  assert.ok(prompt.startsWith(GLOSS_EMAIL_INSTRUCTION), prompt);
  // The recipient and the body reached the model as the field view has them.
  assert.match(prompt, /to: ap-0@vendor\.example/u);
  assert.match(prompt, /Following up on invoice 41/u);

  assert.match(
    whole,
    /<b>gloss:<\/b> Chases an overdue invoice with a vendor contact\. \(model, unverified\) <i>\(model:haiku\)<\/i>/u,
  );
  assert.equal(
    channel.lastRendered()[0]?.fields.find((field) => field.field === "gloss")?.kind,
    "claimed",
  );
  assertClean(world.unit);
});

test("a whole-file write reaches the model capped and marked (APRV-164 #4)", async () => {
  const content = "x".repeat(GLOSS_MAX_INPUT_CHARS * 3);
  const asked: string[] = [];
  const { world, setup } = glossWorldFor(
    { tool: "Write", file: "notes.txt", content },
    (prompt) => {
      asked.push(prompt);
      return "Writes a file of repeated placeholder text.";
    },
  );

  await dispatchPending(setup, capture().streams, newDispatchState(), at(2));
  assert.equal(asked.length, 1);
  const prompt = asked[0] ?? "";
  // The cap is on the material, announced where the model will read it, and
  // the whole file never became an argv.
  assert.ok(prompt.includes(GLOSS_TRUNCATION_NOTE), "the cap was not announced to the model");
  assert.ok(prompt.length < content.length, "the whole file reached the subprocess");
  assert.equal(
    prompt.length,
    GLOSS_EDIT_INSTRUCTION.length + GLOSS_TRUNCATION_NOTE.length + GLOSS_MAX_INPUT_CHARS + 4,
  );
  assertClean(world.unit);
});

test("every way of getting no gloss holds for the new kinds too (APRV-164 #5)", async () => {
  const runners: Record<string, GlossRunner> = {
    "a timeout, or any other silence": () => null,
    "an empty answer": () => "",
    "whitespace only": () => "   \n  ",
    "an answer no prompt could hold": () => "x".repeat(GLOSS_MAX_CHARS * 100),
    "a subprocess that throws": () => {
      throw new Error("spawn claude ENOENT");
    },
  };
  const payloads: Record<string, Record<string, unknown>> = {
    "a file change": editPayload(),
    "an email": payloadFor(0),
  };

  for (const [kind, payload] of Object.entries(payloads)) {
    for (const [why, runner] of Object.entries(runners)) {
      const { world, channel, setup } = glossWorldFor(payload, runner);
      const before = mock.sentTexts().length;
      const result = await dispatchPending(setup, capture().streams, newDispatchState(), at(2));
      assert.equal(result.delivered.length, 1, `${kind}, ${why}: the prompt was not delivered`);
      const whole = mock.sentTexts().slice(before).join("\n");
      const rendered = channel.lastRendered()[0]?.fields.find((field) => field.field === "gloss");
      if (why === "an answer no prompt could hold") {
        // An oversized answer is capped rather than dropped: the same
        // {@link GLOSS_MAX_CHARS} bound every gloss has had, marked where it
        // bit. It is the one failure mode that still renders a line.
        assert.equal(rendered?.kind, "claimed", `${kind}, ${why}`);
        assert.ok(
          (rendered?.text ?? "").startsWith(`${"x".repeat(GLOSS_MAX_CHARS - 1)}…`),
          `${kind}, ${why}: the answer was not capped`,
        );
      } else {
        assert.doesNotMatch(whole, /<b>gloss:<\/b>/u, `${kind}, ${why}`);
        assert.equal(rendered, undefined, `${kind}, ${why}`);
      }
      assertClean(world.unit);
    }
  }
});

test("the gloss reaches no log line, no payload hash and no decision record", async () => {
  // APRV-144 #3. The sentence is deliberately distinctive so a substring scan
  // over every byte of the log is a real check rather than a formality.
  const marker = "GLOSSMARKERc0ffee";
  const { world, channel, setup } = glossWorld("git status", () => `${marker} does a thing.`);

  const hashBefore = queueOf(world, at(2))[0]?.payload_hash.value;
  await dispatchPending(setup, capture().streams, newDispatchState(), at(2));

  // Decide it through the real gate, so the check covers the decision record
  // and the execution lifecycle too, not only the request.
  const key = world.keys[0] as string;
  const nonce = mock.callbackDataFor(key, "grant");
  mock.queueUpdate(callbackUpdate({ data: nonce, chatId: CHAT }));
  channel.onDecision(handlerFor(world, at(3)));
  const poll = await channel.pollOnce();
  assert.equal(poll.outcomes.length, 1, JSON.stringify(poll));

  const raw = readFileSync(world.unit.logPath, "utf8");
  assert.equal(raw.includes(marker), false, "the gloss reached the append-only log");
  assert.equal(raw.includes("gloss"), false, "the log learned the word");

  // The binding is over the payload bytes and nothing else, so it is the same
  // hash it was before a model was ever consulted.
  assert.equal(queueOf(world, at(2)).length, 0, "the request is decided");
  assert.equal(
    hashBefore,
    payloadHash({ command: "git status", cwd: "/repo" }),
    "the payload hash moved",
  );
  assertClean(world.unit);
});

test("a gloss is untrusted text: escaped, single-lined and capped", () => {
  // `tidyGloss` is where the shape is enforced; the channel's own `escapeHtml`
  // is where the markup is, and the rendering test below proves both.
  assert.equal(tidyGloss("  a\nb\tc  "), "a b c");
  assert.equal(tidyGloss(""), null);
  assert.equal(tidyGloss(null), null);
  const long = tidyGloss("x".repeat(GLOSS_MAX_CHARS * 2));
  assert.ok(long !== null);
  assert.equal(long.length, GLOSS_MAX_CHARS);
  assert.ok(long.endsWith("…"));
  // The runner is asked once, with the command inside the prompt.
  assert.equal(
    glossFor(GLOSS_INSTRUCTION, "", () => "never asked"),
    null,
    "empty material asks nothing",
  );
  assert.equal(GLOSS_AUTHOR, "model:haiku");
});

test("the material is capped before the subprocess, and the cap is announced", () => {
  // The command prompt is byte for byte what APRV-144 sent, and the cap is on
  // the input alone: `GLOSS_MAX_CHARS` still bounds what comes back.
  assert.equal(glossPrompt(GLOSS_INSTRUCTION, "git status"), `${GLOSS_INSTRUCTION}\n\ngit status`);
  const capped = glossPrompt(GLOSS_EDIT_INSTRUCTION, "y".repeat(GLOSS_MAX_INPUT_CHARS + 1));
  assert.ok(capped.includes(GLOSS_TRUNCATION_NOTE));
  assert.equal(
    capped.length,
    GLOSS_EDIT_INSTRUCTION.length + GLOSS_TRUNCATION_NOTE.length + GLOSS_MAX_INPUT_CHARS + 4,
  );
  // Exactly at the cap is not truncation, and is not announced as one.
  assert.equal(
    glossPrompt(GLOSS_EMAIL_INSTRUCTION, "y".repeat(GLOSS_MAX_INPUT_CHARS)).includes(
      GLOSS_TRUNCATION_NOTE,
    ),
    false,
  );
});

test("markup in a gloss reaches the chat as text, never as markup", async () => {
  const { world, channel, setup } = glossWorld(
    "git status",
    () => "Runs <b>git status</b> & shows the tree.",
  );
  const before = mock.sentTexts().length;
  await dispatchPending(setup, capture().streams, newDispatchState(), at(2));
  const whole = mock.sentTexts().slice(before).join("\n");

  assert.ok(whole.includes("Runs &lt;b&gt;git status&lt;/b&gt; &amp; shows the tree."), whole);
  assert.equal(whole.includes("<b>git status</b>"), false, "raw markup reached the message");
  assert.equal(
    channel.lastRendered()[0]?.fields.find((field) => field.field === "gloss")?.kind,
    "claimed",
  );
  assertClean(world.unit);
});

// ---------------------------------------------------------------------------
// The bookkeeping is swept (APRV-135)
// ---------------------------------------------------------------------------

/** A one-hour TTL, matching the fixture policy, in milliseconds. */
const TTL_MS = 60 * 60 * 1000;

/** A channel whose clock is a variable this test moves by hand. */
function sweepChannel(clock: { ms: number }, ttlMs: number | null = TTL_MS): TelegramChannel {
  return channelFor({ approvalTtlMs: ttlMs, now: () => clock.ms });
}

test("a settled-and-lapsed delivery is swept; a live one is not (APRV-135 #1)", async () => {
  const clock = { ms: 1_000_000 };
  const world = live(2);
  const channel = sweepChannel(clock);
  channel.onDecision(handlerFor(world, at(3)));
  const requests = queueOf(world, at(3));

  await channel.notify(requests[0] as ChannelRequest);
  assert.equal(channel.bookkeepingSize().deliveries, 1);

  // Nothing is swept before the window: the request is still answerable, and
  // forgetting its button would take a live decision away from an approver.
  clock.ms += TTL_MS - 1;
  assert.deepEqual(channel.sweep(), { deliveries: 0, digests: 0 });
  assert.equal(channel.bookkeepingSize().deliveries, 1);

  // Past the TTL the gate refuses every decision on it, so the entry can go.
  clock.ms += 1;
  assert.deepEqual(channel.sweep(), { deliveries: 1, digests: 0 });
  assert.equal(channel.bookkeepingSize().deliveries, 0);

  // A delivery sent just now survives the same sweep: age is per entry.
  await channel.notify(requests[1] as ChannelRequest);
  assert.deepEqual(channel.sweep(), { deliveries: 0, digests: 0 });
  assert.equal(channel.bookkeepingSize().deliveries, 1);
});

test("a callback for a swept delivery takes the stale-callback path (APRV-135 #1)", async () => {
  const clock = { ms: 2_000_000 };
  const world = live(1);
  const channel = sweepChannel(clock);
  channel.onDecision(handlerFor(world, at(3)));
  const request_ = queueOf(world, at(3))[0] as ChannelRequest;
  const key = request_.action_key.value;

  await channel.notify(request_);
  const before = channel.anomalyCount("stale-copy");
  const events = recordsOf(world.unit.logPath).length;

  clock.ms += TTL_MS;
  assert.equal(channel.sweep().deliveries, 1);

  // The tap arrives anyway — a message scrolled back to, a button the sweep
  // could not remove — and is answered exactly as a restarted listener's own
  // forgotten button is: counted, toasted, never carried to the gate.
  const outcome = await press(channel, key, "grant");
  assert.equal(outcome, undefined, "a swept delivery produced a decision");
  assert.equal(channel.anomalyCount("stale-copy"), before + 1);
  assert.equal(recordsOf(world.unit.logPath).length, events, "the log grew on a swept callback");
});

test("a digest is swept once every member is settled and the window has passed", async () => {
  const clock = { ms: 3_000_000 };
  const world = live(3);
  const channel = sweepChannel(clock);
  channel.onDecision(handlerFor(world, at(3)));
  const requests = queueOf(world, at(3));

  const delivered = await channel.notifyBatch({ requests });
  assert.notEqual(delivered.digestId, null, "the fixture did not produce a digest");
  assert.equal(channel.bookkeepingSize().digests, 1);
  assert.equal(channel.bookkeepingSize().allNonces, 1);

  // Every member decided, but inside the window: the digest stays, because an
  // approver may still tap a button on a message they scrolled back to and the
  // reply they get should come from this process rather than from nothing.
  for (const request_ of requests) {
    await press(channel, request_.action_key.value, "grant");
  }
  clock.ms += TTL_MS - 1;
  assert.equal(channel.sweep().digests, 0, "a digest inside its window was forgotten");
  assert.equal(channel.bookkeepingSize().digests, 1);

  // Past it, both halves hold and the whole entry goes — the digest, its "all"
  // nonce, and every member nonce that was issued under it.
  clock.ms += 1;
  assert.equal(channel.sweep().digests, 1);
  assert.deepEqual(channel.bookkeepingSize(), { deliveries: 0, digests: 0, allNonces: 0 });
});

test("with no approval TTL only settled entries are forgotten (APRV-135)", async () => {
  const clock = { ms: 4_000_000 };
  const world = live(4);
  const channel = sweepChannel(clock, null);
  channel.onDecision(handlerFor(world, at(3)));
  const requests = queueOf(world, at(3));

  await channel.notify(requests[0] as ChannelRequest);
  const digest = await channel.notifyBatch({ requests: requests.slice(1) });
  assert.notEqual(digest.digestId, null, "the fixture did not produce a digest");

  // A policy that bounds nothing leaves both answerable forever, so neither is
  // forgotten however old it gets: this is the case where "every member is
  // terminal" is the whole condition rather than a consequence of the TTL.
  clock.ms += TELEGRAM_DEFAULT_RETENTION_MS * 10;
  assert.deepEqual(channel.sweep(), { deliveries: 0, digests: 0 });
  // One unit delivery plus a nonce per digest member, all still armed.
  assert.equal(channel.bookkeepingSize().deliveries, 4);
  assert.equal(channel.bookkeepingSize().digests, 1);

  // Settle the digest's members and it becomes droppable; the undecided unit
  // delivery beside it stays, because nothing has made it terminal.
  for (const request_ of requests.slice(1)) {
    await press(channel, request_.action_key.value, "grant");
  }
  clock.ms += TELEGRAM_DEFAULT_RETENTION_MS;
  assert.deepEqual(channel.sweep(), { deliveries: 0, digests: 1 });
  assert.equal(channel.bookkeepingSize().deliveries, 1, "a live request lost its button");
});

test("memory does not grow across a long run of decided prompts (APRV-135 #2)", async () => {
  const clock = { ms: 5_000_000 };
  const rounds = 60;
  const world = live(rounds, false, payloadFor, POLICY_LONG_RUN);
  const channel = sweepChannel(clock);
  channel.onDecision(handlerFor(world, at(3)));
  const requests = queueOf(world, at(3));

  // A week of prompts, one every ten minutes, each decided where it was shown.
  // The assertion is a CEILING, not an exact size: what must not happen is a
  // map proportional to every prompt the listener ever sent.
  let peak = 0;
  for (const request_ of requests) {
    clock.ms += 10 * 60 * 1000;
    await channel.notify(request_);
    const outcome = await press(channel, request_.action_key.value, "grant");
    assert.ok(outcome?.ok, `grant refused: ${JSON.stringify(outcome)}`);
    channel.sweep();
    const size = channel.bookkeepingSize();
    peak = Math.max(peak, size.deliveries + size.digests + size.allNonces);
  }

  assert.ok(peak <= 4, `the bookkeeping grew with the run (peak ${peak} entries over ${rounds})`);
  // And at rest, once the last window has passed, it is empty.
  clock.ms += TTL_MS;
  channel.sweep();
  assert.deepEqual(channel.bookkeepingSize(), { deliveries: 0, digests: 0, allNonces: 0 });
  assert.equal(
    recordsOf(world.unit.logPath).filter((record) => record.event === "approval.granted").length,
    rounds,
    "the sweep cost the log a decision",
  );
});

// ---------------------------------------------------------------------------
// Callback acks and duplicate suppression (APRV-196)
//
// The incident these pin: a listener died with five pending requests, the
// restart re-sent all five with no warning, and only the newest copy's buttons
// resolved — taps on the older copies were swallowed, so the approver kept
// tapping a button that never answered. Three properties close it, and each has
// a test here: every tap is acked, a tap on any copy decides the request, and a
// re-delivery says what it is.
// ---------------------------------------------------------------------------

/** Every `answerCallbackQuery` text the mock has seen since `from`. */
function answersSince(from: number): string[] {
  return mock.answerTexts().slice(from);
}

test("every callback query is acked exactly once, on every path (APRV-196)", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const request_ = queueOf(world, at(2))[0] as ChannelRequest;
  const channel = channelFor();
  channel.onDecision(handlerFor(world, at(2)));
  await channel.notify(request_);
  const live_ = mock.callbackDataFor(key, "grant");

  /** Feed one callback, and report every ack it produced. */
  const tap = async (data: string, chatId = CHAT): Promise<string[]> => {
    const from = mock.answerTexts().length;
    mock.queueUpdate(callbackUpdate({ data, chatId }));
    await channel.pollOnce();
    return answersSince(from);
  };

  // A stranger's chat, bytes that are not ours, and a nonce with no reference:
  // three refusals, three toasts, no decision between them.
  assert.equal((await tap(live_, OTHER_CHAT)).length, 1, "a foreign-chat tap went unanswered");
  assert.equal((await tap("not-a-callback")).length, 1, "a malformed tap went unanswered");
  assert.equal((await tap("g:nosuchnonce")).length, 1, "an unplaceable tap went unanswered");

  // A reference for an action nothing here is holding open: acked, and with a
  // sentence about the request rather than about the button.
  const stale = await tap(`g:nosuchnonce:${actionRefOf("task-999:elsewhere")}`);
  assert.deepEqual(stale, [TELEGRAM_STALE_UNKNOWN]);

  // And the accepted decision, which is the one path that was never in doubt.
  // Since APRV-206 its one answer is the early ack — sent before the gate ran,
  // so it says the tap arrived and claims nothing about the log. What the log
  // recorded is in the message edit, asserted by the APRV-113 cases and by
  // tests/telegram-tap-latency.test.ts.
  const accepted = await tap(live_);
  assert.deepEqual(accepted, [TELEGRAM_ACK_HEARD]);

  // The second tap on the same button — Telegram redelivers on its own — is
  // acked too, and appends nothing.
  const events = recordsOf(world.unit.logPath).length;
  assert.deepEqual(await tap(live_), [TELEGRAM_STALE_UNKNOWN]);
  assert.equal(recordsOf(world.unit.logPath).length, events, "a re-tap appended an event");
  assertClean(world.unit);
});

test("a tap on a pre-restart copy decides the request the new listener holds (APRV-196)", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const request_ = queueOf(world, at(2))[0] as ChannelRequest;

  // The listener that died, and the copy it left on the approver's phone.
  const before = channelFor();
  before.onDecision(handlerFor(world, at(2)));
  await before.notify(request_);
  const oldButton = mock.callbackDataFor(key, "grant");

  // Its replacement: same log, same still-pending request, a new process with
  // new nonces. This is the restart, in the only form a restart has.
  const after = channelFor();
  after.onDecision(handlerFor(world, at(3)));
  await after.notify(request_);
  const newButton = mock.callbackDataFor(key, "grant");

  assert.notEqual(oldButton, newButton, "two copies must not share a nonce");
  assert.equal(
    oldButton.split(":")[2],
    newButton.split(":")[2],
    "two copies of one request must carry the same action reference",
  );

  // The human taps the copy they can see, which is the older one.
  const from = mock.answerTexts().length;
  mock.queueUpdate(callbackUpdate({ data: oldButton, chatId: CHAT }));
  const poll = await after.pollOnce();

  assert.deepEqual(poll.ignored, [], "the older copy's tap was refused");
  const outcome = poll.outcomes.find((entry) => entry.action_key === key)?.outcome;
  assert.equal(outcome?.ok, true, `the older copy did not decide: ${JSON.stringify(outcome)}`);
  assert.equal(after.stats().staleCopyDecisions, 1);

  // Acked, once, and told which copy answered.
  const toast = answersSince(from);
  assert.equal(toast.length, 1);
  assert.ok(
    (toast[0] as string).startsWith(TELEGRAM_STALE_COPY_PREFIX),
    `the toast did not name the earlier copy: ${String(toast[0])}`,
  );

  // One event, not two: the gate decided it once, through the ordinary path.
  assert.equal(
    recordsOf(world.unit.logPath).filter((record) => record.event === "approval.granted").length,
    1,
  );
  assertClean(world.unit);
});

test("a tap on a copy of a settled request is told what the log says (APRV-196)", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const request_ = queueOf(world, at(2))[0] as ChannelRequest;

  // The probe the listener wires: it reads the VERIFIED log and nothing else.
  const channel = channelFor({ describeAction: describeActionFor(world.unit.logPath) });
  channel.onDecision(handlerFor(world, at(2)));
  await channel.notify(request_);
  const button = mock.callbackDataFor(key, "grant");

  const first = await press(channel, key, "grant");
  assert.equal(first?.ok, true, JSON.stringify(first));

  const from = mock.answerTexts().length;
  mock.queueUpdate(callbackUpdate({ data: button, chatId: CHAT }));
  const poll = await channel.pollOnce();
  assert.deepEqual(poll.ignored.map((entry) => entry.kind), ["stale-copy"]);
  assert.deepEqual(answersSince(from), [
    "Already granted — the recorded answer stands, and nothing was recorded for this tap.",
  ]);

  // A reference the log has never carried is answered `null`, which is the
  // channel's own "not open here" line — never an invented outcome.
  assert.equal(describeActionFor(world.unit.logPath)(actionRefOf("task-999:nope")), null);
  assertClean(world.unit);
});

test("an ack the Bot API refuses costs the decision nothing (APRV-196)", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const request_ = queueOf(world, at(2))[0] as ChannelRequest;

  // Telegram drops a callback query after its own window, so a late tap's ack
  // fails while everything around it works. The tap must still decide, and the
  // poll loop must not be pushed into backoff by a failed courtesy.
  const passthrough = globalThis.fetch as unknown as NonNullable<TelegramConfig["fetch"]>;
  const channel = channelFor({
    fetch: async (url, init) => {
      if (url.endsWith("/answerCallbackQuery")) {
        return { ok: false, status: 400, text: async () => "Bad Request: query is too old" };
      }
      return await passthrough(url, init);
    },
  });
  channel.onDecision(handlerFor(world, at(2)));
  await channel.notify(request_);

  const outcome = await press(channel, key, "grant");
  assert.equal(outcome?.ok, true, `a failed toast cost the decision: ${JSON.stringify(outcome)}`);
  assert.equal(
    recordsOf(world.unit.logPath).filter((record) => record.event === "approval.granted").length,
    1,
  );
  assert.ok(
    complaints.some((entry) => entry.includes("could not answer a callback")),
    "a failed ack was not reported to the operator",
  );
  assertClean(world.unit);
});

test("a startup batch is preceded by one banner naming how many are coming (APRV-196)", async () => {
  const world = staged(3);
  const channel = channelFor();
  const setup = setupFor(world, channel);
  const state = newDispatchState();
  const keys = [0, 1, 2].map((index) => requestAt(world, index, at(1)));

  const from = mock.sentTexts().length;
  const first = await dispatchPending(setup, capture().streams, state, at(2));
  assert.equal(first.banner?.pending, 3, JSON.stringify(first.banner));

  const sent = mock.sentTexts().slice(from);
  const banner = sent.findIndex((text) => text.includes("LISTENER STARTED"));
  assert.equal(banner, 0, "the banner did not come first");
  assert.equal(
    sent.filter((text) => text.includes("LISTENER STARTED")).length,
    1,
    "more than one banner for one batch",
  );
  assert.match(sent[0] as string, /re-sending 3 pending requests/u);
  for (const key of keys) {
    assert.ok(!(sent[0] as string).includes(key), "the banner named an action key");
  }

  // A request appended later is a notification, not a flood: no second banner.
  const laterFrom = mock.sentTexts().length;
  const fourth = staged(1);
  const key4 = requestAt(fourth, 0, at(3));
  const later = await dispatchPending(
    { ...setup, logPath: fourth.unit.logPath, tagOptions: fourth.tagOptions },
    capture().streams,
    state,
    at(4),
  );
  assert.equal(later.banner, undefined, "a steady-state cycle sent a banner");
  assert.ok(
    mock
      .sentTexts()
      .slice(laterFrom)
      .some((text) => text.includes(key4)),
    "the later request was not delivered",
  );

  // The wording is honest about what a listener can know: it says STARTED,
  // because nothing here can tell a restart from a first start.
  assert.deepEqual(bannerLines(1)[0], "LISTENER STARTED — re-sending 1 pending request.");
  assertClean(world.unit);
});

test("the listener's delivery bookkeeping is pruned, on settlement and on age (APRV-196)", async () => {
  const world = staged(2);
  const channel = channelFor();
  const setup = setupFor(world, channel);
  const state = newDispatchState();
  const [first, second] = [0, 1].map((index) => requestAt(world, index, at(1)));
  assert.ok(first !== undefined && second !== undefined);

  const opened = await dispatchPending(setup, capture().streams, state, at(2));
  assert.equal(opened.delivered.length, 2);
  assert.equal(state.delivered.size, 2);
  assert.equal(state.sentAtMs.size, 2);

  // One is answered at another surface entirely. The next cycle annotates its
  // message and then forgets it: the log will never call it pending again, so
  // nothing can ask for the entry.
  const granted = recordChannelDecision(
    world.unit.logPath,
    { action_key: first, decision: "grant", deliveryId: "cli" },
    { actor: HUMAN, channel: "cli" },
    { ...world.unit.options, clock: fixedClock(at(3)) },
  );
  assert.equal(granted.outcome.ok, true, JSON.stringify(granted.outcome));

  const settled = await dispatchPending(setup, capture().streams, state, at(4));
  assert.deepEqual(settled.pruned, [{ action_key: first, reason: "settled" }]);
  assert.equal(state.delivered.has(first), false);
  assert.equal(state.annotated.has(first), false);
  assert.equal(state.sentAtMs.has(first), false);
  assert.equal(state.delivered.has(second), true, "a pending request was pruned");

  // The other simply lapses: no event says so, so nothing is annotated, and
  // the entry would once have been held for the life of the process. Past the
  // retention window, with the log no longer calling it pending, it goes.
  assert.equal(DISPATCH_RETENTION_MS, 24 * 60 * 60 * 1000);
  const aged = await dispatchPending(setup, capture().streams, state, at(1444));
  assert.deepEqual(aged.pruned, [{ action_key: second, reason: "stale" }]);
  assert.equal(state.delivered.size, 0);
  assert.equal(state.sentAtMs.size, 0);
  assert.deepEqual(aged.delivered, [], "a lapsed request was re-sent");
  assertClean(world.unit);
});

test("a handler that throws still answers the tap, and the loop survives (APRV-196)", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const request_ = queueOf(world, at(2))[0] as ChannelRequest;
  const channel = channelFor();

  // The branch nobody writes on purpose: something inside the decision path
  // throws. The tap must still be answered — a spinning button is what sent the
  // approver back to tap again — and `pollOnce` must not propagate, because a
  // throw there puts `listen` into backoff and costs the rest of the batch.
  channel.onDecision(() => {
    throw new Error("the handler fell over");
  });
  await channel.notify(request_);

  const events = recordsOf(world.unit.logPath).length;
  const from = mock.answerTexts().length;
  mock.queueUpdate(
    callbackUpdate({ data: mock.callbackDataFor(key, "grant"), chatId: CHAT }),
  );
  const poll = await channel.pollOnce();

  assert.deepEqual(poll.outcomes, [], "a thrown handler produced an outcome");
  // APRV-206: exactly one answer, still — but it is now the early ack, which
  // went out before the handler was called. The fallback toast the wrapper used
  // to send is a no-op behind it, so the sentence the approver would have got
  // from it is put on the message instead.
  assert.deepEqual(answersSince(from), [TELEGRAM_ACK_HEARD], "the tap went unanswered");
  const failed = mock.edits().at(-1);
  assert.match(String(failed?.text), new RegExp(TELEGRAM_NOT_RECORDED, "u"));
  assert.ok(
    String(failed?.text).includes(TELEGRAM_HANDLER_FAILED.split("`")[0] as string),
    `the failure was not put on the message: ${String(failed?.text)}`,
  );
  assert.ok(
    complaints.some((entry) => entry.includes("failed while handling a callback")),
    "a thrown handler was not reported to the operator",
  );
  assert.equal(recordsOf(world.unit.logPath).length, events, "a thrown handler appended");
  assertClean(world.unit);
});

test("a throw BEFORE any ack still falls back to the wrapper's toast (APRV-196)", async () => {
  // The other side of APRV-206's early ack: it is sent once the tap has been
  // resolved to a live delivery, so a branch that throws before that point has
  // still answered nothing. The wrapper's fallback is what covers it, and this
  // is the case that keeps it exercised — `describeAction` is the listener's
  // verified-log probe, and a log it cannot read is a real way for it to throw.
  const world = live(1);
  const channel = channelFor({
    describeAction: () => {
      throw new Error("the probe fell over");
    },
  });
  channel.onDecision(handlerFor(world, at(2)));

  const from = mock.answerTexts().length;
  mock.queueUpdate(
    callbackUpdate({
      data: `g:nosuchnonce:${actionRefOf("task-999:elsewhere")}`,
      chatId: CHAT,
    }),
  );
  await channel.pollOnce();

  assert.deepEqual(answersSince(from), [TELEGRAM_ACK_FALLBACK], "the tap went unanswered");
  assertClean(world.unit);
});

// ---------------------------------------------------------------------------
// Paced delivery: one question at a time (APRV-216)
// ---------------------------------------------------------------------------

/**
 * The default mode since APRV-216. A listener start no longer empties the
 * pending set onto a phone: it sends one summary line and the oldest request,
 * and the next one only once that one is decided, skipped or passed over.
 *
 * Two properties are load-bearing under every case below, and both are SPEC.md
 * §10.3's "channels hold no truth" rather than anything about pacing:
 *
 * - pending-ness is re-derived from the verified log on every cycle, so a
 *   decision made anywhere (a button, the terminal channel, a withdrawal, the
 *   daemon's expiry) advances the walkthrough;
 * - the order and the shown item are process memory, so losing them costs a
 *   re-send and never a request nobody is shown.
 *
 * The commands append nothing, and these cases prove it the only way worth
 * proving it: by counting the records in the log before and after.
 */

/** How many records the log holds, read through the verifying path. */
function recordCount(world: Live): number {
  const read = readVerifiedRecords(world.unit.logPath);
  assert.equal(read.ok, true, "the log did not verify");
  return read.ok ? read.records.length : -1;
}

/** Every message sent since `from`, as text. */
function sentSince(from: number): string[] {
  return mock.sentTexts().slice(from);
}

test("paced delivery opens with one summary and the oldest request alone (APRV-216)", async () => {
  const world = staged(3, distinctPayloadFor);
  const setup = setupFor(world, channelFor(), undefined, "paced");
  const state = newDispatchState();
  const { streams, err } = capture();

  const a = requestAt(world, 0, at(1));
  const b = requestAt(world, 1, at(2));
  const c = requestAt(world, 2, at(3));

  const from = mock.sentTexts().length;
  const cycle = await dispatchPending(setup, streams, state, at(63));

  // "Exactly two messages" in the AC's sense: the summary, and ONE request.
  // A request has been a multi-segment prompt since APRV-100 (header, payload,
  // claimed material), so what is counted here is what reached the approver as
  // a thing to read, not the segments one prompt costs.
  assert.notEqual(cycle.summary, undefined, "no queue summary was sent");
  assert.equal(cycle.summary?.pending, 3);
  assert.equal(cycle.banner, undefined, "a paced cycle sent the burst banner");
  assert.deepEqual(
    cycle.delivered.map((entry) => entry.action_key),
    [a],
    "a paced cycle delivered something other than the oldest request alone",
  );

  const sent = sentSince(from);
  assert.equal(sent[0]?.includes("3 pending"), true, `summary missing the count: ${String(sent[0])}`);
  assert.equal(sent[0]?.includes("communicate.email.external"), true, "summary named no class");
  for (const key of [b, c]) {
    assert.equal(
      sent.filter((text) => text.includes(key)).length,
      0,
      `${key} reached the chat while another request was being shown`,
    );
  }

  // Nothing has been decided, and the two unshown requests are still pending in
  // the log: pacing withholds attention, never the queue.
  const queue = buildPendingQueue(world.unit.logPath, world.tagOptions, at(63));
  assert.equal(queue.ok && queue.requests.length, 3);
  assert.deepEqual(err, [], `unexpected stderr: ${err.join("")}`);
  assertClean(world.unit);
});

test("a decision on the shown request sends the next one on the next cycle (APRV-216)", async () => {
  const world = staged(3, distinctPayloadFor);
  const channel = channelFor();
  const setup = setupFor(world, channel, undefined, "paced");
  const state = newDispatchState();
  const { streams, err } = capture();

  const a = requestAt(world, 0, at(1));
  const b = requestAt(world, 1, at(2));
  requestAt(world, 2, at(3));

  await dispatchPending(setup, streams, state, at(63));

  // A cycle while the question is still open sends nothing at all.
  const quiet = await dispatchPending(setup, streams, state, at(64));
  assert.equal(quiet.delivered.length, 0, "a second request went out under the first");
  assert.equal(quiet.summary, undefined);

  channel.onDecision(handlerFor(world, at(65)));
  const outcome = await press(channel, a, "grant");
  assert.equal(outcome?.ok, true, `grant refused: ${JSON.stringify(outcome)}`);

  const next = await dispatchPending(setup, streams, state, at(66));
  assert.deepEqual(
    next.delivered.map((entry) => entry.action_key),
    [b],
    "the next request did not follow the decision",
  );
  // Two pending now, and the approver was told three: a queue that has only
  // shrunk is not news, so no second summary.
  assert.equal(next.summary, undefined, "a shrinking queue re-announced itself");
  assert.deepEqual(err, [], `unexpected stderr: ${err.join("")}`);
  assertClean(world.unit);
});

test("/skip shows the next request and brings the skipped one round last (APRV-216)", async () => {
  const world = staged(3, distinctPayloadFor);
  const channel = channelFor();
  const setup = setupFor(world, channel, undefined, "paced");
  const state = newDispatchState();
  const { streams, err } = capture();
  const commands = commandHandlerFor(setup, streams, state);

  const a = requestAt(world, 0, at(1));
  const b = requestAt(world, 1, at(2));
  const c = requestAt(world, 2, at(3));

  await dispatchPending(setup, streams, state, at(63));

  const before = recordCount(world);
  await commands("skip");
  assert.equal(recordCount(world), before, "/skip appended to the log");

  const second = await dispatchPending(setup, streams, state, at(64));
  assert.deepEqual(
    second.delivered.map((entry) => entry.action_key),
    [b],
    "/skip did not move on",
  );

  // Decide the two that follow, and the skipped one comes back — last, and as a
  // fresh copy, because a skip is "later" and not "gone".
  channel.onDecision(handlerFor(world, at(65)));
  assert.equal((await press(channel, b, "grant"))?.ok, true);
  const third = await dispatchPending(setup, streams, state, at(66));
  assert.deepEqual(
    third.delivered.map((entry) => entry.action_key),
    [c],
  );

  channel.onDecision(handlerFor(world, at(67)));
  assert.equal((await press(channel, c, "reject"))?.ok, true);
  const roundAgain = await dispatchPending(setup, streams, state, at(68));
  assert.deepEqual(
    roundAgain.delivered.map((entry) => entry.action_key),
    [a],
    "the skipped request never came round again",
  );

  assert.deepEqual(err, [], `unexpected stderr: ${err.join("")}`);
  assertClean(world.unit);
});

test("/next moves past the shown request without showing it again (APRV-216)", async () => {
  const world = staged(2, distinctPayloadFor);
  const channel = channelFor();
  const setup = setupFor(world, channel, undefined, "paced");
  const state = newDispatchState();
  const { streams, err } = capture();
  const commands = commandHandlerFor(setup, streams, state);

  const a = requestAt(world, 0, at(1));
  const b = requestAt(world, 1, at(2));

  await dispatchPending(setup, streams, state, at(63));

  const before = recordCount(world);
  await commands("next");
  assert.equal(recordCount(world), before, "/next appended to the log");

  const second = await dispatchPending(setup, streams, state, at(64));
  assert.deepEqual(
    second.delivered.map((entry) => entry.action_key),
    [b],
    "/next did not move on",
  );

  // A decision on B leaves A pending and already delivered: this process has
  // passed it over, and its live copy is still up the chat.
  channel.onDecision(handlerFor(world, at(65)));
  assert.equal((await press(channel, b, "grant"))?.ok, true);
  const after = await dispatchPending(setup, streams, state, at(66));
  assert.equal(after.delivered.length, 0, "/next re-sent the request it passed over");

  // And the copy it passed over still decides: nothing was withdrawn from the
  // approver, only from this process's order.
  channel.onDecision(handlerFor(world, at(67)));
  assert.equal((await press(channel, a, "grant"))?.ok, true, "the passed-over copy went dead");

  assert.deepEqual(err, [], `unexpected stderr: ${err.join("")}`);
  assertClean(world.unit);
});

test("/queue lists every pending request while one is being shown (APRV-216)", async () => {
  const world = staged(3, distinctPayloadFor);
  const channel = channelFor();
  const setup = setupFor(world, channel, undefined, "paced");
  const state = newDispatchState();
  const { streams, err } = capture();

  const a = requestAt(world, 0, at(1));
  const b = requestAt(world, 1, at(2));
  const c = requestAt(world, 2, at(3));

  await dispatchPending(setup, streams, state, at(63));

  // Through the real wire this time: a Telegram message update, the long-poll
  // loop, and the handler the listener registers.
  channel.onCommand(commandHandlerFor(setup, streams, state, () => at(70)));
  const before = recordCount(world);
  const from = mock.sentTexts().length;
  mock.queueUpdate(messageUpdate({ chatId: CHAT, text: "/queue" }));
  const poll = await channel.pollOnce();

  assert.deepEqual(poll.commands, ["queue"], "the command never reached the runtime");
  assert.equal(recordCount(world), before, "/queue appended to the log");

  const reply = sentSince(from).join("\n");
  assert.equal(reply.includes("3 pending"), true, `no summary in the reply: ${reply}`);
  for (const key of [a, b, c]) {
    assert.equal(reply.includes(key), true, `${key} is pending and absent from /queue`);
  }
  assert.equal(reply.includes(`${a} `), true, "the list is not keyed by action key");
  assert.equal(reply.includes("selected"), true, "/queue did not mark the selected request");

  // APRV-256, over the real wire: the reply an approver actually receives says
  // it has no buttons and how to recover a card they cannot find, and it still
  // appends nothing while saying so (asserted against `before` above).
  assert.equal(reply.includes("no decision buttons"), true, `not self-identified: ${reply}`);
  assert.equal(reply.includes("/skip is the recovery"), true, `no recovery offered: ${reply}`);
  assert.equal(reply.includes("shown now"), false, `the old marker reached the chat: ${reply}`);
  assert.equal(reply.includes("message above"), false, `the old pointer reached the chat: ${reply}`);

  // The queue is derived, not held: a decision changes the next reply with no
  // command and no cycle in between.
  channel.onDecision(handlerFor(world, at(65)));
  assert.equal((await press(channel, a, "grant"))?.ok, true);
  const secondFrom = mock.sentTexts().length;
  mock.queueUpdate(messageUpdate({ chatId: CHAT, text: "/queue" }));
  await channel.pollOnce();
  const secondReply = sentSince(secondFrom).join("\n");
  assert.equal(secondReply.includes("2 pending"), true, `stale count: ${secondReply}`);
  assert.equal(secondReply.includes(a), false, "a decided request is still listed as pending");

  assert.deepEqual(err, [], `unexpected stderr: ${err.join("")}`);
  assertClean(world.unit);
});

/**
 * The marker `/queue` puts on the request the listener has selected, spelled out
 * here rather than imported so that a change to the shipped wording has to be
 * made twice, deliberately (APRV-256).
 */
const SELECTED_LINE_MARKER = " — selected — card sent earlier";

/**
 * APRV-256, at the command level rather than the renderer's. Two states an
 * approver can reach without doing anything wrong — a pending request nothing
 * has selected yet, and an empty queue — and in neither may a reply point at an
 * approval card, since in neither has one been sent.
 */
test("the commands answer a queue with nothing selected without naming a card (APRV-256)", async () => {
  const world = staged(1, distinctPayloadFor);
  const channel = channelFor();
  const setup = setupFor(world, channel, undefined, "paced");
  const state = newDispatchState();
  const { streams, err } = capture();
  const commands = commandHandlerFor(setup, streams, state, () => at(70));

  const only = requestAt(world, 0, at(1));

  // Pending, and NOT yet dispatched: the listener holds no selection.
  const before = recordCount(world);
  const from = mock.sentTexts().length;
  await commands("queue");
  const listing = sentSince(from).join("\n");
  assert.equal(listing.includes("1 pending"), true, `no summary: ${listing}`);
  assert.equal(listing.includes(only), true, "the pending request is not listed");
  assert.equal(listing.includes("no decision buttons"), true, "the reply is not self-identified");
  assert.equal(
    listing.includes("no approval card has been sent for any of these"),
    true,
    `a card was implied with nothing selected: ${listing}`,
  );
  assert.equal(listing.includes(SELECTED_LINE_MARKER), false, "an undelivered request was marked");

  // /skip and /next with no selection: same vocabulary, no card, no decision.
  for (const command of ["skip", "next"] as const) {
    const mark = mock.sentTexts().length;
    await commands(command);
    const reply = sentSince(mark).join("\n");
    assert.equal(
      reply.includes("no request selected"),
      true,
      `${command} did not report the empty selection: ${reply}`,
    );
    assert.equal(
      reply.includes("with its buttons on an upcoming cycle"),
      true,
      `${command} did not say where buttons come from: ${reply}`,
    );
    for (const banned of ["in front of you", "message above", "shown now"]) {
      assert.equal(reply.includes(banned), false, `${command} said ${banned}: ${reply}`);
    }
  }

  // Navigation stayed non-decisional and log-free across all three.
  assert.equal(recordCount(world), before, "a navigation command appended to the log");

  // And an empty queue says only that, with no card, buttons or verbs offered.
  channel.onDecision(handlerFor(world, at(71)));
  await dispatchPending(setup, streams, state, at(72));
  assert.equal((await press(channel, only, "grant"))?.ok, true);
  const emptyFrom = mock.sentTexts().length;
  await commands("queue");
  const empty = sentSince(emptyFrom).join("\n");
  // The announce path bolds the first line, so this is `includes` against a
  // reply whose only content is that line.
  assert.equal(
    empty.includes("Nothing pending — the queue is empty."),
    true,
    `not the empty reply: ${empty}`,
  );
  for (const banned of ["card", "button", "/skip", "/next"]) {
    assert.equal(empty.includes(banned), false, `an empty queue mentioned ${banned}: ${empty}`);
  }

  assert.deepEqual(err, [], `unexpected stderr: ${err.join("")}`);
  assertClean(world.unit);
});

test("a paced restart re-shows the oldest, and the pre-restart copy still decides (APRV-216)", async () => {
  const world = staged(2, distinctPayloadFor);
  const first = channelFor();
  const setup = setupFor(world, first, undefined, "paced");
  const state = newDispatchState();
  const { streams, err } = capture();

  const a = requestAt(world, 0, at(1));
  requestAt(world, 1, at(2));

  await dispatchPending(setup, streams, state, at(63));
  // The copy the first process armed, captured before anything supersedes it.
  const oldCopy = mock.callbackDataFor(a, "grant");

  // The restart: a new channel and a FRESH state, which is the whole of what a
  // crash costs. The pending set is re-derived, so the oldest is shown again.
  const second = channelFor();
  const restarted = setupFor(world, second, undefined, "paced");
  const freshState = newDispatchState();
  const afterRestart = await dispatchPending(restarted, streams, freshState, at(64));
  assert.deepEqual(
    afterRestart.delivered.map((entry) => entry.action_key),
    [a],
    "a restarted paced listener did not re-show the oldest pending request",
  );
  assert.notEqual(afterRestart.summary, undefined, "a restart sent no summary");

  // A tap on the copy from before the restart (APRV-196): resolved by action
  // reference against the delivery this process is holding open, so it decides
  // the request the human meant.
  second.onDecision(handlerFor(world, at(65)));
  mock.queueUpdate(callbackUpdate({ data: oldCopy, chatId: CHAT }));
  const poll = await second.pollOnce();
  assert.equal(poll.outcomes[0]?.outcome.ok, true, `the old copy decided nothing: ${JSON.stringify(poll)}`);

  // And nothing is decided twice. The newest copy's button does not even reach
  // the gate: the decision disarmed the delivery, so the tap takes APRV-196's
  // stale-copy path and is answered rather than recorded.
  const stale = second.anomalyCount("stale-copy");
  const refused = await press(second, a, "grant");
  assert.equal(refused, undefined, "a second decision reached the gate");
  assert.equal(second.anomalyCount("stale-copy"), stale + 1, "the second tap went unanswered");

  const granted = readVerifiedRecords(world.unit.logPath);
  assert.equal(granted.ok, true);
  assert.equal(
    granted.ok
      ? granted.records.filter(
          (record) => record.event === "approval.granted" && record.action_key === a,
        ).length
      : -1,
    1,
    "more than one grant landed for one request",
  );

  assert.deepEqual(err, [], `unexpected stderr: ${err.join("")}`);
  assertClean(world.unit);
});

test("digest grouping still applies to the request being shown (APRV-216)", async () => {
  // Two requests of the same shape and one of another: the pair is one thing to
  // read, and pacing shows it as one thing.
  const world = staged(3, (index) => (index < 2 ? payloadFor(index) : distinctPayloadFor(index)));
  const channel = channelFor();
  const setup = setupFor(world, channel, undefined, "paced");
  const state = newDispatchState();
  const { streams, err } = capture();

  const a = requestAt(world, 0, at(1));
  const b = requestAt(world, 1, at(2));
  const c = requestAt(world, 2, at(3));

  const cycle = await dispatchPending(setup, streams, state, at(63));
  assert.deepEqual(
    cycle.delivered.map((entry) => entry.action_key).sort(),
    [a, b].sort(),
    "the digest the oldest belongs to was not shown whole",
  );
  assert.equal(cycle.digests.length, 1, "the pair was not digested");
  assert.equal(
    cycle.delivered.some((entry) => entry.action_key === c),
    false,
    "an unrelated request rode along with the digest",
  );

  // The unit is released only once the log says no member is pending.
  channel.onDecision(handlerFor(world, at(65)));
  assert.equal((await press(channel, a, "grant"))?.ok, true);
  const half = await dispatchPending(setup, streams, state, at(66));
  assert.equal(half.delivered.length, 0, "the next request went out with a member still open");

  channel.onDecision(handlerFor(world, at(67)));
  assert.equal((await press(channel, b, "reject"))?.ok, true);
  const rest = await dispatchPending(setup, streams, state, at(68));
  assert.deepEqual(
    rest.delivered.map((entry) => entry.action_key),
    [c],
  );

  assert.deepEqual(err, [], `unexpected stderr: ${err.join("")}`);
  assertClean(world.unit);
});

test("a pending set that grows while nothing is shown announces itself again (APRV-216)", async () => {
  const world = staged(3, distinctPayloadFor);
  const channel = channelFor();
  const setup = setupFor(world, channel, undefined, "paced");
  const state = newDispatchState();
  const { streams, err } = capture();

  const a = requestAt(world, 0, at(1));
  const opening = await dispatchPending(setup, streams, state, at(63));
  assert.equal(opening.summary?.pending, 1);

  channel.onDecision(handlerFor(world, at(64)));
  assert.equal((await press(channel, a, "grant"))?.ok, true);

  // Two arrive while the approver has nothing in front of them.
  requestAt(world, 1, at(65));
  requestAt(world, 2, at(66));
  const grown = await dispatchPending(setup, streams, state, at(67));
  assert.equal(grown.summary?.pending, 2, "a queue that grew said nothing about it");

  assert.deepEqual(err, [], `unexpected stderr: ${err.join("")}`);
  assertClean(world.unit);
});

test("delivery: burst restores the banner and the whole pending set (APRV-216)", async () => {
  const world = staged(3, distinctPayloadFor);
  const setup = setupFor(world, channelFor(), undefined, "burst");
  const state = newDispatchState();
  const { streams, err } = capture();

  const keys = [requestAt(world, 0, at(1)), requestAt(world, 1, at(2)), requestAt(world, 2, at(3))];

  const cycle = await dispatchPending(setup, streams, state, at(63));
  assert.notEqual(cycle.banner, undefined, "the burst banner is gone");
  assert.equal(cycle.banner?.pending, 3);
  assert.equal(cycle.summary, undefined, "burst delivery sent the paced summary");
  assert.deepEqual(cycle.delivered.map((entry) => entry.action_key).sort(), [...keys].sort());

  assert.deepEqual(err, [], `unexpected stderr: ${err.join("")}`);
  assertClean(world.unit);
});

test("a command from another chat is ignored, and an unknown one is only counted (APRV-216)", async () => {
  const world = staged(1, distinctPayloadFor);
  const channel = channelFor();
  const setup = setupFor(world, channel, undefined, "paced");
  const state = newDispatchState();
  const { streams } = capture();

  requestAt(world, 0, at(1));
  await dispatchPending(setup, streams, state, at(63));

  const seen: string[] = [];
  channel.onCommand(async (command) => {
    seen.push(command);
    await commandHandlerFor(setup, streams, state)(command);
  });

  const foreignBefore = channel.anomalyCount("foreign-chat");
  const unknownBefore = channel.anomalyCount("unknown-command");
  const before = recordCount(world);
  const from = mock.sentTexts().length;

  mock.queueUpdate(messageUpdate({ chatId: "8080", text: "/queue" }));
  mock.queueUpdate(messageUpdate({ chatId: CHAT, text: "/deploy" }));
  mock.queueUpdate(messageUpdate({ chatId: CHAT, text: "good morning" }));
  await channel.pollOnce();

  assert.deepEqual(seen, [], "a command this channel must ignore reached the runtime");
  assert.equal(channel.anomalyCount("foreign-chat"), foreignBefore + 1);
  assert.equal(channel.anomalyCount("unknown-command"), unknownBefore + 1);
  assert.deepEqual(sentSince(from), [], "the channel replied to a command it ignored");
  assert.equal(recordCount(world), before, "an ignored command touched the log");
  assertClean(world.unit);
});

test("the bot command grammar is closed and forgiving in one direction only (APRV-216)", () => {
  assert.deepEqual([...TELEGRAM_COMMANDS], ["queue", "skip", "next"]);
  assert.equal(parseBotCommand("/queue"), "queue");
  assert.equal(parseBotCommand("  /Skip  "), "skip", "a command must survive case and spacing");
  assert.equal(parseBotCommand("/next@approval_md_bot"), "next", "the @bot suffix is not read");
  assert.equal(parseBotCommand("/queue please"), "queue", "a stray word must not refuse a command");
  assert.equal(parseBotCommand("/grant task-1:x"), null, "a decision is a button, never a word");
  assert.equal(parseBotCommand("queue"), null);
  assert.equal(parseBotCommand("what is /queue"), null);
  assert.equal(parseBotCommand(undefined), null);
});

test("the delivery mode is the policy's, and paced when it says nothing (APRV-216)", () => {
  assert.equal(TELEGRAM_DEFAULT_DELIVERY, "paced");

  const silent = newScenario(scratch.root, POLICY);
  assert.equal(telegramDeliveryFor(loadPolicy({ file: silent.policyPath })), "paced");

  const declared = newScenario(
    scratch.root,
    POLICY.replace("classes:", "channels:\n  telegram:\n    delivery: burst\nclasses:"),
  );
  const load = loadPolicy({ file: declared.policyPath });
  assert.equal(load.ok, true, `the policy did not load: ${JSON.stringify(load)}`);
  assert.equal(telegramDeliveryFor(load), "burst");

  // The enum is closed: an unrecognised mode fails validation rather than being
  // guessed at, and a policy that does not load leaves the default in force.
  const bogus = newScenario(
    scratch.root,
    POLICY.replace("classes:", "channels:\n  telegram:\n    delivery: hourly\nclasses:"),
  );
  const refused = loadPolicy({ file: bogus.policyPath });
  assert.equal(refused.ok, false, "an unknown delivery mode was accepted");
  assert.equal(telegramDeliveryFor(refused), "paced");
});

test("the summary and the queue listing are arithmetic on the log alone (APRV-216)", () => {
  const world = staged(2, distinctPayloadFor);
  requestAt(world, 0, at(1));
  requestAt(world, 1, at(120));
  const queue = buildPendingQueue(world.unit.logPath, world.tagOptions, at(180));
  assert.equal(queue.ok, true);
  const requests = queue.ok ? queue.requests : [];

  const summary = summaryLines(requests, at(180));
  assert.equal(summary.length, 1, "the summary is one line");
  assert.equal(summary[0]?.includes("2 pending"), true);
  assert.equal(summary[0]?.includes("2h 59m ago"), true, `oldest age wrong: ${String(summary[0])}`);

  // [0] summary, [1] the "this is a list" line (APRV-256), then the items.
  const listed = queueLines(requests, at(180), [world.keys[1] as string]);
  assert.equal(listed[2]?.startsWith("1. "), true, "the list is not numbered from one");
  assert.equal(listed[2]?.includes(TASK), true, "the list names no task");
  assert.equal(listed[3]?.includes("selected"), true, "the selected request is not marked");

  assert.deepEqual(summaryLines([], at(180)), ["Nothing pending — the queue is empty."]);
  assert.deepEqual(queueLines([], at(180), []), ["Nothing pending — the queue is empty."]);
});

/**
 * APRV-256. The reported bug was a reply that said "shown now" and "Tap the
 * buttons on the message above" to an approver who could see no buttons at all:
 * `/queue` was asserting present visibility from a delivery bookkeeping entry,
 * which records only that a send once returned success.
 *
 * These assertions are about words, and they are worth their space because the
 * words are the whole product here. Nothing in the queue's derivation changed,
 * so a test that only checked keys and counts would have passed before the fix
 * and after it.
 */
test("/queue calls itself a list and never claims a card is visible (APRV-256)", () => {
  const world = staged(3, distinctPayloadFor);
  requestAt(world, 0, at(1));
  requestAt(world, 1, at(2));
  requestAt(world, 2, at(3));
  const queue = buildPendingQueue(world.unit.logPath, world.tagOptions, at(180));
  assert.equal(queue.ok, true);
  const requests = queue.ok ? queue.requests : [];

  // --- Selected item -------------------------------------------------------
  const selected = queueLines(requests, at(180), [world.keys[0] as string]).join("\n");

  // AC #1: the reply identifies itself as a list without decision buttons, and
  // points at the card without placing it.
  assert.equal(selected.includes("no decision buttons"), true, `not self-identified: ${selected}`);
  assert.equal(selected.includes("its own approval card"), true, "decisions are not directed");
  assert.equal(
    selected.includes("wherever that card sits"),
    true,
    "the card's position is asserted or omitted",
  );

  // AC #2: the two reported phrases are gone, and no synonym takes their place.
  for (const banned of [
    "shown now",
    "message above",
    "the message below",
    "above to decide",
    "being shown",
    "in front of you",
  ]) {
    assert.equal(selected.includes(banned), false, `${banned} survived in: ${selected}`);
  }
  assert.equal(
    selected.includes("card sent earlier"),
    true,
    "the marker does not describe prior delivery",
  );
  assert.equal(
    selected.includes("cannot tell whether that card is still here"),
    true,
    "the reply vouches for a card it cannot see",
  );

  // AC #3: recovery, and what recovery does not do.
  assert.equal(selected.includes("/skip is the recovery"), true, "no /skip recovery is offered");
  assert.equal(selected.includes("Nothing is decided by typing it"), true, "no decision disclaimer");
  assert.equal(selected.includes("stays pending in the log"), true, "pendingness is not stated");
  assert.equal(
    selected.includes("a fresh card is sent on a later listener cycle"),
    true,
    "the fresh card is not promised to a later cycle",
  );
  assert.equal(selected.includes("gloss is being written"), true, "the gloss delay is unmentioned");
  assert.equal(
    selected.includes("It is not a way to ask for the card again."),
    true,
    "/next is left readable as a resend",
  );
  assert.equal(selected.includes("no new card is sent for it"), true, "/next is not disambiguated");

  // Only the selected key is marked, and it is marked once.
  assert.equal(
    selected.split(SELECTED_LINE_MARKER).length - 1,
    1,
    `more than one request is marked: ${selected}`,
  );
  const markedLine = selected
    .split("\n")
    .find((line) => line.includes(SELECTED_LINE_MARKER)) as string;
  assert.equal(markedLine.includes(world.keys[0] as string), true, "the wrong request is marked");

  // --- A digest selection is still ONE card --------------------------------
  // `state.paced.current` carries every key of a digest group, and the group
  // reached Telegram as a single message, so the plural branch must not invite
  // the approver to hunt for one card per marked line.
  const grouped = queueLines(requests, at(180), [
    world.keys[0] as string,
    world.keys[1] as string,
  ]).join("\n");
  assert.equal(grouped.split(SELECTED_LINE_MARKER).length - 1, 2, "both keys were not marked");
  assert.equal(
    grouped.includes("a single approval card for them was sent to this chat earlier"),
    true,
    `a digest selection implied several cards: ${grouped}`,
  );
  assert.equal(grouped.includes("/skip is the recovery"), true, "recovery is singular-only");

  // --- No selected item ----------------------------------------------------
  const none = queueLines(requests, at(180), []).join("\n");
  assert.equal(none.includes("no decision buttons"), true, "the list line is selection-dependent");
  assert.equal(none.includes(SELECTED_LINE_MARKER), false, "an unselected request was marked");
  assert.equal(
    none.includes("Nothing is selected right now"),
    true,
    `the empty selection is not stated: ${none}`,
  );
  assert.equal(
    none.includes("no approval card has been sent for any of these"),
    true,
    "a card is implied with nothing selected",
  );
  // With nothing selected there is no lost card to recover, so the recovery
  // paragraph stays off rather than inviting a /skip that has nothing to skip.
  assert.equal(none.includes("/skip is the recovery"), false, "recovery offered with no selection");
  for (const banned of ["shown now", "message above", "in front of you"]) {
    assert.equal(none.includes(banned), false, `${banned} survived in: ${none}`);
  }

  // --- Empty queue ---------------------------------------------------------
  const empty = queueLines([], at(180), []).join("\n");
  assert.equal(empty, "Nothing pending — the queue is empty.");
  for (const banned of ["card", "button", "shown now", "message above", "/skip", "/next"]) {
    assert.equal(empty.includes(banned), false, `an empty queue mentioned ${banned}: ${empty}`);
  }
});
