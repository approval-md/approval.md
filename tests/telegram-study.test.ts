/**
 * The "Looks wrong" button (APRV-528, amended SPEC.md §8 the study record).
 *
 * Off is the regression guard, so it comes first: with study mode off every
 * Bot API call a card flow makes is byte-identical to golden files captured at
 * the base (origin/main ab83fab1) before study mode existed, and a `w:`
 * callback is the malformed callback it always was. On, both per-request card
 * styles carry one extra row with one button, and a tap on it is the
 * resident's ordinary Deny with `payload.study {looks_wrong}` recorded.
 *
 * The world-backed cases build the log through the real gate and decide
 * through `recordChannelDecision`. Every Bot API call goes to an injected
 * recorder, or to the local mock in `tests/telegram-mock.ts` for the case that
 * goes through `prepareListen`; nothing here reaches the network.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { computed, recordChannelDecision, type ChannelDecision, type ChannelRequest } from "../src/channels/contract.js";
import { buildPendingQueue, type TagOptions } from "../src/channels/tagging.js";
import {
  actionRefOf,
  callbackData,
  parseCallbackData,
  studyLogRefOf,
  TELEGRAM_LOOKS_WRONG_HEADLINE,
  TELEGRAM_LOOKS_WRONG_LABEL,
  TELEGRAM_MAX_CALLBACK_BYTES,
  TELEGRAM_TERMINAL_HEADLINES,
  type TelegramChannel,
} from "../src/channels/telegram.js";
import { prepareListen, STUDY_MODE_ENV, studyModeFor } from "../src/cli/channel-telegram.js";
import { canonicalize } from "../src/core/jcs.js";
import { attestationActionKey } from "../src/core/policy-proposal.js";
import { payloadHash } from "../src/core/payload.js";
import { readVerifiedRecords, requestState } from "../src/core/state.js";
import { decide, register, request } from "./clock-adapters.js";
import { assertClean, at, attest, fixedClock, newScenario, payloadOf, records, scratchRoot, T0, type Scenario } from "./scenario.js";
import { assertLocal, startMockBotApi, type MockBotApi } from "./telegram-mock.js";
import {
  buttonData,
  MINI_KEY,
  STUDY_SAY,
  studyFlows,
  studyRecordingChannel,
  studyRequest,
  studyTap,
  TECH_KEY,
  type StudyCall,
} from "./telegram-study-cards.js";

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GOLDEN = join(REPO_ROOT, "tests", "fixtures", "telegram-study");

const scratch = scratchRoot("telegram-study");
let mock: MockBotApi;
const TOKEN = "7654321:AA-approval-md-fake-token-for-study-tests-only";

before(async () => {
  mock = await startMockBotApi(TOKEN);
});
after(async () => {
  await mock.close();
  scratch.cleanup();
});

type Keyboard = { text: string; callback_data: string }[][];

function keyboardOf(call: StudyCall | undefined): Keyboard {
  return ((call?.body["reply_markup"] as { inline_keyboard?: Keyboard } | undefined)?.inline_keyboard ?? []) as Keyboard;
}

/** The last sendMessage carrying a keyboard: where a per-request card's buttons ride. */
function armed(calls: StudyCall[]): StudyCall | undefined {
  return calls.filter((call) => call.method === "sendMessage" && call.body["reply_markup"] !== undefined).at(-1);
}

// ---------------------------------------------------------------------------
// Flag off: byte-identical
// ---------------------------------------------------------------------------

test("G2-1 flag off: the Bot API calls for a technical card, a minimal card and a digest are byte-identical to golden files captured at the base", async () => {
  // Absent, explicitly false, and every non-`true` value a caller might pass:
  // only an explicit `true` turns study mode on.
  for (const extra of [{}, { study: false }, { study: "1" }, { study: 1 }, { study: "true" }]) {
    const flows = await studyFlows(extra);
    for (const name of ["technical", "minimal", "digest", "w-callback"]) {
      const golden = readFileSync(join(GOLDEN, `${name}.golden.jsonl`), "utf8");
      assert.equal(flows[name], golden, `${name} with ${JSON.stringify(extra)} differs from the base`);
    }
  }
});

