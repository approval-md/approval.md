/**
 * Full details on tap (APRV-531, SPEC.md §10.3 amended): a declared class whose
 * minimal card does not fit keeps the simple card, and the canonical rendering
 * goes whole, byte for byte, as threaded replies on one tap.
 *
 * The questions a refuter asks, in order:
 *
 * 1. **Does a real For Kicks order get the new layout?** One, two and five
 *    items, the app's own payload shape, a `say` declaration naming every key.
 * 2. **Is the rendering whole?** The replies' `<pre>` contents concatenate to
 *    the canonical rendering byte for byte, and its sha256 is the
 *    `display_hash` the gate recorded on the request.
 * 3. **Can the details tap decide anything?** It appends nothing (the log file
 *    is byte-identical across the tap), reaches no handler, and the replies
 *    carry no buttons.
 * 4. **Is everything else unchanged?** Undeclared stays `undeclared`, and every
 *    other fallback keeps its reason.
 *
 * Every Bot API call goes to an injected `fetch` that records it. The
 * world-backed cases build the log through the real gate and decide through
 * `recordChannelDecision`, as every channel suite does.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import { claimed, computed, recordChannelDecision, type ChannelRequest } from "../src/channels/contract.js";
import { buildPendingQueue } from "../src/channels/tagging.js";
import {
  detailsCallbackData,
  onTapNonce,
  TELEGRAM_DETAILS_STALE_GRANT,
  minimalSettleText,
  parseCallbackData,
  parseDetailsCallback,
  renderTelegram,
  TelegramChannel,
  PAYLOAD_CHUNK_LABEL,
  TELEGRAM_DETAILS_GONE,
  TELEGRAM_MAX_MESSAGE_CHARS,
  TELEGRAM_PROMPT_HEADING,
  type TelegramConfig,
} from "../src/channels/telegram.js";
import {
  detailsReplies,
  renderTelegramMinimal,
  MINIMAL_DENY_LABEL,
  MINIMAL_DETAILS_ALREADY,
  MINIMAL_DETAILS_CLOSER,
  MINIMAL_DETAILS_LABEL,
  MINIMAL_DETAILS_OPENER,
  MINIMAL_DETAILS_FAILED,
  MINIMAL_DETAILS_MAX_REPLIES,
  detailsPartLine,
  MINIMAL_FALLBACKS,
  MINIMAL_HEADLINE_PREFIX,
  MINIMAL_MESSAGE_BUDGET,
  MINIMAL_ON_TAP_NOTICE,
  type TechnicalRegions,
} from "../src/channels/telegram-minimal.js";
import { payloadHash } from "../src/core/payload.js";
import { canonicalRender } from "../src/core/wysiwys.js";
import { TELEGRAM_PROMPT_LAYOUT, applyPromptBlock, type PromptSay } from "../src/core/prompt-layout.js";
import { register, request as requestAt } from "./clock-adapters.js";
import { at, attest, newScenario, payloadOf, records, scratchRoot, T0 } from "./scenario.js";

const scratch = scratchRoot("channels-telegram-details-on-tap");
after(() => scratch.cleanup());

// ---------------------------------------------------------------------------
// The For Kicks order, as the app binds it
// ---------------------------------------------------------------------------
//
// Shape: agentvillage-app `src/lib/server/village-bridge/forkicks-schema.ts`
// (`ForKicksApproval.payload`): `{appId, operation, preview}`, the preview being
// the order input plus the merchant's quote (lines with options, qty and
// prices; subtotal, discount and total; the pickup location with its mapsUrl,
// opens, closes, lastOrders, isOpenNow and pickupInstructions; expiresAt,
// canOrder and warnings). Values are realistic, not real.

const CLASS = "marketplace.app.action";

const MENU = [
  { name: "Masala chai", options: ["Oat milk", "Less sugar"], unitInr: 120 },
  { name: "Paneer kathi roll", options: ["Extra chutney"], unitInr: 260 },
  { name: "Cold brew", options: ["Large", "No ice"], unitInr: 220 },
  { name: "Banana bread", options: [], unitInr: 180 },
  { name: "Avocado toast on sourdough", options: ["Add egg", "Chilli flakes"], unitInr: 340 },
];

function forKicksOrder(count: number): Record<string, unknown> {
  const lines = MENU.slice(0, count).map((item, index) => {
    const qty = index === 0 ? 2 : 1;
    return {
      name: item.name,
      qty,
      options: item.options,
      unitInr: item.unitInr,
      lineInr: item.unitInr * qty,
      itemId: `item_${String(index + 1).padStart(3, "0")}`,
      optionIds: item.options.map((_, option) => `opt_${String(index + 1)}_${String(option + 1)}`),
    };
  });
  const subtotal = lines.reduce((sum, line) => sum + line.lineInr, 0);
  return {
    appId: "forkicks",
    operation: "forkicks.order.confirm",
    preview: {
      items: lines.map((line) => ({ itemId: line.itemId, qty: line.qty, optionIds: line.optionIds })),
      fulfilment: { type: "pickup", locationId: "loc_mandrem_beach", date: "2026-10-21" },
      paymentMethod: "upi",
      note: "Please pack the roll separately",
      appId: "forkicks",
      draftId: "6f1c2a9e-3b7d-4c11-9a2e-8d5f0b4e7a31",
      displayName: "Carter",
      quote: {
        quoteId: "q_20261021_0931_a7",
        expiresAt: "2026-10-21T09:46:00+05:30",
        lines,
        subtotalInr: subtotal,
        discountInr: 0,
        totalInr: subtotal,
        drinks: lines.filter((line) => /chai|brew/iu.test(line.name)).length,
        deliveryEligible: false,
        location: {
          id: "loc_mandrem_beach",
          name: "For Kicks, Mandrem Beach Road",
          address: "Junasvaddo, Mandrem, Pernem, Goa 403527, near the Village gate",
          mapsUrl: "https://maps.google.com/?q=For+Kicks+Mandrem+Beach+Road&ll=15.6593,73.7149",
          opens: "2026-10-21T08:00:00+05:30",
          closes: "2026-10-21T18:00:00+05:30",
          lastOrders: "2026-10-21T17:30:00+05:30",
          isOpenNow: true,
          pickupInstructions:
            "Collect at the counter by the blue door, to the left of the surf-board rack. Show the order number on your phone; the team calls names when the order is ready, and keeps it on the warm shelf for 30 minutes. If you are running late, message the cafe on WhatsApp from the order page and they will hold it. Bring your own cup for chai and get ₹10 off. Parking for scooters is on the lane behind the cafe; please do not park in front of the gate, it blocks the neighbours' drive.",
        },
        paymentMethod: "upi",
        warnings: [
          "Prices include GST.",
          "Orders not collected within 30 minutes of ready are donated to the Village kitchen.",
          "The kitchen closes for a staff break between 15:00 and 15:30; orders placed then are made after the break.",
          "Some items contain nuts, dairy or gluten. Ask at the counter for the allergen sheet.",
        ],
        canOrder: true,
      },
    },
  };
}

/** The declaration: every top-level key named, so the class is declared (§5.2 `say`). */
const FOR_KICKS_SAY: PromptSay = {
  [CLASS]: {
    does: "place a For Kicks order for you",
    quote: { appId: "App", operation: "Action", preview: "Order" },
    note: "summary",
  },
};

