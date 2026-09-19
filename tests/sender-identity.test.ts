/**
 * Authenticated channel sender to attested human identity (APRV-324).
 *
 * The nineteen cases `design/channel-sender-identity.md` §7 enumerates, in its
 * own grouping and its own order, because that section is this task's
 * specification and a reader should be able to check them off against it.
 *
 * Same discipline as every other suite here, and it is the discipline the
 * subject demands: **no log line is written by hand**. The policy is attested
 * through `core/attest.ts`, tasks are registered and requested through
 * `core/gate.ts`, and every decision goes through the Telegram channel's own
 * callback path into `recordChannelDecision` into the human-only `decide()`.
 * The Bot API is the local mock in `tests/telegram-mock.ts` and the network is
 * never touched: a test that forged an identity by writing a record would be
 * evidence about the forgery.
 *
 * The one thing worth stating about what these tests are for. Every case here
 * is about who a decision is ATTRIBUTED to, and attribution is the field of a
 * log that cannot be checked by rerunning anything: a grant naming the wrong
 * person reads exactly like a grant naming the right one. So the negative
 * cases are the point — an unmapped account, a spoofed body, a username that
 * matches somebody else's id, a second tap that loses a race — and each of them
 * asserts what is NOT in the log as carefully as what is.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";

import { appendAttestation, policyFileHash } from "../src/core/attest.js";
import {
  recordChannelDecision,
  type ChannelDecision,
  type ChannelDecisionResult,
  type DecisionOutcome,
} from "../src/channels/contract.js";
import {
  decideAttestation,
  inForcePolicyText,
  proposeAttestation,
} from "../src/core/policy-proposal.js";
import { payloadStoreDirFor } from "../src/core/payload-store.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { buildPendingQueue, type TagOptions } from "../src/channels/tagging.js";
import {
  TelegramChannel,
  senderOf,
  type TelegramConfig,
} from "../src/channels/telegram.js";
import { payloadHash } from "../src/core/payload.js";
import { loadPolicyText } from "../src/core/policy-load.js";
import { resolve as resolveClass } from "../src/core/policy-match.js";
import {
  CHANNEL_DECISION_REFUSAL_CODES,
  SENDER_CHANNELS,
  resolveSender,
  senderIndex,
  senderRefusalLine,
  type ChannelSender,
} from "../src/core/sender-identity.js";
import { appendEvent, type EventRecord } from "../src/core/log.js";
import { register, request } from "./clock-adapters.js";
import {
  assertClean,
  at,
  fixedClock,
  newScenario,
  payloadOf,
  records,
  scratchRoot,
  type Scenario,
} from "./scenario.js";
import { assertLocal, callbackUpdate, startMockBotApi, type MockBotApi } from "./telegram-mock.js";

const TOKEN = "123456:mock-bot-token";
const CHAT = "-1001234567890";
const TASK = "task-324";
const AGENT = "agent:drafter";
/** The identity the listener PROCESS is launched with (`--as`). */
const LISTENER = "human:carter";

/** Carter's Telegram account, in these fixtures. */
const CARTER_ID = "42";
/** Dana's. A second person in the same configured chat — the whole subject. */
const DANA_ID = "77";
/** Nobody's: an account the policy names in none of its blocks. */
const STRANGER_ID = "999";

const scratch = scratchRoot("sender-identity");

/**
 * The fixture policy, as a function of its `approvers` and class blocks.
 *
 * Written as one builder rather than six literals so the only difference
 * between the mapped and unmapped worlds is the thing under test. Everything
 * else — the TTL, the class, the ceiling — is held still.
 */
function policyText(options: {
  senders?: Record<string, string>;
  classApprovers?: string[];
  autonomy?: string;
  /** An unrelated knob, so an amendment can change something that is not the mapping. */
  ttl?: string;
}): string {
  const lines = [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    `  approval_ttl: "${options.ttl ?? "24h"}"`,
    "  on_expiry: reject",
    "approvers:",
  ];
  for (const id of ["carter", "dana"]) {
    lines.push(`  ${id}:`, "    channels: [telegram, cli]");
    const sender = options.senders?.[id];
    if (sender !== undefined) lines.push("    senders:", `      telegram: "${sender}"`);
  }
  lines.push(
    "classes:",
    "  communicate.email.external:",
    `    autonomy: ${options.autonomy ?? "manual"}`,
  );
  if (options.classApprovers !== undefined) {
    lines.push(`    approvers: [${options.classApprovers.join(", ")}]`);
  }
  lines.push("```", "");
  return lines.join("\n");
}

/** No mapping anywhere: every deployment before APRV-324, and most after. */
const POLICY_UNMAPPED = policyText({});
/** Both people mapped, and the class names neither, so both may decide. */
const POLICY_MAPPED = policyText({ senders: { carter: CARTER_ID, dana: DANA_ID } });
/** Both mapped, and the class names only Carter. */
const POLICY_CARTER_ONLY = policyText({
  senders: { carter: CARTER_ID, dana: DANA_ID },
  classApprovers: ["carter"],
});
/** Carter mapped, Dana's entry removed: the stale-mapping case. */
const POLICY_CARTER_MAPPED = policyText({ senders: { carter: CARTER_ID } });
/** One account, two people. Refused at load. */
const POLICY_AMBIGUOUS = policyText({ senders: { carter: CARTER_ID, dana: CARTER_ID } });
/** The class reserved to human hands. */
const POLICY_HUMAN_ONLY = policyText({
  senders: { carter: CARTER_ID, dana: DANA_ID },
  autonomy: "human-only",
});

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

interface World {
  unit: Scenario;
  keys: string[];
  tagOptions: TagOptions;
}

let fixtureCounter = 0;

function payloadFor(index: number): Record<string, unknown> {
  return { to: [`ap-${index}@vendor.example`], subject: `chaser ${index}` };
}

/** `count` live manual requests in a fresh log, built through the real gate. */
function world(count: number, text: string = POLICY_MAPPED): World {
  fixtureCounter += 1;
  const unit = newScenario(scratch.root, text);
  attestPolicy(unit);

  const payloads = new Map<string, unknown>();
  const keys: string[] = [];
  const actions = [];
  for (let index = 0; index < count; index += 1) {
    const key = `${TASK}:case${fixtureCounter}-${index}`;
    const payload = payloadFor(index);
    keys.push(key);
    payloads.set(key, payload);
    actions.push({
      class: "communicate.email.external",
      idempotency_key: key,
      summary: `chase invoice ${index}`,
      est_cost_usd: "0.02",
      payload_hash: payloadHash(payload),
    });
  }

  const registered = register(
    unit.logPath,
    { task: TASK, envelope: { origin: { app: "manual", created_by: AGENT }, state: "awaiting", actions } },
    at(0),
    AGENT,
    unit.options,
  );
  assert.equal(registered.ok, true, `registration failed: ${JSON.stringify(registered)}`);

  for (const [index, key] of keys.entries()) {
    const requested = request(
      unit.logPath,
      {
        task: TASK,
        actionKey: key,
        cls: "communicate.email.external",
        est_cost_usd: "0.02",
        summary: `chase invoice ${index}`,
      },
      at(1),
      AGENT,
      unit.options,
    );
    assert.equal(requested.ok, true, `request failed: ${JSON.stringify(requested)}`);
  }

  return {
    unit,
    keys,
    tagOptions: { policy: { file: unit.policyPath }, payload: (key) => payloads.get(key) },
  };
}