test("G2-2 flag off: a w: callback is malformed-callback and nothing is decided (as at the base)", async () => {
  const data = callbackData("w", "n1", TECH_KEY);
  assert.equal(parseCallbackData(data), null);
  assert.equal(parseCallbackData(data, false), null);

  const live = world(1);
  const { channel, calls } = studyRecordingChannel();
  let decided = 0;
  channel.onDecision((decision) => {
    decided += 1;
    return live.handler(decision);
  });
  for (const request_ of live.requests) await channel.notify(request_);
  const reject = buttonData(calls, "r:", live.keys[0]!) ?? assert.fail("no reject button");
  const before = logBytes(live.unit);
  const result = await channel.deliverUpdate(studyTap(1, `w${reject.slice(1)}`));
  assert.deepEqual(result.ignored.map((entry) => entry.kind), ["malformed-callback"]);
  assert.equal(channel.anomalyCount("malformed-callback"), 1);
  assert.equal(decided, 0, "a w: callback reached the decision handler with the flag off");
  assert.equal(logBytes(live.unit), before);
  assert.equal(calls.filter((call) => call.method === "editMessageText").length, 0, "the card was edited");
});

// ---------------------------------------------------------------------------
// Flag on: the button
// ---------------------------------------------------------------------------

test("G2-3 flag on: both card styles carry a second row with exactly one Looks wrong button; the first row is byte-identical to the off card's", async () => {
  const tech = studyRequest("network.call", TECH_KEY, { command: "curl https://example.org", cwd: "/home/hermes" }, "Terminal: curl example.org");
  const mini = studyRequest("intent.publish.inferred.index", MINI_KEY, { text: "Badminton on Sunday?" }, "inferred from chat");
  for (const [request_, style] of [
    [tech, {}],
    [mini, { promptStyle: "minimal", say: STUDY_SAY }],
  ] as const) {
    const off = studyRecordingChannel(style);
    const on = studyRecordingChannel({ ...style, study: true });
    await off.channel.notify(request_);
    await on.channel.notify(request_);
    const offRows = keyboardOf(armed(off.calls));
    const onRows = keyboardOf(armed(on.calls));
    assert.equal(offRows.length, 1, "the off card grew a row");
    assert.equal(onRows.length, 2, "the on card does not carry exactly one extra row");
    assert.equal(canonicalize(onRows[0]), canonicalize(offRows[0]), "the Approve/Reject row changed");
    assert.deepEqual(onRows[1], [
      { text: TELEGRAM_LOOKS_WRONG_LABEL, callback_data: callbackData("w", "n1", request_.action_key.value) },
    ]);
    // Every other byte of every call is the off card's.
    const strip = (calls: StudyCall[]) =>
      calls.map((call) => {
        const body = { ...call.body };
        if (body["reply_markup"] !== undefined) body["reply_markup"] = { inline_keyboard: keyboardOf(call).slice(0, 1) };
        return canonicalize({ method: call.method, body });
      });
    assert.deepEqual(strip(on.calls), strip(off.calls));
  }
  // The label, as the spec writes it: U+1F6A9, a space, "Looks wrong".
  assert.deepEqual([...TELEGRAM_LOOKS_WRONG_LABEL].map((ch) => ch.codePointAt(0)), [0x1f6a9, ...[..." Looks wrong"].map((ch) => ch.codePointAt(0))]);
});