const TTL_ALWAYS = applyPromptBlock(TELEGRAM_PROMPT_LAYOUT, { always: ["ttl_remaining_ms"] });

// ---------------------------------------------------------------------------
// Helpers (the same recorder the minimal suite uses)
// ---------------------------------------------------------------------------

interface Sent {
  method: string;
  body: Record<string, unknown>;
}

/** A failure the recorder answers instead of success, or null. */
type Fail = (method: string, body: Record<string, unknown>, index: number) => { status: number; description: string } | null;

function recordingChannel(
  overrides: Partial<TelegramConfig> = {},
  options: { prefix?: string; fail?: Fail } = {},
): { channel: TelegramChannel; sent: Sent[] } {
  const sent: Sent[] = [];
  let id = 700;
  let nonce = 0;
  const channel = new TelegramChannel({
    token: "1:fake-token-for-tests",
    chatId: "9911",
    apiBase: "http://127.0.0.1:9",
    fetch: async (url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      const method = url.split("/").pop() ?? "";
      sent.push({ method, body });
      const failure = options.fail?.(method, body, sent.length - 1) ?? null;
      if (failure !== null) {
        return {
          ok: false,
          status: failure.status,
          text: async () => JSON.stringify({ ok: false, error_code: failure.status, description: failure.description }),
        };
      }
      id += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: id } }) };
    },
    nonce: () => {
      nonce += 1;
      return `${options.prefix ?? "n"}${String(nonce)}`;
    },
    log: () => {},
    ...overrides,
  });
  return { channel, sent };
}

const sends = (sent: Sent[]): Sent[] => sent.filter((entry) => entry.method === "sendMessage");
const textOf = (entry: Sent | undefined): string => String(entry?.body["text"] ?? "");
const answers = (sent: Sent[]): string[] =>
  sent.filter((entry) => entry.method === "answerCallbackQuery").map((entry) => String(entry.body["text"]));

function visible(html: string): string {
  return html
    .replace(/<[^>]+>/gu, "")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&amp;/gu, "&");
}

/** The decoded `<pre>` contents of one reply. */
function preOf(html: string): string {
  const match = /<pre>([\s\S]*)<\/pre>/u.exec(html);
  assert.ok(match !== null, `a reply has no <pre>: ${html.slice(0, 80)}`);
  return visible(match[1] ?? "");
}

type Row = { text: string; callback_data: string }[];
function keyboardOf(entry: Sent | undefined): Row[] {
  const markup = entry?.body["reply_markup"] as { inline_keyboard: Row[] } | undefined;
  return markup?.inline_keyboard ?? [];
}

const AGENT = "agent:hermes";

function requestOf(cls: string, key: string, value: unknown, extra: { truncated?: boolean } = {}): ChannelRequest {
  const text = JSON.stringify(value, null, 2);
  return {
    action_key: computed(key, "log"),
    task: computed(null, "log"),
    class: computed(cls, "log"),
    autonomy: computed("manual", "policy-match"),
    provenance: computed("rule", "policy-match"),
    est_cost_usd: claimed(0, AGENT),
    summary: claimed("Your usual Wednesday breakfast order", AGENT),
    payload_hash: computed(payloadHash(value), "log"),
    fullPayload: computed(
      {
        value,
        text: extra.truncated === true ? text.slice(0, 10) : text,
        hash: payloadHash(value),
        truncated: extra.truncated === true,
      },
      "payload-binding",
    ),
    budgets: computed([], "budgets"),
    attestation: computed({ status: "attested", seq: 3, sha256: "cd".repeat(32) }, "attestation"),
    requested_ts: computed("2026-10-21T04:00:00.000Z", "log"),
    ttl_remaining_ms: computed(15 * 60_000, "clock"),
    waiting: computed("requested 1 min ago · expires 04:15 UTC", "clock"),
    chain: computed({ seq: 12, hash: "ab".repeat(32), head_seq: 12 }, "log"),
    state: computed("requested", "log"),
  };
}

function technicalOf(request: ChannelRequest): TechnicalRegions {
  const rendering = renderTelegram(request, TELEGRAM_PROMPT_HEADING, TTL_ALWAYS);
  return {
    header: rendering.header,
    payloadText: rendering.payloadText,
    claimedText: rendering.claimedText,
    anomalous: false,
    payloadLabel: `<b>${PAYLOAD_CHUNK_LABEL}</b>`,
  };
}

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
  "  marketplace.app.action: { autonomy: manual, agent_may_request: true }",
  "  marketplace.app.other: { autonomy: manual, agent_may_request: true }",
  "```",
  "",
].join("\n");