/** Attest whatever bytes are on disk now, through the real append path. */
function attestPolicy(unit: Scenario, ts: string = at(0)): void {
  const result = appendAttestation(unit.logPath, unit.policyPath, LISTENER, {
    clock: fixedClock(ts),
  });
  assert.equal(result.ok, true, "attestation append failed");
}

const complaints: string[] = [];

function channelFor(): TelegramChannel {
  const config: TelegramConfig = {
    token: TOKEN,
    chatId: CHAT,
    apiBase: assertLocal(mock.url),
    pollTimeoutSeconds: 0,
    requestTimeoutMs: 3_000,
    backoffMs: 5,
    maxBackoffMs: 20,
    log: (message) => complaints.push(message),
  };
  return new TelegramChannel(config);
}

/**
 * The runtime's decision handler, as `cli/channel-telegram.ts` builds it: the
 * listener's own identity, its own channel name, and nothing about a sender —
 * which is the point. Everything a sender changes is changed by the sender
 * riding on the reported gesture, not by this configuration.
 */
function handlerFor(
  unit: Scenario,
  now: string = at(2),
  extra: Record<string, unknown> = {},
): (decision: ChannelDecision) => DecisionOutcome {
  return (decision) =>
    recordChannelDecision(
      unit.logPath,
      decision,
      { actor: LISTENER, channel: "telegram" },
      { ...unit.options, ...extra, clock: fixedClock(now) },
    ).outcome;
}

/** Deliver one request to the chat, so the channel holds a live button. */
async function deliver(w: World, index: number, channel: TelegramChannel, now = at(2)): Promise<void> {
  const queue = buildPendingQueue(w.unit.logPath, w.tagOptions, now);
  assert.equal(queue.ok, true, JSON.stringify(queue));
  const key = w.keys[index];
  const request_ = queue.ok ? queue.requests.find((entry) => entry.action_key.value === key) : undefined;
  assert.ok(request_ !== undefined, `no pending request for ${String(key)}`);
  await channel.notify(request_);
}

/** Press a button as `fromId`, with whatever spoofed neighbours the case needs. */
async function press(
  channel: TelegramChannel,
  actionKey: string,
  decision: "grant" | "reject",
  options: {
    fromId?: string;
    chatId?: string;
    from?: string;
    spoofMessageFromId?: string;
    spoofMessageText?: string;
  } = {},
): Promise<DecisionOutcome | undefined> {
  mock.queueUpdate(
    callbackUpdate({
      data: mock.callbackDataFor(actionKey, decision),
      chatId: options.chatId ?? CHAT,
      ...(options.fromId === undefined ? {} : { fromId: options.fromId }),
      ...(options.from === undefined ? {} : { from: options.from }),
      ...(options.spoofMessageFromId === undefined
        ? {}
        : { spoofMessageFromId: options.spoofMessageFromId }),
      ...(options.spoofMessageText === undefined
        ? {}
        : { spoofMessageText: options.spoofMessageText }),
    }),
  );
  const result = await channel.pollOnce();
  return result.outcomes.find((entry) => entry.action_key === actionKey)?.outcome;
}

function decisionRecords(unit: Scenario): EventRecord[] {
  return records(unit).filter((record) => record.event.startsWith("approval.grant")
    || record.event === "approval.rejected"
    || record.event === "approval.revoked");
}

function refusals(unit: Scenario): EventRecord[] {
  return records(unit).filter((record) => record.event === "audit.decision_refused");
}

// ---------------------------------------------------------------------------
// 1. Compatibility — the one that must pass first (design §7)
// ---------------------------------------------------------------------------

test("1. a policy with no senders decides exactly as it did before, on all three channels", async () => {
  const w = world(3, POLICY_UNMAPPED);
  const channel = channelFor();
  channel.onDecision(handlerFor(w.unit));
  await deliver(w, 0, channel);

  // Telegram, with a real authenticated sender on the callback: the channel
  // observes it, the policy maps nothing for the channel, and the decision is
  // attributed by configuration exactly as every build before APRV-324.
  const outcome = await press(channel, w.keys[0] as string, "grant", { fromId: DANA_ID });
  assert.ok(outcome?.ok === true, JSON.stringify(outcome));
  assert.equal(outcome.record.actor, LISTENER);

  // Web and CLI report no sender at all, which is what their own code does:
  // neither authenticates anybody, so neither may claim anybody.
  for (const [index, name] of [[1, "web"], [2, "cli"]] as const) {
    const result = recordChannelDecision(
      w.unit.logPath,
      { action_key: w.keys[index] as string, decision: "grant", deliveryId: `d-${name}` },
      { actor: LISTENER, channel: name },
      { ...w.unit.options, clock: fixedClock(at(2)) },
    );
    assert.ok(result.outcome.ok, JSON.stringify(result.outcome));
    assert.equal(result.outcome.record.actor, LISTENER);
  }

  const decisions = decisionRecords(w.unit);
  assert.equal(decisions.length, 3);
  for (const record of decisions) {
    const payload = payloadOf(record);
    // The compatibility claim in its exact form: every field an older build
    // wrote is here, and neither of the two new payload keys is.
    assert.equal(record.actor, LISTENER);
    assert.equal("sender" in payload, false, JSON.stringify(payload));
    assert.equal("sender_source" in payload, false, JSON.stringify(payload));
    assert.ok(typeof payload["token_sha256"] === "string");
  }
  // The ONE difference from a pre-APRV-324 log, and it is additive: the record
  // names the surface that collected it (design §4 item 1, test 18 below).
  assert.deepEqual(decisions.map((record) => record.channel), ["telegram", "web", "cli"]);
  assert.equal(refusals(w.unit).length, 0);
  assertClean(w.unit);
});

// ---------------------------------------------------------------------------
// 2-4. Two distinct senders (design §7, AC2)
// ---------------------------------------------------------------------------

test("2. two senders in one chat produce two different actors, each matching its own callback", async () => {
  const w = world(2);
  const channel = channelFor();
  channel.onDecision(handlerFor(w.unit));

  await deliver(w, 0, channel);
  const first = await press(channel, w.keys[0] as string, "grant", { fromId: CARTER_ID });
  await deliver(w, 1, channel);
  const second = await press(channel, w.keys[1] as string, "grant", { fromId: DANA_ID });

  assert.ok(first?.ok === true, JSON.stringify(first));
  assert.ok(second?.ok === true, JSON.stringify(second));
  assert.equal(first.record.actor, "human:carter");
  assert.equal(second.record.actor, "human:dana");
  // Dana decided as Dana even though the listener process is Carter's: the
  // actor came from the mapping, not from `--as`.
  assert.notEqual(second.record.actor, LISTENER);

  assert.deepEqual(payloadOf(first.record)["sender"], { channel: "telegram", id: CARTER_ID });
  assert.deepEqual(payloadOf(second.record)["sender"], { channel: "telegram", id: DANA_ID });
  assert.equal(payloadOf(first.record)["sender_source"], "policy");
  assert.equal(payloadOf(second.record)["sender_source"], "policy");
  assertClean(w.unit);
});