test("G2-3c flag on: a policy attestation prompt carries no Looks wrong button, by its policy_diff or by its policy.attest: key; an ordinary card still does (APRV-528)", async () => {
  const diff = "-autonomy: manual\n+autonomy: autonomous";
  const attestKey = attestationActionKey("ef".repeat(32));
  const base = studyRequest("policy.edit", attestKey, { policy: "APPROVAL.md" }, "policy proposal");
  const prompts: [string, ChannelRequest][] = [
    ["a proposal (policy_diff and a policy.attest: key)", { ...base, policy_diff: computed(diff, "policy") }],
    ["a policy.attest: key alone", base],
    ["a policy_diff alone", { ...studyRequest("policy.edit", "task-g2:proposal", { policy: "APPROVAL.md" }, "policy proposal"), policy_diff: computed(diff, "policy") }],
  ];
  for (const style of [{}, { promptStyle: "minimal", say: STUDY_SAY }] as const) {
    for (const [name, request_] of prompts) {
      const on = studyRecordingChannel({ ...style, study: true });
      await on.channel.notify(request_);
      const rows = keyboardOf(armed(on.calls));
      assert.equal(rows.length, 1, `${name} (${JSON.stringify(style)}) drew a study row`);
      assert.ok(
        rows.flat().every((button) => !button.callback_data.startsWith("w:") && button.text !== TELEGRAM_LOOKS_WRONG_LABEL),
        `${name} (${JSON.stringify(style)}) carries a Looks wrong button`,
      );
    }
    // The control: an ordinary action card on the same study channel keeps the row.
    const ordinary = studyRequest("network.call", TECH_KEY, { command: "curl https://example.org", cwd: "/home/hermes" }, "Terminal: curl example.org");
    const on = studyRecordingChannel({ ...style, study: true });
    await on.channel.notify(ordinary);
    assert.deepEqual(keyboardOf(armed(on.calls))[1], [
      { text: TELEGRAM_LOOKS_WRONG_LABEL, callback_data: callbackData("w", "n1", TECH_KEY) },
    ]);
  }
});