/** A live world holding each payload's bytes, so the gate records each request's display_hash. */
function world(actions: { key: string; cls: string; payload: unknown }[]) {
  const unit = newScenario(scratch.root, POLICY);
  attest(unit, T0);
  const registered = register(
    unit.logPath,
    {
      task: "task-531",
      envelope: {
        origin: { app: "manual", created_by: AGENT },
        state: "awaiting",
        actions: actions.map((action) => ({
          class: action.cls,
          idempotency_key: action.key,
          summary: "s",
          reversible: true,
          est_cost_usd: "0",
          payload_hash: payloadHash(action.payload),
        })),
      },
    },
    T0,
    AGENT,
    unit.options,
  );
  assert.equal(registered.ok, true, JSON.stringify(registered));
  for (const action of actions) {
    const requested = requestAt(
      unit.logPath,
      {
        task: "task-531",
        actionKey: action.key,
        cls: action.cls,
        payload_hash: payloadHash(action.payload),
        payload: { value: action.payload },
      },
      at(1),
      AGENT,
      unit.options,
    );
    assert.equal(requested.ok, true, JSON.stringify(requested));
  }
  const payloads = new Map(actions.map((action) => [action.key, action.payload]));
  const queue = buildPendingQueue(
    unit.logPath,
    { policy: { file: unit.policyPath }, payload: (key) => payloads.get(key) },
    at(2),
  );
  assert.equal(queue.ok, true, JSON.stringify(queue));
  let handled = 0;
  return {
    unit,
    requests: queue.ok ? queue.requests : [],
    handled: () => handled,
    handler: (decision: Parameters<typeof recordChannelDecision>[1]) => {
      handled += 1;
      return recordChannelDecision(unit.logPath, decision, { actor: "human:carter", channel: "telegram" }, {
        ...unit.options,
        clock: () => at(3),
      }).outcome;
    },
  };
}

let updateId = 1;
async function press(channel: TelegramChannel, data: string | undefined, card = 701): Promise<void> {
  updateId += 1;
  await channel.deliverUpdate({
    update_id: updateId,
    callback_query: {
      id: `cb-${String(updateId)}`,
      from: { id: 42 },
      message: { message_id: card, chat: { id: 9911 } },
      data,
    },
  });
}