test("3. the second sender on one action key is refused already-decided, and the refusal names them", async () => {
  const w = world(1);
  const channel = channelFor();
  channel.onDecision(handlerFor(w.unit));
  await deliver(w, 0, channel);
  const key = w.keys[0] as string;

  const first = await press(channel, key, "grant", { fromId: CARTER_ID });
  assert.ok(first?.ok === true, JSON.stringify(first));

  // The first tap disarms the message and this listener forgets its nonce, so
  // Dana's tap is reported to the runtime the way the channel reports every
  // gesture — the same call `handlerFor` makes — rather than through a button
  // that no longer exists. What is under test is the DECISION path: the second
  // person's answer to a question that already has one.
  const second = recordChannelDecision(
    w.unit.logPath,
    senderDecision(key, DANA_ID),
    { actor: LISTENER, channel: "telegram" },
    { ...w.unit.options, clock: fixedClock(at(2)) },
  ).outcome;
  assert.equal(second.ok, false, JSON.stringify(second));
  assert.equal(second.ok === false ? second.code : "", "already-decided");

  assert.equal(decisionRecords(w.unit).length, 1);
  const refusal = refusals(w.unit);
  assert.equal(refusal.length, 1);
  const payload = payloadOf(refusal[0] as EventRecord);
  assert.equal(payload["code"], "already-decided");
  assert.equal(payload["actor"], "human:dana");
  assert.deepEqual(payload["sender"], { channel: "telegram", id: DANA_ID });
  assertClean(w.unit);
});

test("4. a mapped sender the class does not name is refused actor-not-approver, the existing code", async () => {
  const w = world(1, POLICY_CARTER_ONLY);
  const channel = channelFor();
  channel.onDecision(handlerFor(w.unit));
  await deliver(w, 0, channel);

  const outcome = await press(channel, w.keys[0] as string, "grant", { fromId: DANA_ID });
  assert.ok(outcome !== undefined && outcome.ok === false, JSON.stringify(outcome));
  // The existing code, from the existing check, over an identity that is now
  // evidenced: the gate's authorization logic did not change at all.
  assert.equal(outcome.code, "actor-not-approver");
  assert.match(outcome.message, /human:dana/u);
  assert.equal(decisionRecords(w.unit).length, 0);
  assertClean(w.unit);
});

// ---------------------------------------------------------------------------
// 5-7. Missing or stale mapping (design §7, AC2)
// ---------------------------------------------------------------------------

test("5. an unmapped sender writes no decision, one refusal, and the observed id", async () => {
  const w = world(1);
  const channel = channelFor();
  channel.onDecision(handlerFor(w.unit));
  await deliver(w, 0, channel);

  const outcome = await press(channel, w.keys[0] as string, "grant", { fromId: STRANGER_ID });
  assert.ok(outcome !== undefined && outcome.ok === false, JSON.stringify(outcome));
  assert.equal(outcome.code, "sender-unmapped");
  assert.equal(decisionRecords(w.unit).length, 0);

  const refusal = refusals(w.unit);
  assert.equal(refusal.length, 1);
  const record = refusal[0] as EventRecord;
  const payload = payloadOf(record);
  assert.equal(payload["code"], "sender-unmapped");
  assert.deepEqual(payload["sender"], { channel: "telegram", id: STRANGER_ID });
  // No `actor`: the runtime could not say who this was, and naming the
  // listener would be the false record the refusal exists to prevent.
  assert.equal("actor" in payload, false, JSON.stringify(payload));
  assert.equal("sender_source" in payload, false, JSON.stringify(payload));
  assert.equal(record.channel, "telegram");
  assert.equal(record.actor, "system:gate");

  // The chat is told what happened, in words that recite no id and name no
  // approver: the line itself is the disclosure surface, and a chat is read by
  // everyone in it.
  const line = senderRefusalLine("sender-unmapped");
  assert.equal(line.includes(STRANGER_ID), false, "the chat was told an account id");
  assert.equal(line.includes("carter"), false, "the chat was told who IS mapped");
  assert.equal(line.includes("dana"), false, "the chat was told who IS mapped");
  const edits = mock.edits().map((edit) => edit.text).join("\n");
  assert.ok(edits.includes(line), `the chat was not told: ${edits}`);
  assertClean(w.unit);
});

test("6. a mapping removed between the request and the tap refuses rather than honouring the old one", async () => {
  const w = world(1);
  const channel = channelFor();
  channel.onDecision(handlerFor(w.unit));
  await deliver(w, 0, channel);

  // The operator removes Dana's account from the roster and re-attests, which
  // is the whole of what a revocation of this kind is.
  writePolicy(w.unit, POLICY_CARTER_MAPPED);
  attestPolicy(w.unit, at(2));

  const outcome = await press(channel, w.keys[0] as string, "grant", { fromId: DANA_ID });
  assert.ok(outcome !== undefined && outcome.ok === false, JSON.stringify(outcome));
  // Refused for the MAPPING, which is read at decision time. The tap is not
  // honoured under the policy that was in force when the question was asked.
  assert.equal(outcome.code, "sender-unmapped");
  assert.equal(decisionRecords(w.unit).length, 0);
  assert.deepEqual(payloadOf(refusals(w.unit)[0] as EventRecord)["sender"], {
    channel: "telegram",
    id: DANA_ID,
  });

  // The re-attestation also voids every pending request (`policy-drift`), so
  // the tap is refused twice over and neither refusal honours the old mapping.
  // What the mapping alone decides is the identity question, and Carter — still
  // in the file as it now stands — still resolves against the policy in force.
  const now = loadPolicyText(w.unit.policyPath, POLICY_CARTER_MAPPED);
  assert.equal(resolveSender(now, { channel: "telegram", id: CARTER_ID }).kind, "mapped");
  assert.equal(resolveSender(now, { channel: "telegram", id: DANA_ID }).kind, "unmapped");
  assertClean(w.unit);
});

test("7. one account claimed by two approvers refuses the policy at load, so every class is manual", () => {
  const load = loadPolicyText("APPROVAL.md", POLICY_AMBIGUOUS);
  assert.equal(load.ok, false, "an ambiguous sender mapping loaded");
  assert.equal(load.ok === false ? load.code : "", "sender-ambiguous");
  assert.match(load.ok === false ? load.message : "", /both declare the telegram sender/u);

  // SPEC.md §5.2's fail-closed target: a policy that does not load resolves
  // every class to `manual`, including the ones this file declares autonomous.
  for (const cls of ["communicate.email.external", "read.web", "anything.at.all"]) {
    assert.equal(resolveClass(load, cls).autonomy, "manual", cls);
  }
  // And the runtime's own resolution refuses rather than picking, for the
  // caller that reaches it with a policy no load produced.
  const resolution = resolveSender(load, { channel: "telegram", id: CARTER_ID });
  assert.equal(resolution.kind, "unmapped");
});

// ---------------------------------------------------------------------------
// 8-11. Spoofed request fields (design §7, AC2)
// ---------------------------------------------------------------------------