test("G2-3b flag on: a digest card carries no Looks wrong button (v1, spec Q3)", async () => {
  const requests = ["task-g2:digest-1", "task-g2:digest-2"].map((key, index) =>
    studyRequest("communicate.email.external", key, { to: [`v${String(index)}@vendor.example`], subject: "chaser" }, "chase"),
  );
  const on = studyRecordingChannel({ study: true });
  const delivery = await on.channel.notifyBatch({ requests });
  assert.ok(delivery.digestId !== null, "the fixture did not form a digest");
  for (const call of on.calls) {
    for (const row of keyboardOf(call)) {
      for (const button of row) {
        assert.ok(!button.callback_data.startsWith("w:"), "a digest carried a w button");
        assert.notEqual(button.text, TELEGRAM_LOOKS_WRONG_LABEL);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Flag on: the tap
// ---------------------------------------------------------------------------

const HUMAN = "human:carter";
const MAPPED_ID = "42";
const UNMAPPED_ID = "777";
const AGENT = "agent:hermes";
const TASK = "task-g2";
const CLS = "communicate.email.external";

/** Carter's telegram account is mapped; one action a day, so a charged budget would show. */
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
  `      telegram: "${MAPPED_ID}"`,
  "classes:",
  `  ${CLS}:`,
  "    autonomy: manual",
  "    limits:",
  "      per_action_usd: 1",
  "      daily_actions: 1",
  "```",
  "",
].join("\n");

interface World {
  unit: Scenario;
  keys: string[];
  requests: ChannelRequest[];
  tagOptions: TagOptions;
  handler: (decision: ChannelDecision) => ReturnType<typeof recordChannelDecision>["outcome"];
}

function world(count: number): World {
  const unit = newScenario(scratch.root, POLICY);
  attest(unit, T0);
  const keys = Array.from({ length: count }, (_, index) => `${TASK}:send-${String(index)}`);
  const payloads = new Map(keys.map((key, index) => [key, { to: [`v${String(index)}@vendor.example`], subject: "s" }]));
  const registered = register(
    unit.logPath,
    {
      task: TASK,
      envelope: {
        origin: { app: "manual", created_by: AGENT },
        state: "awaiting",
        actions: keys.map((key) => ({
          class: CLS,
          idempotency_key: key,
          summary: "s",
          reversible: false,
          est_cost_usd: "0.5",
          payload_hash: payloadHash(payloads.get(key)),
        })),
      },
    },
    T0,
    AGENT,
    unit.options,
  );
  assert.equal(registered.ok, true, JSON.stringify(registered));
  for (const key of keys) {
    const requested = request(
      unit.logPath,
      { task: TASK, actionKey: key, cls: CLS, est_cost_usd: "0.5", reversible: false, summary: "s", payload_hash: payloadHash(payloads.get(key)) },
      at(1),
      AGENT,
      unit.options,
    );
    assert.equal(requested.ok, true, JSON.stringify(requested));
  }
  const tagOptions: TagOptions = { policy: { file: unit.policyPath }, payload: (key) => payloads.get(key) };
  const queue = buildPendingQueue(unit.logPath, tagOptions, at(2));
  assert.equal(queue.ok, true, JSON.stringify(queue));
  return {
    unit,
    keys,
    requests: queue.ok ? queue.requests : [],
    tagOptions,
    handler: (decision) =>
      recordChannelDecision(unit.logPath, decision, { actor: HUMAN, channel: "telegram" }, {
        ...unit.options,
        clock: fixedClock(at(3)),
      }).outcome,
  };
}

const logBytes = (unit: Scenario): string => readFileSync(unit.logPath, "utf8");

function stateOf(unit: Scenario, key: string): string {
  const read = readVerifiedRecords(unit.logPath);
  assert.equal(read.ok, true);
  return read.ok ? requestState(read.records, key, at(5), null).state : "unreadable";
}

/** A live study-mode world: every request delivered on its own card. */
async function studyWorld(count: number, extra: Record<string, unknown> = {}) {
  const live = world(count);
  const recorder = studyRecordingChannel({ study: true, ...extra });
  recorder.channel.onDecision(live.handler);
  for (const request_ of live.requests) await recorder.channel.notify(request_);
  return { live, ...recorder };
}

async function tapFlag(channel: TelegramChannel, calls: StudyCall[], key: string, update: number, fromId: string = MAPPED_ID) {
  const data = buttonData(calls, "w:", key) ?? assert.fail(`no Looks wrong button for ${key}`);
  return channel.deliverUpdate(studyTap(update, data, fromId));
}

test("G2-4 flag on: a looks_wrong tap records approval.rejected with payload.study {looks_wrong}, actor from the sender mapping, no budget charged; the annotation reads SKIPPED; approval log verify passes", async () => {
  const { live, channel, calls } = await studyWorld(2);
  const [flagged, next] = live.keys as [string, string];
  const before = records(live.unit).length;

  const result = await tapFlag(channel, calls, flagged, 1);
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0]?.outcome.ok, true, JSON.stringify(result.outcomes[0]?.outcome));
  const appended = records(live.unit).slice(before);
  assert.deepEqual(appended.map((record) => record.event), ["approval.rejected"], "a tap appended anything but one rejection");
  const record = appended[0]!;
  assert.equal(record.action_key, flagged);
  assert.equal(record.actor, HUMAN, "the actor did not come from the sender mapping");
  assert.equal(record.channel, "telegram");
  const payload = payloadOf(record);
  assert.deepEqual(payload["study"], { reason: "looks_wrong" });
  assert.deepEqual(payload["sender"], { channel: "telegram", id: MAPPED_ID });
  assert.equal(payload["sender_source"], "policy");
  assert.match(String(payload["note"]), /^rejected via telegram \(callback cb-1\)$/u, "the note is not a Deny's");
  for (const field of ["class", "est_cost_usd", "token_sha256", "payload_hash", "reaction"]) {
    assert.equal(field in payload, false, `a reject carried ${field}`);
  }
  assert.equal(stateOf(live.unit, flagged), "rejected", "the agent does not see a plain deny");

  // The card settles on the SKIPPED headline and loses its buttons.
  const edit = calls.filter((call) => call.method === "editMessageText").at(-1);
  assert.ok(String(edit?.body["text"]).startsWith(`<b>${TELEGRAM_LOOKS_WRONG_HEADLINE}</b>`), String(edit?.body["text"]));
  assert.equal(edit?.body["reply_markup"], undefined);

  // No budget was charged: the class allows ONE action a day, and the next
  // request can still be granted.
  const granted = decide(live.unit.logPath, next, "grant", HUMAN, at(4), { ...live.unit.options, channel: "cli" });
  assert.equal(granted.ok, true, `the looks_wrong reject charged the budget: ${JSON.stringify(granted)}`);
  assertClean(live.unit);
});

test("G2-4b flag on: an ordinary Reject tap on a study card is unchanged (no study key, the REJECTED headline)", async () => {
  const { live, channel, calls } = await studyWorld(1);
  const key = live.keys[0]!;
  const data = buttonData(calls, "r:", key) ?? assert.fail("no reject button");
  await channel.deliverUpdate(studyTap(1, data, MAPPED_ID));
  const record = records(live.unit).find((entry) => entry.event === "approval.rejected");
  assert.ok(record !== undefined);
  assert.equal("study" in payloadOf(record), false);
  const edit = calls.filter((call) => call.method === "editMessageText").at(-1);
  assert.ok(String(edit?.body["text"]).startsWith(`<b>${TELEGRAM_TERMINAL_HEADLINES.rejected}</b>`));
  assertClean(live.unit);
});

test("G2-5 a looks_wrong tap from an unmapped account is refused sender-unmapped, exactly as a Deny tap is", async () => {
  const flagged = await studyWorld(1);
  const denied = await studyWorld(1);
  const flagResult = await tapFlag(flagged.channel, flagged.calls, flagged.live.keys[0]!, 1, UNMAPPED_ID);
  const denyData = buttonData(denied.calls, "r:", denied.live.keys[0]!) ?? assert.fail("no reject button");
  const denyResult = await denied.channel.deliverUpdate(studyTap(1, denyData, UNMAPPED_ID));

  const code = (result: typeof flagResult) => {
    const outcome = result.outcomes[0]?.outcome;
    return outcome !== undefined && !outcome.ok ? outcome.code : "";
  };
  assert.equal(code(flagResult), "sender-unmapped");
  assert.equal(code(denyResult), "sender-unmapped");
  const tail = (w: World) =>
    records(w.unit)
      .slice(-1)
      .map((record) => ({ event: record.event, actor: record.actor, sender: payloadOf(record)["sender"], decision: payloadOf(record)["decision"] }));
  assert.deepEqual(tail(flagged.live), tail(denied.live), "the refusal record differs from a Deny's");
  assert.equal(records(flagged.live.unit).some((record) => record.event === "approval.rejected"), false);
  assert.equal(stateOf(flagged.live.unit, flagged.live.keys[0]!), "requested");
  assertClean(flagged.live.unit);
});

test("G2-6 the stderr line carries the 12-hex ref only (no key, no chat id, no sender id)", async () => {
  const { live, channel, calls, complaints } = await studyWorld(1);
  const key = live.keys[0]!;
  await tapFlag(channel, calls, key, 1);
  const lines = complaints.filter((line) => line.includes("looks_wrong"));
  assert.deepEqual(lines, [`approval: telegram looks_wrong ref=${studyLogRefOf(key)}`]);
  assert.match(lines[0]!, /^approval: telegram looks_wrong ref=[0-9a-f]{12}$/u);
  assert.equal(studyLogRefOf(key), actionRefOf(key).slice(0, 12));
  for (const line of complaints) {
    assert.equal(line.includes(key), false, `a line named the key: ${line}`);
    assert.equal(line.includes("9911"), false, `a line named the chat: ${line}`);
    assert.equal(new RegExp(`\\b${MAPPED_ID}\\b`, "u").test(line), false, `a line named the sender: ${line}`);
  }
});

test("G2-7 callback_data for w stays <= 64 bytes at the longest nonce, with the reference kept, and is as long as r's", () => {
  // The listener's own nonce: a base-36 counter plus 12 base64url characters
  // (constructor of TelegramChannel). At the largest counter a process could reach:
  const nonce = `${Number.MAX_SAFE_INTEGER.toString(36)}${"A".repeat(12)}`;
  for (const key of ["k", "hook:s1:tc1:network.call", "x".repeat(400)]) {
    const w = callbackData("w", nonce, key);
    const r = callbackData("r", nonce, key);
    assert.ok(Buffer.byteLength(w, "utf8") <= TELEGRAM_MAX_CALLBACK_BYTES, w);
    assert.equal(Buffer.byteLength(w, "utf8"), Buffer.byteLength(r, "utf8"));
    assert.ok(w.endsWith(`:${actionRefOf(key)}`), "the w button dropped its reference");
    assert.deepEqual(parseCallbackData(w, true), {
      decision: "reject",
      scope: "one",
      nonce,
      actionRef: actionRefOf(key),
      flag: "looks_wrong",
    });
  }
  assert.equal(TELEGRAM_MAX_CALLBACK_BYTES, 64);
});

// ---------------------------------------------------------------------------
// Never touches an already-decided card
// ---------------------------------------------------------------------------

test("G2-8 a Looks wrong tap on a card already decided is refused and appends nothing (settled card, restarted listener)", async () => {
  // (a) The card this listener settled: a Reject tap settles it, and the
  // Looks wrong button on the same card is then dead.
  {
    const { live, channel, calls } = await studyWorld(1);
    const key = live.keys[0]!;
    const flag = buttonData(calls, "w:", key) ?? assert.fail("no Looks wrong button");
    const grant = buttonData(calls, "g:", key) ?? assert.fail("no Approve button");
    await channel.deliverUpdate(studyTap(1, grant, MAPPED_ID));
    assert.equal(stateOf(live.unit, key), "granted");
    const before = logBytes(live.unit);
    const result = await channel.deliverUpdate(studyTap(2, flag, MAPPED_ID));
    assert.deepEqual(result.outcomes, [], "a tap on a settled card reached the gate");
    // The settle edit forgot the card's nonces; the button's reference finds no
    // live delivery, and the log (not this card) says what happened.
    assert.deepEqual(result.ignored.map((entry) => entry.kind), ["stale-copy"]);
    assert.equal(logBytes(live.unit), before, "a tap on a settled card appended");
    assert.equal(stateOf(live.unit, key), "granted");
  }
  // (b) A restarted listener holding nothing, the request decided meanwhile:
  // the stale copy's tap is answered from the log and decides nothing.
  {
    const { live, calls } = await studyWorld(1);
    const key = live.keys[0]!;
    const flag = buttonData(calls, "w:", key) ?? assert.fail("no Looks wrong button");
    const granted = decide(live.unit.logPath, key, "grant", HUMAN, at(3), { ...live.unit.options, channel: "cli" });
    assert.equal(granted.ok, true, JSON.stringify(granted));
    const restarted = studyRecordingChannel({ study: true, describeAction: () => "Already decided." });
    let decided = 0;
    restarted.channel.onDecision((decision) => {
      decided += 1;
      return live.handler(decision);
    });
    const before = logBytes(live.unit);
    const result = await restarted.channel.deliverUpdate(studyTap(1, flag, MAPPED_ID));
    assert.deepEqual(result.ignored.map((entry) => entry.kind), ["stale-copy"]);
    assert.equal(decided, 0);
    assert.equal(logBytes(live.unit), before, "a stale copy's tap appended");
    assert.equal(stateOf(live.unit, key), "granted");
  }
});

test("G2-8b a Looks wrong tap that races a decision made elsewhere never adds a rejection: the first answer stands, exactly as for a Deny", async () => {
  // The card is still live on this listener (the dispatch sweep has not yet
  // edited it) when a terminal grants the request. The gate refuses the tap
  // already-decided; like a Deny, the surface records the spent attention as
  // one audit-tier refusal and never an approval record.
  const flagged = await studyWorld(1);
  const denied = await studyWorld(1);
  for (const w of [flagged, denied]) {
    const granted = decide(w.live.unit.logPath, w.live.keys[0]!, "grant", HUMAN, at(3), { ...w.live.unit.options, channel: "cli" });
    assert.equal(granted.ok, true, JSON.stringify(granted));
  }
  const flagBefore = records(flagged.live.unit).length;
  const denyBefore = records(denied.live.unit).length;
  const flagResult = await tapFlag(flagged.channel, flagged.calls, flagged.live.keys[0]!, 1);
  const denyData = buttonData(denied.calls, "r:", denied.live.keys[0]!) ?? assert.fail("no reject button");
  await denied.channel.deliverUpdate(studyTap(1, denyData, MAPPED_ID));

  const outcome = flagResult.outcomes[0]?.outcome;
  assert.equal(outcome?.ok, false);
  assert.equal(outcome !== undefined && !outcome.ok ? outcome.code : "", "already-decided");
  const flagAppended = records(flagged.live.unit).slice(flagBefore).map((record) => record.event);
  const denyAppended = records(denied.live.unit).slice(denyBefore).map((record) => record.event);
  assert.deepEqual(flagAppended, denyAppended, "the race appends differently from a Deny's");
  assert.equal(flagAppended.some((event) => event.startsWith("approval.")), false, "a decided request gained an approval record");
  assert.equal(stateOf(flagged.live.unit, flagged.live.keys[0]!), "granted");
  assert.equal(complaintsWithFlag(flagged.complaints), 0, "a refused tap logged a detection line");
  assertClean(flagged.live.unit);
});

function complaintsWithFlag(lines: string[]): number {
  return lines.filter((line) => line.includes("looks_wrong")).length;
}

// ---------------------------------------------------------------------------
// The flag is read at launch only
// ---------------------------------------------------------------------------

test("G2-9 APPROVAL_STUDY_MODE is exactly 1, read once by prepareListen; changing it afterwards changes nothing", async () => {
  assert.equal(STUDY_MODE_ENV, "APPROVAL_STUDY_MODE");
  assert.equal(studyModeFor({ APPROVAL_STUDY_MODE: "1" }), true);
  for (const value of [undefined, "", "0", "true", "yes", " 1", "1 ", "01", "on"]) {
    assert.equal(studyModeFor(value === undefined ? {} : { APPROVAL_STUDY_MODE: value }), false, JSON.stringify(value));
  }

  const firstButtonRows = async (envValue: string | undefined, flipTo: string | undefined): Promise<number> => {
    const live = world(1);
    const saved = process.env[STUDY_MODE_ENV];
    process.env["APPROVAL_TG_TOKEN"] = TOKEN;
    process.env["APPROVAL_TG_CHAT"] = "9911";
    process.env["APPROVAL_HUMAN"] = HUMAN;
    if (envValue === undefined) delete process.env[STUDY_MODE_ENV];
    else process.env[STUDY_MODE_ENV] = envValue;
    let setup;
    try {
      const prepared = prepareListen({
        logPath: live.unit.logPath,
        policy: { file: live.unit.policyPath },
        as: null,
        payloads: null,
        apiBase: assertLocal(mock.url),
        pollTimeout: null,
        once: true,
        json: false,
        allowCrossInstance: true,
        log: () => {},
      });
      if (!prepared.ok) assert.fail(`prepareListen refused: ${JSON.stringify(prepared)}`);
      setup = prepared.setup;
      // The flip happens AFTER launch and before the card is drawn.
      if (flipTo === undefined) delete process.env[STUDY_MODE_ENV];
      else process.env[STUDY_MODE_ENV] = flipTo;
      const from = mock.sentMessages().length;
      await setup.channel.notify(live.requests[0]!);
      const sent = mock.sentMessages().slice(from);
      const card = sent.filter((entry) => entry.replyMarkup !== undefined).at(-1);
      return ((card?.replyMarkup as { inline_keyboard?: unknown[] } | undefined)?.inline_keyboard ?? []).length;
    } finally {
      delete process.env["APPROVAL_TG_TOKEN"];
      delete process.env["APPROVAL_TG_CHAT"];
      delete process.env["APPROVAL_HUMAN"];
      if (saved === undefined) delete process.env[STUDY_MODE_ENV];
      else process.env[STUDY_MODE_ENV] = saved;
    }
  };

  assert.equal(await firstButtonRows("1", undefined), 2, "launched on, then unset: the card lost its button");
  assert.equal(await firstButtonRows(undefined, "1"), 1, "launched off, then set: the card gained a button");
  assert.equal(await firstButtonRows("true", "1"), 1, "a value other than exactly 1 turned study mode on");
});