function requestedRecord(unit: ReturnType<typeof newScenario>, key: string): Record<string, unknown> {
  const record = records(unit).find((entry) => entry.event === "approval.requested" && entry.action_key === key);
  assert.ok(record !== undefined, `no approval.requested for ${key}`);
  return payloadOf(record);
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// 1. A real For Kicks order renders the new layout (1, 2 and 5 items)
// ---------------------------------------------------------------------------

for (const count of [1, 2, 5]) {
  test(`For Kicks, ${String(count)} item(s): the simple card with the notice and three buttons, and the full details whole on tap`, async () => {
    const key = `forkicks:order-${String(count)}`;
    const payload = forKicksOrder(count);
    const request = requestOf(CLASS, key, payload);
    const canonical = canonicalRender(payload, CLASS);

    // The old card (rendering collapsed in it) would not fit: this is the case the ruling is about.
    const technical = technicalOf(request);
    const drawn = renderTelegramMinimal(request, technical, FOR_KICKS_SAY);
    assert.ok(drawn.ok, JSON.stringify(drawn));
    assert.ok(drawn.onTap !== undefined, "a For Kicks order did not take the details-on-tap layout");
    assert.equal(drawn.onTap.rendering, canonical.text, "the rendering held for the tap is not the canonical one");
    assert.equal(drawn.details, "", "a details-on-tap card still carries a collapsed block");

    const { channel, sent } = recordingChannel({ promptStyle: "minimal", say: FOR_KICKS_SAY, layout: TTL_ALWAYS });
    await channel.notify(request);
    const before = sends(sent);
    assert.equal(before.length, 1, "the card is ONE message");
    const [card] = before;
    const text = textOf(card);
    assert.ok(text.length <= MINIMAL_MESSAGE_BUDGET, `card is ${String(text.length)} characters`);
    assert.ok(text.startsWith(`<b>${MINIMAL_HEADLINE_PREFIX}place a For Kicks order for you</b>\n<blockquote>`));
    assert.ok(text.endsWith(`\n${MINIMAL_ON_TAP_NOTICE}`), "the computed notice is not where the collapsed block was");
    assert.doesNotMatch(text, /<blockquote expandable>|<pre>/u, "the card still holds a rendering");
    assert.equal(text.includes(canonical.text), false);

    const rows = keyboardOf(card);
    assert.deepEqual(
      rows[0]?.map((button) => button.text),
      ["✅ Approve", MINIMAL_DENY_LABEL, MINIMAL_DETAILS_LABEL],
    );
    // Today's verbs and shape; the nonce carries the on-tap mark (fold 1, S2).
    assert.equal(rows[0]?.[0]?.callback_data.startsWith(`g:${onTapNonce("n1")}:`), true, "Approve lost today's callback data");
    assert.equal(rows[0]?.[1]?.callback_data.startsWith(`r:${onTapNonce("n1")}:`), true, "Deny lost today's callback data");
    assert.equal(rows[0]?.[2]?.callback_data, detailsCallbackData(onTapNonce("n1")));

    await press(channel, rows[0]?.[2]?.callback_data, 701);
    const replies = sends(sent).slice(1);
    assert.ok(replies.length >= 1);
    for (const reply of replies) {
      assert.equal(reply.body["reply_markup"], undefined, "a details reply carries buttons");
      assert.deepEqual(reply.body["reply_parameters"], { message_id: 701 }, "a reply is not threaded to the card");
      assert.equal(reply.body["parse_mode"], "HTML");
      assert.ok(textOf(reply).length < TELEGRAM_MAX_MESSAGE_CHARS, "a reply is over Telegram's limit");
    }
    assert.ok(
      textOf(replies[0]).startsWith(`${detailsPartLine(1, replies.length)}\n${MINIMAL_DETAILS_OPENER}\n<pre>`),
      "the opener is missing",
    );
    for (const [index, reply] of replies.entries()) {
      assert.ok(textOf(reply).startsWith(`${detailsPartLine(index + 1, replies.length)}\n`), `part line missing on ${String(index)}`);
    }
    assert.ok(replies.length <= MINIMAL_DETAILS_MAX_REPLIES);
    assert.ok(textOf(replies.at(-1)).endsWith(`</pre>\n${MINIMAL_DETAILS_CLOSER}`), "the closer is missing");
    const joined = replies.map((reply) => preOf(textOf(reply))).join("");
    assert.equal(joined, canonical.text, "the replies are not the canonical rendering byte for byte");
    assert.equal(sha256(joined), canonical.display_hash);
    assert.deepEqual(answers(sent), [""], "the first tap's answer is not a silent ack");
  });
}

test("a five-item order is long enough to need several replies, and each is cut between characters", () => {
  const payload = forKicksOrder(5);
  const canonical = canonicalRender(payload, CLASS).text;
  const replies = detailsReplies(canonical, 1200);
  assert.ok(replies !== null && replies.length > 2, "the fixture did not split");
  assert.equal(replies.map(preOf).join(""), canonical);
  for (const [index, reply] of replies.entries()) {
    assert.ok(reply.length <= 1200, `reply ${String(index)} is ${String(reply.length)}`);
    assert.ok(reply.startsWith(`${detailsPartLine(index + 1, replies.length)}\n`));
    assert.equal(reply.includes(MINIMAL_DETAILS_OPENER), index === 0);
    assert.equal(reply.endsWith(MINIMAL_DETAILS_CLOSER), index === replies.length - 1);
    // A reply that ends with its </pre> never ends on white space (Telegram trims message edges).
    if (index < replies.length - 1) assert.doesNotMatch(preOf(reply), /\s$/u, `reply ${String(index)} ends on white space`);
  }
});

test("the split never falls inside a grapheme cluster, a surrogate pair or an HTML entity", () => {
  const family = "👨‍👩‍👧";
  const accented = "é̂";
  const rendering = `${`${family}${accented}&<>`.repeat(400)}tail`;
  for (const budget of [200, 333, 1000, MINIMAL_MESSAGE_BUDGET]) {
    const replies = detailsReplies(rendering, budget, 1000);
    assert.ok(replies !== null);
    assert.equal(replies.map(preOf).join(""), rendering, `budget ${String(budget)} lost bytes`);
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
    for (const reply of replies) {
      assert.ok(reply.length <= budget);
      const pre = preOf(reply);
      const clusters = [...segmenter.segment(pre)].map((entry) => entry.segment);
      for (const cluster of clusters) {
        assert.ok(
          cluster === family || cluster === accented || cluster.length === 1 || cluster === "&" || /^[a-z]$/u.test(cluster),
          `a cluster was split: ${JSON.stringify(cluster)}`,
        );
      }
      assert.doesNotMatch(reply.replace(/&(amp|lt|gt);/gu, ""), /&/u, "an entity was split");
    }
  }
});

test("a one-message rendering carries the opener and the closer in the same reply; an empty one still sends both", () => {
  const [only, ...rest] = detailsReplies("{\n  \"a\": 1\n}") ?? [];
  assert.equal(rest.length, 0);
  assert.equal(only, `Part 1 of 1\n${MINIMAL_DETAILS_OPENER}\n<pre>{\n  "a": 1\n}</pre>\n${MINIMAL_DETAILS_CLOSER}`);
  assert.deepEqual(detailsReplies(""), [`Part 1 of 1\n${MINIMAL_DETAILS_OPENER}\n<pre></pre>\n${MINIMAL_DETAILS_CLOSER}`]);
});

// ---------------------------------------------------------------------------
// 2. Binding and the log: the details tap decides nothing, the card decides as ever
// ---------------------------------------------------------------------------

test("display_hash: the replies hash to the request's recorded display_hash, and a decision on the card binds it", async () => {
  const key = "forkicks:bound";
  const payload = forKicksOrder(2);
  const live = world([{ key, cls: CLASS, payload }]);
  const { channel, sent } = recordingChannel({ promptStyle: "minimal", say: FOR_KICKS_SAY });
  channel.onDecision(live.handler);
  const [request] = live.requests;
  assert.ok(request !== undefined);
  await channel.notify(request);
  const rows = keyboardOf(sends(sent)[0]);
  assert.equal(rows[0]?.length, 3, "the live card did not take the details-on-tap layout");

  const logBefore = readFileSync(live.unit.logPath, "utf8");
  await press(channel, rows[0]?.[2]?.callback_data);
  assert.equal(readFileSync(live.unit.logPath, "utf8"), logBefore, "the details tap appended to the log");
  assert.equal(live.handled(), 0, "the details tap reached the decision handler");

  const replies = sends(sent).slice(1);
  const joined = replies.map((reply) => preOf(textOf(reply))).join("");
  const recorded = requestedRecord(live.unit, key)["display_hash"];
  assert.equal(typeof recorded, "string", "the gate recorded no display_hash");
  assert.equal(sha256(joined), recorded, "the replies are not what display_hash names");

  // The technical card for the same request names the same text.
  const technical = renderTelegram(request, TELEGRAM_PROMPT_HEADING, TELEGRAM_PROMPT_LAYOUT);
  assert.equal(sha256(technical.payloadText ?? ""), recorded);

  // Approve on the card: one grant, on this request, recorded as the minimal style.
  await press(channel, rows[0]?.[0]?.callback_data);
  assert.equal(live.handled(), 1);
  const granted = records(live.unit).filter((entry) => entry.event === "approval.granted" && entry.action_key === key);
  assert.equal(granted.length, 1, "the card's Approve did not grant");
  assert.deepEqual(payloadOf(granted[0]!)["rendering"], { style: "minimal" });
  const requested = records(live.unit).find((entry) => entry.event === "approval.requested" && entry.action_key === key);
  assert.equal(payloadOf(requested!)["display_hash"], recorded, "the request's display_hash moved");
});

test("a repeat tap sends nothing new and answers Already sent above.; the log is untouched", async () => {
  const live = world([{ key: "forkicks:again", cls: CLASS, payload: forKicksOrder(1) }]);
  const { channel, sent } = recordingChannel({ promptStyle: "minimal", say: FOR_KICKS_SAY });
  channel.onDecision(live.handler);
  await channel.notify(live.requests[0]!);
  const data = keyboardOf(sends(sent)[0])[0]?.[2]?.callback_data;
  await press(channel, data);
  const afterFirst = sends(sent).length;
  const logBefore = readFileSync(live.unit.logPath, "utf8");
  await press(channel, data);
  await press(channel, data);
  assert.equal(sends(sent).length, afterFirst, "a repeat tap sent the details again");
  assert.deepEqual(answers(sent), ["", MINIMAL_DETAILS_ALREADY, MINIMAL_DETAILS_ALREADY]);
  assert.equal(readFileSync(live.unit.logPath, "utf8"), logBefore);
  assert.equal(live.handled(), 0);
});

test("a details tap on a card this process is not holding sends nothing, decides nothing, and says so", async () => {
  const live = world([{ key: "forkicks:gone", cls: CLASS, payload: forKicksOrder(1) }]);
  const { channel, sent } = recordingChannel({ promptStyle: "minimal", say: FOR_KICKS_SAY });
  channel.onDecision(live.handler);
  await channel.notify(live.requests[0]!);
  const logBefore = readFileSync(live.unit.logPath, "utf8");
  await press(channel, detailsCallbackData("never-issued"));
  assert.equal(sends(sent).length, 1, "an unknown details nonce sent something");
  assert.deepEqual(answers(sent), [TELEGRAM_DETAILS_GONE]);
  assert.equal(readFileSync(live.unit.logPath, "utf8"), logBefore);
  assert.equal(live.handled(), 0);
});

test("the details verb is not a decision verb, and the decision parser never reads it as one", () => {
  assert.deepEqual(parseDetailsCallback("d:n1"), { nonce: "n1" });
  assert.equal(parseCallbackData("d:n1"), null);
  assert.equal(parseCallbackData("d:n1", true), null);
  for (const data of ["d:", "d:n1:ref", "g:n1", "dn1", 7, null]) {
    assert.equal(parseDetailsCallback(data), null, JSON.stringify(data));
  }
});

// ---------------------------------------------------------------------------
// 3. The settle edit drops all three buttons
// ---------------------------------------------------------------------------

test("the settle edit turns the card into its outcome and headline, and removes all three buttons", async () => {
  const live = world([{ key: "forkicks:settle", cls: CLASS, payload: forKicksOrder(2) }]);
  const { channel, sent } = recordingChannel({ promptStyle: "minimal", say: FOR_KICKS_SAY });
  channel.onDecision(live.handler);
  await channel.notify(live.requests[0]!);
  const [card] = sends(sent);
  const rows = keyboardOf(card);
  await press(channel, rows[0]?.[2]?.callback_data);
  await press(channel, rows[0]?.[1]?.callback_data);
  const edit = sent.find((entry) => entry.method === "editMessageText");
  assert.ok(edit !== undefined, "the card was not settled");
  assert.equal(edit.body["message_id"], 701, "the settle edit did not edit the card");
  assert.equal(edit.body["reply_markup"], undefined, "the settle edit kept buttons");
  const text = textOf(edit);
  assert.ok(text.startsWith("<b>✗ DENIED</b>\n") || text.startsWith("<b>✗ REJECTED</b>\n"), text.slice(0, 60));
  assert.equal(text.split("\n")[1], textOf(card).split("\n")[0], "the headline did not survive the edit");
  assert.equal(text.includes(MINIMAL_ON_TAP_NOTICE), false, "the settled card still asks for a tap");
  assert.equal(text.endsWith("\n"), false);
  // The replies are left as sent: nothing edits or deletes them.
  assert.equal(sent.filter((entry) => entry.method === "editMessageText").length, 1);
  assert.equal(sent.some((entry) => entry.method === "deleteMessage"), false);
  // After the settle, a details tap is a card no longer open here.
  await press(channel, rows[0]?.[2]?.callback_data);
  assert.equal(answers(sent).at(-1), TELEGRAM_DETAILS_GONE);
});

test("an expiry settles the card the same way: outcome, headline, no buttons", async () => {
  const { channel, sent } = recordingChannel({ promptStyle: "minimal", say: FOR_KICKS_SAY });
  const delivery = await channel.notify(requestOf(CLASS, "forkicks:expire", forKicksOrder(1)));
  await channel.annotate(delivery, "⌛ EXPIRED", ["nobody answered in time"]);
  const edit = sent.find((entry) => entry.method === "editMessageText");
  assert.ok(edit !== undefined);
  assert.equal(edit.body["reply_markup"], undefined);
  assert.equal(textOf(edit).split("\n").length, 3, textOf(edit));
});

test("minimalSettleText with no collapsed block ends at the detail lines", () => {
  assert.equal(
    minimalSettleText("✓ APPROVED", ["by human:carter"], { headline: "<b>Your agent wants to x</b>", details: "" }),
    "<b>✓ APPROVED</b>\n<b>Your agent wants to x</b>\nby human:carter",
  );
});

// ---------------------------------------------------------------------------
// 4. Everything else is unchanged
// ---------------------------------------------------------------------------

test("an undeclared oversize request is still the technical card, recorded undeclared", async () => {
  const live = world([{ key: "forkicks:undeclared", cls: CLASS, payload: forKicksOrder(5) }]);
  const { channel, sent } = recordingChannel({ promptStyle: "minimal", say: {} });
  channel.onDecision(live.handler);
  await channel.notify(live.requests[0]!);
  const all = sends(sent);
  assert.ok(all.length > 1, "an undeclared order was not the technical card");
  assert.ok(all.every((entry) => !keyboardOf(entry).flat().some((button) => button.text === MINIMAL_DETAILS_LABEL)));
  const card = all.find((entry) => entry.body["reply_markup"] !== undefined);
  await press(channel, keyboardOf(card)[0]?.[0]?.callback_data);
  const granted = records(live.unit).find((entry) => entry.event === "approval.granted");
  assert.deepEqual(payloadOf(granted!)["rendering"], { style: "technical", fallback: "undeclared" });
});

test("a declared order that fits keeps today's single message with the collapsed block and two buttons", async () => {
  const small = { appId: "forkicks", operation: "forkicks.order.status", preview: { orderId: "ord_1" } };
  const { channel, sent } = recordingChannel({ promptStyle: "minimal", say: FOR_KICKS_SAY });
  await channel.notify(requestOf(CLASS, "forkicks:small", small));
  const [card] = sends(sent);
  assert.equal(sends(sent).length, 1);
  assert.ok(textOf(card).includes("<blockquote expandable>"));
  assert.equal(textOf(card).includes(MINIMAL_ON_TAP_NOTICE), false);
  assert.equal(keyboardOf(card)[0]?.length, 2);
});

test("every other fallback keeps its reason for an oversize declared order", () => {
  const payload = forKicksOrder(5);
  const base = requestOf(CLASS, "forkicks:fallbacks", payload);
  const technical = technicalOf(base);
  const reason = (request: ChannelRequest, regions: TechnicalRegions = technicalOf(request), say = FOR_KICKS_SAY) => {
    const drawn = renderTelegramMinimal(request, regions, say);
    return drawn.ok ? (drawn.onTap === undefined ? "minimal" : "on-tap") : drawn.reason;
  };
  assert.equal(reason(base, technical), "on-tap");
  assert.equal(reason({ ...base, policy_diff: computed("diff", "log") } as unknown as ChannelRequest), "attestation");
  assert.equal(reason({ ...base, class: computed("policy.edit", "log") }), "policy");
  assert.equal(reason({ ...base, class: computed("log.rotate", "log") }), "policy");
  assert.equal(reason(base, { ...technical, anomalous: true }), "anomaly");
  assert.equal(reason({ ...base, autonomy: computed("supervised", "policy-match") } as ChannelRequest), "anomaly");
  assert.equal(
    reason({ ...base, attestation: computed({ status: "unattested", seq: null, sha256: null }, "attestation") } as unknown as ChannelRequest),
    "anomaly",
  );
  assert.equal(reason(requestOf(CLASS, "forkicks:t", payload, { truncated: true })), "truncated");
  assert.equal(reason(requestOf(CLASS, "forkicks:x", { ...payload, extra: 1 })), "unlisted-key");
  assert.equal(reason(base, technical, {}), "undeclared");
  // A payload the runtime reads itself keeps `too-long`: the exception is for declared classes.
  const email = requestOf("communicate.email.external", "mail:big", {
    to: ["a@example.org"],
    subject: "Big",
    body: "x".repeat(MINIMAL_MESSAGE_BUDGET),
  });
  assert.equal(reason(email), "too-long");
  const command = requestOf("network.call", "hook:s:t:network.call", { command: `echo ${"y".repeat(5000)}`, cwd: "/tmp" });
  assert.equal(reason(command), "too-long");
  // The fallback vocabulary is unchanged.
  assert.deepEqual([...MINIMAL_FALLBACKS], [
    "attestation", "policy", "no-payload", "truncated", "anomaly", "undeclared", "unlisted-key",
    "nothing-quoted", "too-long", "digest", "stale-summary", "batch", "send-refused", "policy-unattested",
  ]);
});

test("the channel-level fallbacks keep the technical card for an oversize declared order: batch, digest, policy-unattested", async () => {
  // A digest: several declared orders delivered together are always technical.
  const many = recordingChannel({ promptStyle: "minimal", say: FOR_KICKS_SAY });
  const one = requestOf(CLASS, "forkicks:b1", forKicksOrder(2));
  const two = requestOf(CLASS, "forkicks:b2", forKicksOrder(2));
  await many.channel.notifyBatch({ requests: [one, two] });
  assert.ok(sends(many.sent).length > 0);
  for (const entry of sends(many.sent)) {
    assert.equal(textOf(entry).startsWith(`<b>${MINIMAL_HEADLINE_PREFIX}`), false, "a batch member was a minimal card");
    assert.equal(keyboardOf(entry).flat().some((button) => button.text === MINIMAL_DETAILS_LABEL), false);
  }
  // A resolver fallback (policy-unattested, stale-summary, digest) is honoured before any drawing.
  for (const fallback of ["policy-unattested", "stale-summary", "digest"]) {
    const resolved = recordingChannel({
      promptFor: () => ({ style: "minimal", say: FOR_KICKS_SAY, fallback }),
    } as Partial<TelegramConfig>);
    await resolved.channel.notify(requestOf(CLASS, `forkicks:${fallback}`, forKicksOrder(2)));
    const all = sends(resolved.sent);
    assert.ok(all.length > 1, `${fallback}: not the technical card`);
    assert.equal(all.some((entry) => keyboardOf(entry).flat().some((button) => button.text === MINIMAL_DETAILS_LABEL)), false);
  }
});

// ---------------------------------------------------------------------------
// Fold 1 (review-b M1, S1, S2): the details path never fails open
// ---------------------------------------------------------------------------

/** The renderer's verdict for a declared For Kicks-class payload: on-tap, minimal (fits) or a fallback reason. */
function verdictOf(payload: unknown): string {
  const request = requestOf(CLASS, "forkicks:verdict", payload);
  const drawn = renderTelegramMinimal(request, technicalOf(request), FOR_KICKS_SAY);
  return drawn.ok ? (drawn.onTap === undefined ? "minimal" : "on-tap") : drawn.reason;
}

test("M1: review-b's padded order (9,000 spaces inside a value) is the ordinary technical card, recorded too-long", async () => {
  const padded = { appId: "forkicks", operation: "forkicks.order.confirm", preview: { note: `1 chai${" ".repeat(9000)}AND THE REST` } };
  const rendering = canonicalRender(padded, CLASS).text;
  assert.equal(detailsReplies(rendering), null, "a run of white space longer than a reply was cut");
  assert.equal(verdictOf(padded), "too-long");

  const live = world([{ key: "forkicks:padded", cls: CLASS, payload: padded }]);
  const { channel, sent } = recordingChannel({ promptStyle: "minimal", say: FOR_KICKS_SAY });
  channel.onDecision(live.handler);
  await channel.notify(live.requests[0]!);
  const all = sends(sent);
  assert.ok(all.length > 1, "the padded order was not the technical card");
  assert.equal(all.some((entry) => keyboardOf(entry).flat().some((button) => button.text === MINIMAL_DETAILS_LABEL)), false);
  // The technical card carries the tail before any button exists.
  const pre = all.map((entry) => /<pre>([\s\S]*)<\/pre>/u.exec(textOf(entry))?.[1]).filter((x): x is string => x !== undefined).map(visible).join("");
  assert.equal(pre, rendering);
  const card = all.find((entry) => entry.body["reply_markup"] !== undefined);
  await press(channel, keyboardOf(card)[0]?.[0]?.callback_data);
  const granted = records(live.unit).find((entry) => entry.event === "approval.granted");
  assert.deepEqual(payloadOf(granted!)["rendering"], { style: "technical", fallback: "too-long" });
});

test("M1: a 200 KB declared payload is over the reply cap and falls back to the technical card", () => {
  const huge = { appId: "forkicks", operation: "forkicks.order.confirm", preview: { note: "x".repeat(200_000) } };
  assert.equal(detailsReplies(canonicalRender(huge, CLASS).text), null);
  assert.equal(verdictOf(huge), "too-long");
});

test("M1: the cap boundary: a rendering that needs 6 replies is on tap, one that needs 7 is the technical card", () => {
  const sized = (n: number) => ({ appId: "forkicks", operation: "forkicks.order.confirm", preview: { note: "x".repeat(n) } });
  let six: number | null = null;
  let seven: number | null = null;
  for (let n = 15_000; n < 40_000; n += 40) {
    const replies = detailsReplies(canonicalRender(sized(n), CLASS).text);
    if (replies === null) {
      seven = n;
      break;
    }
    six = n;
  }
  assert.ok(six !== null && seven !== null, "the search did not cross the cap");
  const atCap = detailsReplies(canonicalRender(sized(six), CLASS).text);
  assert.equal(atCap?.length, MINIMAL_DETAILS_MAX_REPLIES, "the last size under the cap is not exactly 6 replies");
  assert.equal(MINIMAL_DETAILS_MAX_REPLIES, 6);
  assert.equal(detailsReplies(canonicalRender(sized(six), CLASS).text, MINIMAL_MESSAGE_BUDGET, 1000)?.length, 6);
  assert.equal(detailsReplies(canonicalRender(sized(seven), CLASS).text, MINIMAL_MESSAGE_BUDGET, 1000)?.length, 7);
  assert.equal(verdictOf(sized(six)), "on-tap");
  assert.equal(verdictOf(sized(seven)), "too-long");
  // Part lines at the cap: 1 of 6 … 6 of 6.
  assert.deepEqual(atCap?.map((reply) => reply.split("\n")[0]), [1, 2, 3, 4, 5, 6].map((k) => detailsPartLine(k, 6)));
});

test("M1: no reply is empty or loses an edge byte to Telegram's trim; a cut that cannot avoid white space falls back", () => {
  /** What Telegram shows of a reply: its text trimmed at the edges. */
  const trimmed = (reply: string) => visible(reply).trim();
  // White space that a cut can step around: kept whole, and no non-last reply ends on it.
  const spaced = `${"a".repeat(3000)}${" ".repeat(900)}${"b".repeat(3000)}${"\n".repeat(50)}${"c".repeat(3000)}`;
  const replies = detailsReplies(spaced);
  assert.ok(replies !== null && replies.length > 1);
  assert.equal(replies.map(preOf).join(""), spaced);
  for (const [index, reply] of replies.entries()) {
    assert.notEqual(trimmed(reply), "", `reply ${String(index)} is empty after the trim`);
    if (index < replies.length - 1) assert.doesNotMatch(preOf(reply), /\s$/u);
  }
  // A last chunk that is white space only is still inside its reply, between the part line and the closer.
  const tail = detailsReplies(`${"a".repeat(3670)}${" ".repeat(50)}`);
  assert.ok(tail !== null && tail.length === 2, JSON.stringify(tail?.length));
  assert.equal(preOf(tail[1] ?? ""), " ".repeat(50));
  assert.ok(trimmed(tail[1] ?? "").startsWith("Part 2 of 2"));
  // A run of white space wider than one reply: no honest cut, so the ordinary form.
  assert.equal(detailsReplies(`a${" ".repeat(4000)}b`), null);
  assert.equal(detailsReplies(`a${"\n".repeat(4000)}b`), null);
});

test("S1: a send that fails partway says so on the card, and the next tap sends the whole chain again from part 1", async () => {
  const live = world([{ key: "forkicks:s1", cls: CLASS, payload: forKicksOrder(5) }]);
  let failNext = true;
  let replyCount = 0;
  const { channel, sent } = recordingChannel(
    { promptStyle: "minimal", say: FOR_KICKS_SAY },
    {
      fail: (method, body) => {
        if (method !== "sendMessage" || body["reply_parameters"] === undefined) return null;
        replyCount += 1;
        if (failNext && replyCount === 2) {
          failNext = false;
          return { status: 429, description: "Too Many Requests: retry after 7" };
        }
        return null;
      },
    },
  );
  channel.onDecision(live.handler);
  await channel.notify(live.requests[0]!);
  const data = keyboardOf(sends(sent)[0])[0]?.[2]?.callback_data;
  const logBefore = readFileSync(live.unit.logPath, "utf8");
  await press(channel, data);
  const first = sends(sent).slice(1);
  // Part 1 delivered, part 2 refused, then the computed failure line, threaded to the card.
  assert.equal(first.length, 3, first.map((entry) => textOf(entry).slice(0, 20)).join(" | "));
  assert.equal(textOf(first[2]), MINIMAL_DETAILS_FAILED);
  assert.deepEqual(first[2]?.body["reply_parameters"], { message_id: 701 });
  assert.equal(first[2]?.body["reply_markup"], undefined);
  // The card stays re-tappable: the next tap restarts at part 1 and completes.
  await press(channel, data);
  const second = sends(sent).slice(4);
  assert.ok(textOf(second[0]).startsWith(`${detailsPartLine(1, second.length)}\n${MINIMAL_DETAILS_OPENER}`), "the retry did not restart at part 1");
  assert.ok(textOf(second.at(-1)).endsWith(MINIMAL_DETAILS_CLOSER));
  assert.equal(second.map((entry) => preOf(textOf(entry))).join(""), canonicalRender(forKicksOrder(5), CLASS).text);
  // Only now is it sent: a third tap answers Already sent above.
  await press(channel, data);
  assert.deepEqual(answers(sent), ["", "", MINIMAL_DETAILS_ALREADY]);
  assert.equal(readFileSync(live.unit.logPath, "utf8"), logBefore, "a details tap appended");
  assert.equal(live.handled(), 0);
});

test("S2: after a restart, an on-tap card may Deny but not Approve; a stale technical card keeps today's stale-copy rule", async () => {
  const live = world([
    { key: "forkicks:s2", cls: CLASS, payload: forKicksOrder(2) },
    { key: "forkicks:s2-deny", cls: CLASS, payload: forKicksOrder(3) },
  ]);
  // Process 1 sends both cards, then dies.
  const before = recordingChannel({ promptStyle: "minimal", say: FOR_KICKS_SAY });
  for (const request of live.requests) await before.channel.notify(request);
  const [cardA, cardB] = sends(before.sent);
  const rowsA = keyboardOf(cardA)[0] ?? [];
  const rowsB = keyboardOf(cardB)[0] ?? [];
  assert.equal(rowsA.length, 3);
  // Process 2 re-sends the pending requests under its own nonces.
  const after = recordingChannel({ promptStyle: "minimal", say: FOR_KICKS_SAY }, { prefix: "m" });
  after.channel.onDecision(live.handler);
  for (const request of live.requests) await after.channel.notify(request);
  const logBefore = readFileSync(live.unit.logPath, "utf8");

  await press(after.channel, rowsA[0]?.callback_data);
  assert.equal(answers(after.sent).at(-1), TELEGRAM_DETAILS_STALE_GRANT);
  assert.equal(readFileSync(live.unit.logPath, "utf8"), logBefore, "a stale on-tap Approve appended");
  assert.equal(live.handled(), 0, "a stale on-tap Approve reached the handler");
  // Its Full details is dead too, and says so.
  await press(after.channel, rowsA[2]?.callback_data);
  assert.equal(answers(after.sent).at(-1), TELEGRAM_DETAILS_GONE);
  // Deny on the other stale on-tap card still decides, through the stale-copy ladder.
  await press(after.channel, rowsB[1]?.callback_data);
  assert.equal(live.handled(), 1);
  assert.ok(records(live.unit).some((entry) => entry.event === "approval.rejected" && entry.action_key === "forkicks:s2-deny"));
  // The live card's Approve still grants.
  const liveRows = keyboardOf(sends(after.sent)[0])[0] ?? [];
  await press(after.channel, liveRows[0]?.callback_data);
  assert.ok(records(live.unit).some((entry) => entry.event === "approval.granted" && entry.action_key === "forkicks:s2"));

  // A stale technical card (undeclared) keeps the stale-copy rule: its Approve grants.
  const plain = world([{ key: "forkicks:s2-tech", cls: CLASS, payload: forKicksOrder(1) }]);
  const old = recordingChannel({ promptStyle: "minimal", say: {} });
  await old.channel.notify(plain.requests[0]!);
  const oldCard = sends(old.sent).find((entry) => entry.body["reply_markup"] !== undefined);
  const fresh = recordingChannel({ promptStyle: "minimal", say: {} }, { prefix: "m" });
  fresh.channel.onDecision(plain.handler);
  await fresh.channel.notify(plain.requests[0]!);
  await press(fresh.channel, keyboardOf(oldCard)[0]?.[0]?.callback_data);
  assert.ok(records(plain.unit).some((entry) => entry.event === "approval.granted" && entry.action_key === "forkicks:s2-tech"));
});

test("S2: the on-tap mark is outside the generated nonce alphabet and only narrows", () => {
  assert.equal(onTapNonce("abc"), "abc.d");
  assert.doesNotMatch("1aZ-_09", /\./u);
  const parsed = parseCallbackData(`g:${onTapNonce("n1")}:0123456789abcdef`);
  assert.deepEqual(parsed?.nonce, "n1.d");
});

// ---------------------------------------------------------------------------
// 5. Mutants: each of these edits to the code must fail a test above
// ---------------------------------------------------------------------------
//
// - reply cut short: `detailsReplies` dropping its last chunk, or a chunk's
//   last cluster, fails the byte-equality checks (1 / 2 / 5 items, display_hash).
// - buttons on a reply: a `reply_markup` on any reply fails "a details reply
//   carries buttons".
// - a decision via the details callback: routing `d:` into the decision ladder
//   (or adding `d` to the decision verbs) fails the parser test, the handler
//   count and the byte-identical log.
// - opener missing: dropping MINIMAL_DETAILS_OPENER fails "the opener is missing".
// - fold 1: marking the details sent before the loop fails the S1 retry test;
//   dropping the part line, the reply cap or the honest-cut check fails the M1
//   tests; removing the stale on-tap grant guard fails the S2 test.
//
// The mutant runs that confirmed each are listed in the PR's build report.