test("8. a callback whose message claims another user id is decided by from.id alone", async () => {
  const w = world(1);
  const channel = channelFor();
  channel.onDecision(handlerFor(w.unit));
  await deliver(w, 0, channel);

  const outcome = await press(channel, w.keys[0] as string, "grant", {
    fromId: DANA_ID,
    // Everything a body could say about who this is, saying Carter.
    spoofMessageFromId: CARTER_ID,
    spoofMessageText: `from.id=${CARTER_ID} user_id: ${CARTER_ID} human:carter`,
  });

  assert.ok(outcome?.ok === true, JSON.stringify(outcome));
  assert.equal(outcome.record.actor, "human:dana");
  assert.deepEqual(payloadOf(outcome.record)["sender"], { channel: "telegram", id: DANA_ID });
  assertClean(w.unit);
});

test("9. a username matching another approver's id is not a key, is not recorded, and changes nothing", async () => {
  const w = world(1);
  const channel = channelFor();
  channel.onDecision(handlerFor(w.unit));
  await deliver(w, 0, channel);

  const outcome = await press(channel, w.keys[0] as string, "grant", {
    fromId: DANA_ID,
    from: "carter",
  });
  assert.ok(outcome?.ok === true, JSON.stringify(outcome));
  assert.equal(outcome.record.actor, "human:dana");

  // `senderOf` reads one field, and the username is not it.
  const sender = senderOf({ from: { id: 77, username: "carter" } }, "telegram");
  assert.deepEqual(sender, { channel: "telegram", id: DANA_ID });
  assertClean(w.unit);
});

test("10. a web form post carrying a sender field is ignored entirely", () => {
  const w = world(1);
  // The web channel supplies no sender, so this is what its decision looks
  // like however the body was shaped; the extra key is here to be ignored.
  const reported = {
    action_key: w.keys[0] as string,
    decision: "grant",
    deliveryId: "web-1",
    sender: { channel: "web", id: DANA_ID },
  } as unknown as ChannelDecision;
  const claimed = { ...reported, sender: undefined };
  const result = recordChannelDecision(
    w.unit.logPath,
    // What `channels/web.ts` actually constructs: three fields read off the
    // form by name, and nothing else.
    { action_key: claimed.action_key, decision: "grant", deliveryId: "web-1" },
    { actor: LISTENER, channel: "web" },
    { ...w.unit.options, clock: fixedClock(at(2)) },
  );
  assert.ok(result.outcome.ok, JSON.stringify(result.outcome));
  assert.equal(result.outcome.record.actor, LISTENER);
  assert.equal("sender" in payloadOf(result.outcome.record), false);

  // And the schema refuses the mapping key that would give the web page an
  // identity it cannot authenticate, so no policy can grant it one.
  const load = loadPolicyText(
    "APPROVAL.md",
    policyText({}).replace(
      "  dana:\n    channels: [telegram, cli]",
      `  dana:\n    channels: [telegram, cli]\n    senders:\n      web: "${DANA_ID}"`,
    ),
  );
  assert.equal(load.ok, false, "a web sender mapping loaded");
  assert.equal(load.ok === false ? load.code : "", "schema-invalid");
  assert.deepEqual([...SENDER_CHANNELS], ["telegram"]);
  assertClean(w.unit);
});

test("11. a mapped sender in an unconfigured chat is still ignored: the mapping widens who, never where", async () => {
  const w = world(1);
  const channel = channelFor();
  channel.onDecision(handlerFor(w.unit));
  await deliver(w, 0, channel);

  const outcome = await press(channel, w.keys[0] as string, "grant", {
    fromId: CARTER_ID,
    chatId: "-100999",
  });
  assert.equal(outcome, undefined, "a foreign chat produced a decision");
  assert.equal(records(w.unit).length, 3, "a foreign chat wrote to the log");
  assert.equal(refusals(w.unit).length, 0);
  assertClean(w.unit);
});

// ---------------------------------------------------------------------------
// 12-13. Unauthorized sender (design §7, AC2)
// ---------------------------------------------------------------------------

test("12. an unauthorized mapped sender appends nothing beyond the refusal record", async () => {
  const w = world(1, POLICY_CARTER_ONLY);
  const channel = channelFor();
  channel.onDecision(handlerFor(w.unit));
  await deliver(w, 0, channel);
  const before = records(w.unit).length;

  const outcome = await press(channel, w.keys[0] as string, "grant", { fromId: DANA_ID });
  assert.ok(outcome !== undefined && outcome.ok === false);
  assert.equal(outcome.code, "actor-not-approver");

  const written = records(w.unit).slice(before);
  assert.deepEqual(written.map((record) => record.event), ["audit.decision_refused"]);
  const payload = payloadOf(written[0] as EventRecord);
  assert.equal(payload["actor"], "human:dana");
  assert.deepEqual(payload["sender"], { channel: "telegram", id: DANA_ID });
  assert.equal(payload["sender_source"], "policy");
  assertClean(w.unit);
});

test("13. a human-only class refuses before any sender resolution and records no sender", async () => {
  const w = world(1, POLICY_MAPPED);
  // Raised to human-only after the request was routed, which is the only way a
  // live request can be sitting under such a class.
  writePolicy(w.unit, POLICY_HUMAN_ONLY);
  attestPolicy(w.unit, at(2));

  const channel = channelFor();
  channel.onDecision(handlerFor(w.unit));
  await deliver(w, 0, channel);
  const before = records(w.unit).length;

  const outcome = await press(channel, w.keys[0] as string, "grant", { fromId: CARTER_ID });
  assert.ok(outcome !== undefined && outcome.ok === false, JSON.stringify(outcome));
  assert.equal(outcome.code, "class-human-only");
  assert.equal(decisionRecords(w.unit).length, 0);

  // §11.1 invariant 9: the class is inert to this path, so nothing the runtime
  // writes about it resolves an identity. The refusal says a person was
  // refused and names no account.
  for (const record of records(w.unit).slice(before)) {
    const payload = payloadOf(record);
    assert.equal("sender" in payload, false, JSON.stringify(payload));
    assert.equal("sender_source" in payload, false, JSON.stringify(payload));
  }
  assertClean(w.unit);
});

// ---------------------------------------------------------------------------
// 14-16. Concurrent decisions (design §7, AC2)
// ---------------------------------------------------------------------------

test("14. two senders racing one action key produce one grant, one token, and a re-derived refusal", () => {
  const w = world(1);
  const key = w.keys[0] as string;

  // The interleaving, forced rather than hoped for. `GateOptions.policy.read`
  // is the gate's one policy-read seam and is called once per attempt, AFTER
  // the log has been read and BEFORE the append — exactly the window a second
  // writer has to land in. Dana's whole decision is run from inside Carter's,
  // so Carter's append meets a head that moved.
  const injected = injectAt(w.unit, 2, () => {
    const dana = recordChannelDecision(
      w.unit.logPath,
      senderDecision(key, DANA_ID),
      { actor: LISTENER, channel: "telegram" },
      { ...w.unit.options, clock: fixedClock(at(2)) },
    );
    assert.ok(dana.outcome.ok, JSON.stringify(dana.outcome));
  });

  const carter = recordChannelDecision(
    w.unit.logPath,
    senderDecision(key, CARTER_ID),
    { actor: LISTENER, channel: "telegram" },
    { ...w.unit.options, ...injected, clock: fixedClock(at(2)) },
  );

  const grants = decisionRecords(w.unit);
  assert.equal(grants.length, 1, "two decisions were recorded for one action key");
  assert.equal(grants[0]?.actor, "human:dana");
  assert.equal(typeof payloadOf(grants[0] as EventRecord)["token_sha256"], "string");

  // The loser is told the state the log actually holds, not that it lost a
  // race: `withHeadMovedRetry` re-ran every check against the fresh head.
  assert.equal(carter.outcome.ok, false);
  assert.equal(carter.outcome.ok === false ? carter.outcome.code : "", "already-decided");
  assert.equal(carter.token, undefined, "the loser was handed a token");

  const refusal = refusals(w.unit);
  assert.equal(refusal.length, 1);
  assert.deepEqual(payloadOf(refusal[0] as EventRecord)["sender"], {
    channel: "telegram",
    id: CARTER_ID,
  });
  assertClean(w.unit);

  // And the interleaving above is a real one rather than a sequential pair
  // dressed up as a race: the same injection under `retryOnHeadMoved: 1` —
  // the pre-APRV-150 shape, one read and one append — refuses `append-failed`
  // with the append's own `head-moved`, which is only reachable when the
  // second write lands between the first's read and its append.
  const raced = world(1);
  const racedKey = raced.keys[0] as string;
  const racedInjection = injectAt(raced.unit, 2, () => {
    const dana = recordChannelDecision(
      raced.unit.logPath,
      senderDecision(racedKey, DANA_ID),
      { actor: LISTENER, channel: "telegram" },
      { ...raced.unit.options, clock: fixedClock(at(2)) },
    );
    assert.ok(dana.outcome.ok, JSON.stringify(dana.outcome));
  });
  const loser = recordChannelDecision(
    raced.unit.logPath,
    senderDecision(racedKey, CARTER_ID),
    { actor: LISTENER, channel: "telegram" },
    { ...raced.unit.options, ...racedInjection, retryOnHeadMoved: 1, clock: fixedClock(at(2)) },
  ).outcome;
  assert.equal(loser.ok, false);
  assert.equal(loser.ok === false ? loser.code : "", "append-failed");
  assert.equal(
    loser.ok === false && "append" in loser ? loser.append?.code : "",
    "head-moved",
  );
  assert.equal(decisionRecords(raced.unit).length, 1);
  assert.equal(decisionRecords(raced.unit)[0]?.actor, "human:dana");
  assertClean(raced.unit);
});

test("15. two senders racing two action keys both land, each under its own actor", () => {
  const w = world(2);
  const [first, second] = [w.keys[0] as string, w.keys[1] as string];

  const injected = injectAt(w.unit, 2, () => {
    const dana = recordChannelDecision(
      w.unit.logPath,
      senderDecision(second, DANA_ID),
      { actor: LISTENER, channel: "telegram" },
      { ...w.unit.options, clock: fixedClock(at(2)) },
    );
    assert.ok(dana.outcome.ok, JSON.stringify(dana.outcome));
  });

  const carter = recordChannelDecision(
    w.unit.logPath,
    senderDecision(first, CARTER_ID),
    { actor: LISTENER, channel: "telegram" },
    { ...w.unit.options, ...injected, clock: fixedClock(at(2)) },
  );
  assert.ok(carter.outcome.ok, JSON.stringify(carter.outcome));

  const grants = decisionRecords(w.unit);
  assert.equal(grants.length, 2);
  const byKey = new Map(grants.map((record) => [record.action_key, record]));
  assert.equal(byKey.get(second)?.actor, "human:dana");
  assert.equal(byKey.get(first)?.actor, "human:carter");
  // Neither read the other's write as its own: each grant's sender is the one
  // its own callback carried.
  assert.deepEqual(payloadOf(byKey.get(first) as EventRecord)["sender"], {
    channel: "telegram",
    id: CARTER_ID,
  });
  assert.deepEqual(payloadOf(byKey.get(second) as EventRecord)["sender"], {
    channel: "telegram",
    id: DANA_ID,
  });
  assert.equal(refusals(w.unit).length, 0);
  assertClean(w.unit);
});

test("16. a sender resolved against one policy never authorizes against another", () => {
  const w = world(1);
  const key = w.keys[0] as string;

  // The seam returns the attested bytes to the resolution and different bytes
  // to the gate, which is the swap this seam exists to simulate. Whatever else
  // happens, a grant must not come out of it.
  let call = 0;
  const attested = readPolicy(w.unit);
  const result = recordChannelDecision(
    w.unit.logPath,
    senderDecision(key, CARTER_ID),
    { actor: LISTENER, channel: "telegram" },
    {
      ...w.unit.options,
      policy: {
        file: w.unit.policyPath,
        read: () => {
          call += 1;
          return Buffer.from(call === 1 ? attested : POLICY_CARTER_MAPPED, "utf8");
        },
      },
      clock: fixedClock(at(2)),
    },
  );

  assert.equal(result.outcome.ok, false, "a grant was recorded across a policy swap");
  assert.equal(
    result.outcome.ok === false ? result.outcome.code : "",
    "policy-not-attested",
  );
  assert.equal(decisionRecords(w.unit).length, 0);
  assertClean(w.unit);
});

// ---------------------------------------------------------------------------
// 17-19. Audit fields (design §7)
// ---------------------------------------------------------------------------

test("17. a decision attributed by configuration carries no sender, and the absence is the claim", async () => {
  const w = world(1, POLICY_UNMAPPED);
  const channel = channelFor();
  channel.onDecision(handlerFor(w.unit));
  await deliver(w, 0, channel);

  const outcome = await press(channel, w.keys[0] as string, "grant", { fromId: CARTER_ID });
  assert.ok(outcome?.ok === true, JSON.stringify(outcome));
  const payload = payloadOf(outcome.record);
  // The channel DID authenticate an account, and the record still carries
  // none: the policy maps no telegram sender, so the attribution came from the
  // listener's configuration and the log says so by omission.
  assert.equal("sender" in payload, false, JSON.stringify(payload));
  assert.equal("sender_source" in payload, false, JSON.stringify(payload));
  assert.equal(outcome.record.actor, LISTENER);

  const resolution = resolveSender(
    loadPolicyText("APPROVAL.md", POLICY_UNMAPPED),
    { channel: "telegram", id: CARTER_ID },
  );
  assert.equal(resolution.kind, "configured");
  assert.equal(resolution.kind === "configured" ? resolution.reason : "", "channel-unmapped");
  assertClean(w.unit);
});

test("18. every decision record names the channel that collected it", async () => {
  const w = world(2);
  const channel = channelFor();
  channel.onDecision(handlerFor(w.unit));
  await deliver(w, 0, channel);
  await press(channel, w.keys[0] as string, "grant", { fromId: CARTER_ID });

  const rejected = recordChannelDecision(
    w.unit.logPath,
    { action_key: w.keys[1] as string, decision: "reject", deliveryId: "cli-1", note: "no" },
    { actor: LISTENER, channel: "cli" },
    { ...w.unit.options, clock: fixedClock(at(2)) },
  );
  assert.ok(rejected.outcome.ok, JSON.stringify(rejected.outcome));

  const decisions = decisionRecords(w.unit);
  assert.equal(decisions.length, 2);
  for (const record of decisions) {
    assert.ok(
      typeof record.channel === "string" && record.channel.length > 0,
      `a decision record named no channel: ${JSON.stringify(record)}`,
    );
  }
  assert.deepEqual(decisions.map((record) => record.channel), ["telegram", "cli"]);
  assertClean(w.unit);
});

test("19. no record anywhere carries a Telegram username", async () => {
  const w = world(2);
  const channel = channelFor();
  channel.onDecision(handlerFor(w.unit));

  await deliver(w, 0, channel);
  await press(channel, w.keys[0] as string, "grant", { fromId: CARTER_ID, from: "carter_handle" });
  await deliver(w, 1, channel);
  await press(channel, w.keys[1] as string, "grant", { fromId: STRANGER_ID, from: "stranger_handle" });

  // The whole log as bytes, because a field that reads like identity and
  // decays into a lie could be anywhere in it.
  const raw = records(w.unit).map((record) => JSON.stringify(record)).join("\n");
  assert.equal(raw.includes("carter_handle"), false, "a username reached the log");
  assert.equal(raw.includes("stranger_handle"), false, "a username reached the log");
  assert.equal(raw.includes("username"), false, "a username field reached the log");
  // The ids did, which is the trade: an account id is not a credential, and an
  // operator investigating a refusal needs the number.
  assert.ok(raw.includes(`"id":"${STRANGER_ID}"`), "the observed id was not recorded");
  assertClean(w.unit);
});

// ---------------------------------------------------------------------------
// Unit coverage the nineteen lean on
// ---------------------------------------------------------------------------

test("the sender index inverts the policy's person-to-sender map and the refusal union is closed", () => {
  const load = loadPolicyText("APPROVAL.md", POLICY_MAPPED);
  assert.equal(load.ok, true, JSON.stringify(load));
  const index = load.ok ? senderIndex(load.policy.approvers) : new Map<string, string[]>();
  assert.deepEqual([...index.values()], [["carter"], ["dana"]]);
  assert.deepEqual(
    [...CHANNEL_DECISION_REFUSAL_CODES],
    ["sender-unmapped", "sender-ambiguous", "attest-requires-terminal"],
  );

  // An update with no readable id is not a sender to guess at.
  assert.equal(senderOf({}, "telegram"), undefined);
  assert.equal(senderOf({ from: { username: "carter" } }, "telegram"), undefined);
  assert.equal(senderOf({ from: { id: {} } }, "telegram"), undefined);
});

// ---------------------------------------------------------------------------
// The other three callback families (design §7a, added on review)
//
// A Telegram callback is routed to one of four handlers, and the first
// implementation resolved senders in one of them. These pin the other three.
// The checkpoint family's end-to-end signature lives in
// `tests/checkpoint-tap.test.ts`, which already holds a real signing key, and
// the review family's in `tests/channels-telegram.test.ts`, which already holds
// a sampled action; both are named here so the set is findable from one place.
// ---------------------------------------------------------------------------

test("20. the sender is read before the branch split, so a checkpoint tap carries it too", async () => {
  const w = world(1);
  const channel = channelFor();
  channel.onDecision(handlerFor(w.unit));

  // A stub handler that records only what the channel handed it. The claim is
  // about the CHANNEL: `senderOf` runs directly after the chat-id check, above
  // the branch that returns into this handler, so a gesture that never reaches
  // the decision ladder still arrives with the observation in hand. The review
  // branch is the same `const` two lines further down, and its end-to-end case
  // is in `tests/channels-telegram.test.ts`, where a sampled action and a real
  // review card already exist.
  let seen: ChannelSender | undefined;
  let calls = 0;
  channel.onCheckpoint((tap) => {
    seen = tap.sender;
    calls += 1;
    return { ok: true, headline: "SIGNED", detail: [], toast: "ok" };
  });

  await channel.offerCheckpoint({ head: { seq: 3, hash: "a".repeat(64) }, lines: ["sign it"] });
  mock.queueUpdate(
    callbackUpdate({ data: signButtonData(), chatId: CHAT, fromId: STRANGER_ID }),
  );
  await channel.pollOnce();

  assert.equal(calls, 1, "the checkpoint handler was not reached");
  assert.deepEqual(seen, { channel: "telegram", id: STRANGER_ID });
  // And a tap from a chat this listener does not answer to never gets that far,
  // because the chat check still runs first.
  await channel.offerCheckpoint({ head: { seq: 4, hash: "b".repeat(64) }, lines: ["again"] });
  mock.queueUpdate(
    callbackUpdate({ data: signButtonData(), chatId: "-100999", fromId: CARTER_ID }),
  );
  await channel.pollOnce();
  assert.equal(calls, 1, "a foreign chat reached the checkpoint handler");
});

// ---------------------------------------------------------------------------
// Attestation answers (design §7a): the privileged family, and the strict rule
// ---------------------------------------------------------------------------

test("21. a mapped sender attests as the mapped human when the amendment leaves the mapping alone", () => {
  const w = attested(POLICY_MAPPED, policyText({ senders: MAPPED, ttl: "48h" }));

  const result = tapAttestation(w, CARTER_ID);
  assert.ok(result.outcome.ok, JSON.stringify(result.outcome));
  assert.equal(result.outcome.record.event, "policy.updated");
  assert.equal(result.outcome.record.actor, "human:carter");
  assert.deepEqual(payloadOf(result.outcome.record)["sender"], {
    channel: "telegram",
    id: CARTER_ID,
  });
  assert.equal(payloadOf(result.outcome.record)["sender_source"], "policy");
  assertClean(w.unit);
});

test("22. an unmapped sender attests nothing, and the refusal names the account", () => {
  const w = attested(POLICY_MAPPED, policyText({ senders: MAPPED, ttl: "48h" }));

  const result = tapAttestation(w, STRANGER_ID);
  assert.equal(result.outcome.ok, false, JSON.stringify(result.outcome));
  assert.equal(result.outcome.ok === false ? result.outcome.code : "", "sender-unmapped");
  assert.equal(attestations(w.unit).length, 1, "a second policy.updated was appended");

  const refusal = refusals(w.unit);
  assert.equal(refusal.length, 1);
  assert.deepEqual(payloadOf(refusal[0] as EventRecord)["sender"], {
    channel: "telegram",
    id: STRANGER_ID,
  });
  assertClean(w.unit);
});

test("23. a proposal that ADDS a mapping cannot be attested from the phone by the account it adds", () => {
  // The attack the in-force rule exists for: edit the policy to name your own
  // account as an approver's sender, then tap Approve on your own amendment.
  const w = attested(POLICY_UNMAPPED, POLICY_MAPPED);

  const result = tapAttestation(w, CARTER_ID);
  assert.equal(result.outcome.ok, false, JSON.stringify(result.outcome));
  assert.equal(
    result.outcome.ok === false ? result.outcome.code : "",
    "attest-requires-terminal",
  );
  assert.equal(attestations(w.unit).length, 1, "the amendment was attested from the phone");
  assert.match(
    result.outcome.ok === false ? result.outcome.message : "",
    /cannot be signed for by the identity system it introduces/u,
  );
  assertClean(w.unit);
});

test("24. the terminal attests regardless: no sender, no rule, and the repair path stays open", () => {
  const w = attested(POLICY_UNMAPPED, POLICY_MAPPED);

  // The same amendment test 23 refused from a phone. A terminal authenticates
  // no sender, so it is never subject to a mapping — which is what keeps a
  // repository with a broken or hostile mapping repairable at all.
  const result = recordChannelDecision(
    w.unit.logPath,
    { action_key: w.actionKey, decision: "grant", deliveryId: "cli-1" },
    { actor: LISTENER, channel: "cli" },
    { ...w.unit.options, clock: fixedClock(at(4)) },
  );
  assert.ok(result.outcome.ok, JSON.stringify(result.outcome));
  assert.equal(result.outcome.record.actor, LISTENER);
  assert.equal("sender" in payloadOf(result.outcome.record), false);
  assert.equal(attestations(w.unit).length, 2);
  assertClean(w.unit);
});

test("25. with no mapping on either side, an attestation tap is byte-for-byte today's attribution", () => {
  const w = attested(POLICY_UNMAPPED, policyText({ ttl: "48h" }));

  const result = tapAttestation(w, CARTER_ID);
  assert.ok(result.outcome.ok, JSON.stringify(result.outcome));
  assert.equal(result.outcome.record.actor, LISTENER);
  const payload = payloadOf(result.outcome.record);
  assert.equal("sender" in payload, false, JSON.stringify(payload));
  assert.equal("sender_source" in payload, false, JSON.stringify(payload));
  assertClean(w.unit);
});

test("26. APRV-356: an amendment that REMOVES the mapping is decided against the in-force mapping", () => {
  // The APRV-324 residual, and the exact shape the task named: with the
  // in-force bytes unrecoverable, an amendment that removes a sender mapping is
  // indistinguishable from a policy that never had one, so the phone tap fell
  // back to refusing. A terminal attestation now binds its own bytes, so the
  // in-force policy is RECOVERED and read — it maps Carter — and the tap from
  // Carter's account is attributed to Carter, decided under the rules he is
  // actually named by.
  //
  // This assertion fails on the old behaviour, which is the point of it: the
  // whole chain here is attested at a terminal and never from a phone.
  const w = attestedFromTerminal(POLICY_MAPPED, POLICY_UNMAPPED);

  const result = tapAttestation(w, CARTER_ID);
  assert.ok(result.outcome.ok, JSON.stringify(result.outcome));
  assert.equal(result.outcome.record.actor, "human:carter");
  assert.equal(payloadOf(result.outcome.record)["sender_source"], "policy");
  assert.equal(attestations(w.unit).length, 2);
  assertClean(w.unit);
});

test("26a. the bootstrap refusal still stands, and now says WHY rather than that it cannot tell", () => {
  // The other direction, unchanged in verdict and changed in reason. An
  // amendment that INTRODUCES the mapping cannot be signed for by the mapping
  // it introduces, whatever the runtime can recover; before APRV-356 the
  // refusal said the in-force bytes were unrecoverable, and now it says the
  // policy in force maps nobody on this channel, which is a fact it read.
  const w = attestedFromTerminal(POLICY_UNMAPPED, POLICY_MAPPED);

  const result = tapAttestation(w, CARTER_ID);
  assert.equal(result.outcome.ok, false, JSON.stringify(result.outcome));
  assert.equal(
    result.outcome.ok === false ? result.outcome.code : "",
    "attest-requires-terminal",
  );
  assert.match(
    result.outcome.ok === false ? result.outcome.message : "",
    /the policy in force maps no telegram sender/u,
  );
  assert.equal(attestations(w.unit).length, 1);
  assertClean(w.unit);
});

test("26b. a chain attested BEFORE APRV-356 keeps the documented fail-closed fallback", () => {
  // A `policy.updated` with no `payload_hash` is what every attestation looked
  // like until this change, and logs full of them exist. It is written through
  // the REAL append path, with the payload the old verb composed, so what is
  // under test is a record the runtime actually wrote rather than a fabricated
  // one. Its bytes are unrecoverable, and the rule falls back to refusing.
  fixtureCounter += 1;
  const unit = newScenario(scratch.root, POLICY_UNMAPPED);
  const legacy = appendEvent(
    unit.logPath,
    {
      ts: at(0),
      event: "policy.updated",
      actor: LISTENER,
      payload: { policy_path: "APPROVAL.md", sha256: policyFileHash(unit.policyPath) },
    },
    unit.options,
  );
  assert.equal(legacy.ok, true, JSON.stringify(legacy));
  const w = proposeAmendment(unit, POLICY_MAPPED);

  const result = tapAttestation(w, CARTER_ID);
  assert.equal(result.outcome.ok, false, JSON.stringify(result.outcome));
  assert.equal(
    result.outcome.ok === false ? result.outcome.code : "",
    "attest-requires-terminal",
  );
  assert.match(
    result.outcome.ok === false ? result.outcome.message : "",
    /not recoverable/u,
  );
  assert.equal(attestations(w.unit).length, 1);
  assertClean(w.unit);
});

test("27. unrecoverable in-force bytes and no mapping in the amendment is today's behaviour", () => {
  const w = attestedFromTerminal(POLICY_UNMAPPED, policyText({ ttl: "48h" }));

  const result = tapAttestation(w, CARTER_ID);
  assert.ok(result.outcome.ok, JSON.stringify(result.outcome));
  assert.equal(result.outcome.record.actor, LISTENER);
  assert.equal("sender" in payloadOf(result.outcome.record), false);
  assertClean(w.unit);
});

test("29. a policy that does not load refuses a sender-bearing tap, and the terminal still decides", async () => {
  // Not the ambiguous-mapping case, which is a load failure this feature
  // authors: an ordinary broken policy, the kind a typo produces. A failed load
  // is not "a policy with no mapping" — it is a policy the runtime could not
  // read — so a sender it cannot resolve is refused rather than attributed to
  // whoever the listener happens to be running as.
  const w = world(2);
  const channel = channelFor();
  channel.onDecision(handlerFor(w.unit));
  await deliver(w, 0, channel);

  writePolicy(w.unit, POLICY_MAPPED.replace("classes:", "classes:\n  nope: [this is not a rule]"));
  const broken = loadPolicyText(w.unit.policyPath, readPolicy(w.unit));
  assert.equal(broken.ok, false, "the fixture policy still loads");
  assert.notEqual(broken.ok === false ? broken.code : "", "sender-ambiguous");

  const outcome = await press(channel, w.keys[0] as string, "grant", { fromId: CARTER_ID });
  assert.ok(outcome !== undefined && outcome.ok === false, JSON.stringify(outcome));
  assert.equal(outcome.code, "sender-unmapped");
  assert.match(outcome.message, /could not be loaded/u);
  assert.equal(decisionRecords(w.unit).length, 0);
  assert.deepEqual(payloadOf(refusals(w.unit)[0] as EventRecord)["sender"], {
    channel: "telegram",
    id: CARTER_ID,
  });

  // And the repair path is open: a terminal supplies no sender, so it is never
  // subject to a mapping the runtime cannot read. It is refused for the reason
  // a broken policy refuses everything — `policy-not-attested`, because the
  // edit is unattested — and NOT for the identity, which is the distinction
  // that keeps a repository fixable through its own gate.
  const terminal = recordChannelDecision(
    w.unit.logPath,
    { action_key: w.keys[1] as string, decision: "reject", deliveryId: "cli-1", note: "no" },
    { actor: LISTENER, channel: "cli" },
    { ...w.unit.options, clock: fixedClock(at(2)) },
  ).outcome;
  assert.ok(terminal.ok, JSON.stringify(terminal));
  assert.equal(terminal.record.actor, LISTENER);
  assertClean(w.unit);
});

test("28. the in-force bytes are recovered only when they hash to the attestation", () => {
  const w = attested(POLICY_MAPPED, policyText({ senders: MAPPED, ttl: "48h" }));
  const store = payloadStoreDirFor(w.unit.logPath);

  const recovered = inForcePolicyText(verifiedRecords(w.unit.logPath), store);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.ok ? recovered.text : "", POLICY_MAPPED);

  // Nothing here trusts the store: a payload swapped under the runtime's feet
  // is a recovery failure, not a different policy wearing the attested hash.
  const swapped = inForcePolicyText(verifiedRecords(w.unit.logPath), tamperedStore(w.unit, store));
  assert.equal(swapped.ok, false);
  assert.match(swapped.ok ? "" : swapped.reason, /not recoverable/u);
});

// ---------------------------------------------------------------------------
// Helpers used above
// ---------------------------------------------------------------------------

/** What the Telegram channel reports for one tap by `id`. */
function senderDecision(actionKey: string, id: string): ChannelDecision {
  return {
    action_key: actionKey,
    decision: "grant",
    deliveryId: `tg-${id}`,
    sender: { channel: "telegram", id },
  };
}

/**
 * Gate options whose policy read runs `effect` on its `nth` call.
 *
 * The seam is `GateOptions.policy.read`, documented as the one read a gate
 * operation makes and provided so a test can prove a mid-operation swap cannot
 * land. Here it is used for its timing rather than its bytes: the bytes are
 * always the attested ones, and the effect lands in the window between the
 * gate's read of the log and its append. Call 1 is the sender resolution's own
 * read in `channels/contract.ts`; call 2 is the first `decide` attempt's,
 * which is the one that matters.
 */
function injectAt(unit: Scenario, nth: number, effect: () => void): { policy: { file: string; read: (path: string) => Uint8Array } } {
  const bytes = Buffer.from(readPolicy(unit), "utf8");
  let call = 0;
  let fired = false;
  return {
    policy: {
      file: unit.policyPath,
      read: () => {
        call += 1;
        if (call === nth && !fired) {
          fired = true;
          effect();
        }
        return bytes;
      },
    },
  };
}

function readPolicy(unit: Scenario): string {
  return readFileSync(unit.policyPath, "utf8");
}

function writePolicy(unit: Scenario, text: string): void {
  writeFileSync(unit.policyPath, text, "utf8");
}

/** The mapping both fixture people carry, so an amendment can leave it alone. */
const MAPPED: Record<string, string> = { carter: CARTER_ID, dana: DANA_ID };

interface AttestationWorld {
  unit: Scenario;
  /** `policy.attest:<sha256>` of the amendment awaiting an answer. */
  actionKey: string;
}

/**
 * A log whose policy in force was attested THROUGH THE PHONE, with an
 * amendment proposed and waiting.
 *
 * The ceremony is run for real, twice, because the in-force bytes are
 * recoverable only as a side effect of the first run: `proposeAttestation`
 * binds the whole policy text into the payload store, so the proposal that was
 * attested is what makes the attested bytes addressable afterwards.
 */
function attested(before: string, after: string): AttestationWorld {
  fixtureCounter += 1;
  const unit = newScenario(scratch.root, before);

  const first = proposeAttestation(
    unit.logPath,
    { policyPath: unit.policyPath, waitUntil: at(10_000) },
    AGENT,
    { ...unit.options, clock: fixedClock(at(0)) },
  );
  assert.ok(first.ok, `proposal failed: ${JSON.stringify(first)}`);
  const signed = decideAttestation(unit.logPath, first.record.seq, "attest", LISTENER, {
    ...unit.options,
    policyPath: unit.policyPath,
    clock: fixedClock(at(1)),
  });
  assert.ok(signed.ok, `attestation failed: ${JSON.stringify(signed)}`);

  return proposeAmendment(unit, after);
}

/**
 * The same, with the policy in force attested at a TERMINAL — so its bytes were
 * never stored and cannot be recovered.
 *
 * This is the ordinary shape of a chain that has never been amended from a
 * phone, including this repository's own.
 */
function attestedFromTerminal(before: string, after: string): AttestationWorld {
  fixtureCounter += 1;
  const unit = newScenario(scratch.root, before);
  attestPolicy(unit);
  return proposeAmendment(unit, after);
}

/** Edit the policy to `after` and put the amendment in front of a human. */
function proposeAmendment(unit: Scenario, after: string): AttestationWorld {
  writePolicy(unit, after);
  const proposal = proposeAttestation(
    unit.logPath,
    { policyPath: unit.policyPath, waitUntil: at(10_000) },
    AGENT,
    { ...unit.options, clock: fixedClock(at(2)) },
  );
  assert.ok(proposal.ok, `amendment proposal failed: ${JSON.stringify(proposal)}`);
  const actionKey = proposal.record.action_key;
  assert.ok(typeof actionKey === "string" && actionKey.length > 0);
  return { unit, actionKey };
}

/** Tap Approve on the waiting amendment, as `fromId`. */
function tapAttestation(w: AttestationWorld, fromId: string): ChannelDecisionResult {
  return recordChannelDecision(
    w.unit.logPath,
    {
      action_key: w.actionKey,
      decision: "grant",
      deliveryId: `tg-${fromId}`,
      sender: { channel: "telegram", id: fromId },
    },
    { actor: LISTENER, channel: "telegram" },
    { ...w.unit.options, clock: fixedClock(at(3)) },
  );
}

function attestations(unit: Scenario): EventRecord[] {
  return records(unit).filter((record) => record.event === "policy.updated");
}

/** A store directory holding the same payload names and different bytes. */
function tamperedStore(unit: Scenario, from: string): string {
  const to = join(dirname(unit.logPath), "tampered-payloads");
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const raw = readFileSync(join(from, name), "utf8");
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value["text"] === "string") value["text"] = `${value["text"]}\n<!-- swapped -->\n`;
    writeFileSync(join(to, name), JSON.stringify(value), "utf8");
  }
  return to;
}

/** Read the verified chain, for the cases that assert over records directly. */
function verifiedRecords(logPath: string): EventRecord[] {
  const read = readVerifiedRecords(logPath);
  assert.equal(read.ok, true, `log did not verify: ${JSON.stringify(read)}`);
  return read.ok ? read.records : [];
}

/**
 * The `callback_data` of the newest `Sign` button the mock received.
 *
 * Read off the keyboard exactly as a phone would: nothing here decodes a
 * nonce, and the newest keyboard wins because a redraw replaces the buttons.
 */
function signButtonData(): string {
  for (let index = mock.requests.length - 1; index >= 0; index -= 1) {
    const entry = mock.requests[index];
    if (entry === undefined || entry.method !== "sendMessage") continue;
    const markup = entry.body["reply_markup"] as
      | { inline_keyboard?: { text: string; callback_data: string }[][] }
      | undefined;
    for (const row of markup?.inline_keyboard ?? []) {
      const sign = row.find((button) => button.text === "Sign");
      if (sign !== undefined) return sign.callback_data;
    }
  }
  throw new Error("the mock received no checkpoint prompt");
}
