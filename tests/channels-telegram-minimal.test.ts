/**
 * The minimal Telegram card (APRV-489).
 *
 * Four questions, in the order a refuter asks them:
 *
 * 1. **Is technical mode unchanged?** A channel with no style, and one told
 *    `technical`, send the same bytes; review cards and the note prompt are the
 *    same bytes under BOTH styles.
 * 2. **Is the canonical rendering in the button-bearing message, whole?** The
 *    collapsed block decodes to the technical card's three regions, character for
 *    character, and the canonical text appears in it verbatim.
 * 3. **Can quoted payload text forge or hide part of the card?** It is escaped,
 *    one line, marked, bounded, inside its quote box, and the first line is
 *    always the runtime's.
 * 4. **Does the control plane's relay still take the card?** Its markup rules,
 *    copied below with their source, are applied to a real minimal card.
 *
 * Every Bot API call goes to an injected `fetch` that records it; nothing here
 * reaches the network. The world-backed cases build the log through the real
 * gate and decide through `recordChannelDecision`, as every channel suite does.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  claimed,
  computed,
  recordChannelDecision,
  LIVE_TOOL_CALL,
  type ChannelRequest,
} from "../src/channels/contract.js";
import { buildPendingQueue, type TagOptions } from "../src/channels/tagging.js";
import {
  renderTelegram,
  reviewCallbackData,
  TelegramChannel,
  PAYLOAD_CHUNK_LABEL,
  TELEGRAM_PROMPT_HEADING,
  type ReviewCard,
  type TelegramConfig,
} from "../src/channels/telegram.js";
import {
  deadlineLine,
  plainDuration,
  quoteLine,
  renderTelegramMinimal,
  MINIMAL_CUT_MARK,
  MINIMAL_DENY_LABEL,
  MINIMAL_GLOSS_LABEL,
  MINIMAL_HEADLINE_PREFIX,
  MINIMAL_MESSAGE_BUDGET,
  MINIMAL_QUOTE_MAX,
  type TechnicalRegions,
} from "../src/channels/telegram-minimal.js";
import { payloadHash } from "../src/core/payload.js";
import { canonicalRender } from "../src/core/wysiwys.js";
import { TELEGRAM_PROMPT_LAYOUT, applyPromptBlock, type PromptSay } from "../src/core/prompt-layout.js";
import { register, request as requestAt } from "./clock-adapters.js";
import { at, attest, newScenario, payloadOf, records, scratchRoot, T0 } from "./scenario.js";

const scratch = scratchRoot("channels-telegram-minimal");
after(() => scratch.cleanup());

// ---------------------------------------------------------------------------
// The relay's rules, copied (requirement 6)
// ---------------------------------------------------------------------------
//
// Source: the Agent Village control plane, `control-plane/src/approval-relay/`,
// read at origin/main 220985b (2026-10-05) and at PR #82's head 20a18d1
// (branch carter/DATA-324-relay-readiness, which tightens the review-card and
// ForceReply rules). The constants below are identical in both versions except
// where noted. If the relay changes them, these copies go stale on purpose: the
// test then pins what core was checked against.

/** quiet.js `TTL_LINE` (both versions): the quiet hold needs EXACTLY ONE match. */
const RELAY_TTL_LINE =
  /<b>ttl:<\/b> (no expiry declared|(\d+)h (\d+)m left|(\d+)m (\d+)s left|(\d+)s left) <i>\(/g;

/** index.js `TELEGRAM_TEXT_MAX` and `labelMax` (both versions). */
const RELAY_TEXT_MAX = 4096;
const RELAY_LABEL_MAX = 48;

/** index.js `ALLOWED_METHODS` (both versions). */
const RELAY_ALLOWED_METHODS = new Set([
  "getMe",
  "sendMessage",
  "editMessageText",
  "answerCallbackQuery",
  "getUpdates",
  "getWebhookInfo",
  "deleteWebhook",
]);

/** index.js `sanitizeMarkup` (both versions; PR #82 also admits an exact `{force_reply: true}`). */
function relayAcceptsMarkup(markup: unknown): boolean {
  if (markup === undefined || markup === null) return true;
  if (typeof markup !== "object" || Array.isArray(markup)) return false;
  const keys = Object.keys(markup);
  const rows = (markup as { inline_keyboard?: unknown }).inline_keyboard;
  if (keys.length !== 1 || !Array.isArray(rows) || rows.length > 20) return false;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length === 0 || row.length > 8) return false;
    for (const button of row as Record<string, unknown>[]) {
      if (Object.keys(button).some((key) => key !== "text" && key !== "callback_data")) return false;
      const text = button["text"];
      const data = button["callback_data"];
      if (typeof text !== "string" || text.length === 0 || text.length > 128) return false;
      if (typeof data !== "string" || data.length === 0 || Buffer.byteLength(data) > 64) return false;
    }
  }
  return true;
}

/** PR #82 index.js `REVIEW_HEADING` and `reviewCardOf`'s line shape. */
const RELAY_REVIEW_HEADING = "<b>REVIEW — THIS ALREADY RAN</b>";
const RELAY_ACTION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,199}$/;
/** PR #82 index.js `REVIEW_KEYBOARD`: (choice, label) per row. */
const RELAY_REVIEW_KEYBOARD: [string, string][][] = [
  [
    ["ok", "✅"],
    ["deny", "\u{1F6D1}"],
  ],
  [
    ["disliked", "\u{1F44E}"],
    ["indifferent", "\u{1F610}"],
    ["liked", "\u{1F44D}"],
    ["loved", "❤️"],
  ],
];
/** PR #82 index.js `NOTE_PROMPT`. */
const RELAY_NOTE_PROMPT =
  /^<b>WHY (LOVED|DISLIKED)\?<\/b>\nReply to this message with the reason\. It is recorded verbatim beside a (ok|denied) review of ([^\n]+)\.\nNothing has been appended yet, and a blank reply appends nothing: the grade an agent is most likely to act on is the one it can least interpret alone\.$/;

/** PR #82 index.js `reviewCardOf`: whether the relay reads a send as core's review card. */
function relayReviewCardOf(text: string, parseMode: unknown, markup: unknown): boolean {
  if (parseMode !== "HTML") return false;
  const lines = text.split("\n");
  if (lines.length < 3 || lines[0] !== RELAY_REVIEW_HEADING || lines[2] !== "") return false;
  const key = /^<code>([^<]*)<\/code>$/u.exec(lines[1] ?? "");
  if (key === null || !RELAY_ACTION_KEY.test(key[1] ?? "")) return false;
  const rows = (markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined)
    ?.inline_keyboard;
  if (!Array.isArray(rows) || rows.length !== RELAY_REVIEW_KEYBOARD.length) return false;
  return RELAY_REVIEW_KEYBOARD.every((want, i) =>
    want.every(([choice, label], j) => {
      const button = rows[i]?.[j];
      return button !== undefined && button.text === label && new RegExp(`^v:[^:]+:${choice}$`).test(button.callback_data);
    }),
  );
}

/** The relay's `labelLine` for HTML, at the longest label it allows. */
function relayLabelled(text: string): string {
  return `<b>Agent: ${"m".repeat(RELAY_LABEL_MAX)}</b>\n${text}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Sent {
  method: string;
  body: Record<string, unknown>;
}

/** A channel whose Bot API is a recorder. Deterministic nonces. */
function recordingChannel(overrides: Partial<TelegramConfig> = {}): { channel: TelegramChannel; sent: Sent[] } {
  const sent: Sent[] = [];
  let id = 500;
  let nonce = 0;
  const channel = new TelegramChannel({
    token: "1:fake-token-for-tests",
    chatId: "9911",
    apiBase: "http://127.0.0.1:9",
    fetch: async (url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      sent.push({ method: url.split("/").pop() ?? "", body });
      id += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, result: { message_id: id } }),
      };
    },
    nonce: () => {
      nonce += 1;
      return `n${String(nonce)}`;
    },
    log: () => {},
    ...overrides,
  });
  return { channel, sent };
}

const sends = (sent: Sent[]): Sent[] => sent.filter((entry) => entry.method === "sendMessage");
const textOf = (entry: Sent | undefined): string => String(entry?.body["text"] ?? "");

/** The visible text of Telegram HTML: tags dropped, the four entities decoded. */
function visible(html: string): string {
  return html
    .replace(/<[^>]+>/gu, "")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&amp;/gu, "&");
}

const AGENT = "agent:hermes";

function requestOf(
  cls: string,
  key: string,
  value: unknown,
  extra: {
    summary?: string;
    gloss?: string;
    ttl?: number | null;
    toolCall?: boolean;
    breakdown?: string;
    cost?: number;
    truncated?: boolean;
  } = {},
): ChannelRequest {
  const text = JSON.stringify(value, null, 2);
  return {
    action_key: computed(key, "log"),
    task: computed(null, "log"),
    class: computed(cls, "log"),
    autonomy: computed("manual", "policy-match"),
    provenance: computed("rule", "policy-match"),
    est_cost_usd: claimed(extra.cost ?? 0, AGENT),
    summary: claimed(extra.summary ?? null, AGENT),
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
    requested_ts: computed("2026-10-05T10:00:00.000Z", "log"),
    ttl_remaining_ms: computed(extra.ttl === undefined ? 72 * 3_600_000 - 60_000 : extra.ttl, "clock"),
    waiting: computed("requested 1 min ago · expires 09:59 UTC", "clock"),
    chain: computed({ seq: 12, hash: "ab".repeat(32), head_seq: 12 }, "log"),
    state: computed("requested", "log"),
    ...(extra.gloss === undefined ? {} : { gloss: claimed(extra.gloss, "model:claude/haiku (requested)") }),
    ...(extra.breakdown === undefined ? {} : { command_breakdown: computed(extra.breakdown, "classifier") }),
    ...(extra.toolCall === true ? { [LIVE_TOOL_CALL]: computed(true as const, "log") } : {}),
  };
}

/** The resident template's three classes, as the control plane would declare them. */
const VILLAGE_SAY: PromptSay = {
  "intent.publish.inferred.index": {
    does: "post a wish to Index, the village matching service, in your name",
    quote: { text: "" },
    note: "none",
  },
  "digest.share": {
    does: "share a note about you with other people",
    quote: { scope: "Shared with", expires_at: "Until", text: "Note", digest_id: null },
    note: "none",
  },
  "village.vote": {
    does: "vote for you in this week's village question",
    quote: { answer: "Answer", question_id: null },
    note: "summary",
  },
};

const TTL_ALWAYS = applyPromptBlock(TELEGRAM_PROMPT_LAYOUT, { always: ["ttl_remaining_ms"] });

const COMMAND =
  "git clone https://github.com/Edge-City/agentvillage-app /tmp/app && cd /tmp/app && git log -1 && git branch --show-current";

function commandRequest(extra: Parameters<typeof requestOf>[3] = {}): ChannelRequest {
  return requestOf("network.call", "hook:s1:tc1:network.call", { command: COMMAND, cwd: "/home/hermes" }, {
    ttl: 240_000,
    toolCall: true,
    gloss: "Clones the agentvillage-app repository and displays its latest commit and current branch.",
    ...extra,
  });
}

function intentRequest(text: string, key = "intent:abc"): ChannelRequest {
  return requestOf("intent.publish.inferred.index", key, { text }, { summary: "inferred from chat" });
}

function technicalOf(request: ChannelRequest, layout = TTL_ALWAYS): TechnicalRegions {
  const rendering = renderTelegram(request, TELEGRAM_PROMPT_HEADING, layout);
  return {
    header: rendering.header,
    payloadText: rendering.payloadText,
    claimedText: rendering.claimedText,
    anomalous: false,
    payloadLabel: `<b>${PAYLOAD_CHUNK_LABEL}</b>`,
  };
}

async function minimalSends(request: ChannelRequest, say: PromptSay = VILLAGE_SAY): Promise<Sent[]> {
  const { channel, sent } = recordingChannel({ promptStyle: "minimal", say, layout: TTL_ALWAYS });
  await channel.notify(request);
  return sends(sent);
}

// ---------------------------------------------------------------------------
// 1. Technical mode is unchanged
// ---------------------------------------------------------------------------

test("technical is the default: no style and style technical send the same bytes (AC #1)", async () => {
  for (const request of [commandRequest(), intentRequest("hello"), requestOf("x.y", "k:1", { a: 1 })]) {
    const absent = recordingChannel({ layout: TTL_ALWAYS });
    const explicit = recordingChannel({ layout: TTL_ALWAYS, promptStyle: "technical", say: VILLAGE_SAY });
    await absent.channel.notify(request);
    await explicit.channel.notify(request);
    assert.deepEqual(explicit.sent, absent.sent, request.action_key.value);
    assert.equal(sends(absent.sent).length, 3, "the technical card is header, payload, claimed");
    assert.ok(textOf(sends(absent.sent)[0]).startsWith(`<b>${TELEGRAM_PROMPT_HEADING}</b>`));
  }
});

test("a technical card keeps the Reject label; only a minimal card says Deny, and the verbs are the same (R7)", async () => {
  const technical = recordingChannel();
  await technical.channel.notify(intentRequest("hello"));
  const minimal = recordingChannel({ promptStyle: "minimal", say: VILLAGE_SAY });
  await minimal.channel.notify(intentRequest("hello"));
  const keyboard = (entry: Sent | undefined) =>
    (entry?.body["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
  const tech = keyboard(sends(technical.sent).at(-1));
  const mini = keyboard(sends(minimal.sent).at(-1));
  assert.deepEqual(tech[0]?.map((button) => button.text), ["✅ Approve", "🛑 Reject"]);
  assert.deepEqual(mini[0]?.map((button) => button.text), ["✅ Approve", MINIMAL_DENY_LABEL]);
  assert.deepEqual(
    mini[0]?.map((button) => button.callback_data),
    tech[0]?.map((button) => button.callback_data),
    "the callback data differs between styles",
  );
  assert.equal(mini.length, 1, "a minimal card carries one row: no Defer, no Details button");
});

test("review cards and the note prompt are byte-identical under both styles, and the relay still reads them (requirement 6a)", async () => {
  const card: ReviewCard = {
    sampleSeq: 7,
    fields: {
      action_key: computed("hook:s1:tc4:network.call", "log"),
      class: computed("network.call", "log"),
      task: computed(null, "log"),
      summary: claimed("Terminal: curl …", AGENT),
      command_breakdown: computed("curl https://example.org", "classifier"),
    },
    ranAt: computed("ran 2 min ago (seq 6)", "log"),
    ranAtTs: "2026-10-05T10:00:00.000Z",
    verdict: computed("allowed without asking (supervised-retro, rate 0.1)", "policy-match"),
  };
  const runs: Sent[][] = [];
  for (const style of [undefined, "minimal"] as const) {
    const { channel, sent } = recordingChannel({
      ...(style === undefined ? {} : { promptStyle: style, say: VILLAGE_SAY }),
      layout: TTL_ALWAYS,
    });
    channel.onReview(() => ({ ok: true, headline: "✓ REVIEWED", detail: [], toast: "ok" }));
    await channel.offerReview(card);
    // A loved tap asks for the note first, through the ForceReply prompt.
    await channel.deliverUpdate({
      update_id: 1,
      callback_query: {
        id: "cb-1",
        from: { id: 42 },
        message: { message_id: 501, chat: { id: 9911 } },
        data: reviewCallbackData("loved", "n1"),
      },
    });
    runs.push(sends(sent));
  }
  assert.deepEqual(runs[1], runs[0], "minimal style changed a review card or the note prompt");
  const [cardSend, notePrompt] = runs[0] ?? [];
  assert.ok(
    relayReviewCardOf(textOf(cardSend), cardSend?.body["parse_mode"], cardSend?.body["reply_markup"]),
    "the relay would no longer read core's review card as one",
  );
  assert.match(textOf(notePrompt), RELAY_NOTE_PROMPT, "the note prompt left the relay's accepted shape");
  assert.deepEqual(notePrompt?.body["reply_markup"], { force_reply: true });
});

// ---------------------------------------------------------------------------
// 2. The canonical rendering is in the button-bearing message, whole
// ---------------------------------------------------------------------------

for (const [label, request] of [
  ["command", commandRequest()],
  ["inferred intent", intentRequest("Looking for two people to play doubles badminton on Sunday mornings.")],
  [
    "digest share",
    requestOf("digest.share", "digest:d-77", {
      digest_id: "d-77",
      scope: "village",
      text: "Maya is building a tide-pool sensor & would love help <soldering>.",
      expires_at: "2026-10-12T18:00:00Z",
    }),
  ],
  [
    "village vote",
    requestOf("village.vote", "vote:q-12", { question_id: "q-12", answer: "beach" }, { summary: "Move the market?" }),
  ],
] as const) {
  test(`${label}: one message, buttons on it, the collapsed block is the technical card character for character (AC #2)`, async () => {
    const minimal = await minimalSends(request);
    assert.equal(minimal.length, 1, "a minimal card is ONE message");
    const [only] = minimal;
    const text = textOf(only);
    assert.ok(only?.body["reply_markup"] !== undefined, "the buttons are not on the card");

    // The collapsed block holds the technical messages' visible text, in order.
    const technical = recordingChannel({ layout: TTL_ALWAYS });
    await technical.channel.notify(request);
    const open = text.indexOf("<blockquote expandable>");
    const close = text.lastIndexOf("</blockquote>");
    assert.ok(open > 0 && close > open, "no expandable block");
    assert.equal(close + "</blockquote>".length, text.length, "the collapsed block is not the end of the card");
    const details = visible(text.slice(open, close));
    const expected = sends(technical.sent).map((entry) => visible(textOf(entry))).join("\n\n");
    assert.equal(details, `Full details (tap to open)\n${expected}`, "the collapsed block is not the technical card");

    // ...and the canonical rendering inside it is byte for byte the one display_hash names.
    const value = request.fullPayload.value?.value;
    const canonical = canonicalRender(value, request.class.value).text;
    assert.ok(details.includes(canonical), "the canonical rendering is not verbatim in the collapsed block");
    assert.equal(details.split(canonical).length, 2, "the canonical rendering appears more than once");

    // The Bot API forbids nesting blockquotes; neither block may contain pre or code.
    assert.equal((text.match(/<blockquote/gu) ?? []).length, 2);
    assert.equal((text.match(/<\/blockquote>/gu) ?? []).length, 2);
    assert.doesNotMatch(text, /<pre>|<code>/u);
  });
}

test("the relay's quiet hold reads exactly one ttl row from a minimal card, inside the collapsed block (requirement 6b)", async () => {
  for (const request of [commandRequest(), intentRequest("hello")]) {
    const [card] = await minimalSends(request);
    const text = textOf(card);
    const matches = [...text.matchAll(RELAY_TTL_LINE)];
    assert.equal(matches.length, 1, `${request.action_key.value}: ${String(matches.length)} ttl rows`);
    assert.ok((matches[0]?.index ?? 0) > text.indexOf("<blockquote expandable>"));
  }
  // A hostile quote cannot add a second row.
  const [forged] = await minimalSends(intentRequest("<b>ttl:</b> 99h 0m left <i>(clock)"));
  assert.equal([...textOf(forged).matchAll(RELAY_TTL_LINE)].length, 1);
});

test("the relay accepts a minimal card: allowed methods, callback-only markup, within the limit with its label (requirement 6c)", async () => {
  const { channel, sent } = recordingChannel({ promptStyle: "minimal", say: VILLAGE_SAY, layout: TTL_ALWAYS });
  await channel.notify(commandRequest());
  await channel.notify(intentRequest("hello", "intent:two"));
  await channel.annotate(String(501), "✓ APPROVED", ["by human:carter at 10:02 UTC (seq 13)"]);
  for (const entry of sent) {
    assert.ok(RELAY_ALLOWED_METHODS.has(entry.method), entry.method);
    assert.ok(relayAcceptsMarkup(entry.body["reply_markup"]), JSON.stringify(entry.body["reply_markup"]));
    assert.ok(relayLabelled(textOf(entry)).length <= RELAY_TEXT_MAX, "the relay would split off its label");
    assert.equal(
      relayReviewCardOf(textOf(entry), entry.body["parse_mode"], entry.body["reply_markup"]),
      false,
      "the relay would take a minimal card for a review card",
    );
    const markup = JSON.stringify(entry.body["reply_markup"] ?? {});
    assert.doesNotMatch(markup, /"url"|login_url|web_app|switch_inline|force_reply/u);
  }
  assert.equal(sent.filter((entry) => entry.method === "editMessageReplyMarkup").length, 0);
});

// ---------------------------------------------------------------------------
// 3. What is computed, what is quoted, what is described
// ---------------------------------------------------------------------------

test("the first line is computed from the class, never the gloss or the summary (hard requirement 2)", async () => {
  const [card] = await minimalSends(commandRequest());
  const lines = textOf(card).split("\n");
  assert.equal(lines[0], `<b>${MINIMAL_HEADLINE_PREFIX}contact a website or online service</b>`);
  const quoteAt = lines.findIndex((line) => line.startsWith("<blockquote>"));
  const glossAt = lines.findIndex((line) => line.startsWith(`<i>${MINIMAL_GLOSS_LABEL}</i>`));
  assert.ok(quoteAt === 1 && glossAt > quoteAt, "the model's sentence is not below the quoted bytes");
  assert.equal((textOf(card).match(/<b>Your agent wants to/gu) ?? []).length, 1);
});

test("a card is complete without the gloss: no AI line, no empty line, the command still quoted", async () => {
  const request = commandRequest();
  delete (request as { gloss?: unknown }).gloss;
  const [card] = await minimalSends(request);
  const visibleLines = textOf(card).split("<blockquote expandable>")[0]?.split("\n") ?? [];
  assert.ok(!textOf(card).includes(MINIMAL_GLOSS_LABEL));
  assert.ok(visibleLines.slice(0, -1).every((line) => line.trim().length > 0), "an empty line on the card");
  assert.ok(textOf(card).includes(`<blockquote>git clone`), "the command is not quoted");
});

test("the deadline line is computed from the gate's window: a blocked tool call versus a queued proposal (R4)", () => {
  assert.equal(
    deadlineLine(commandRequest()),
    "Your agent is waiting: about 4 minutes left. If you don't answer, it will not do this.",
  );
  assert.equal(
    deadlineLine(intentRequest("x")),
    "Open for about 3 days. If you don't answer, your agent will not do this.",
  );
  assert.equal(
    deadlineLine(requestOf("x.y", "k", { a: 1 }, { ttl: null })),
    "There is no time limit. Nothing happens until you answer.",
  );
  assert.equal(plainDuration(30_000), "less than a minute");
  assert.equal(plainDuration(60_000), "about 1 minute");
  assert.equal(plainDuration(5 * 3_600_000), "about 5 hours");
  assert.equal(plainDuration(26 * 3_600_000), "about 26 hours");
  assert.equal(plainDuration(72 * 3_600_000), "about 3 days");
});

test("the tagger marks a hook request as a live tool call, and nothing else sees the mark", () => {
  const unit = newScenario(scratch.root, POLICY);
  attest(unit, T0);
  const payload = { command: "curl https://example.org", cwd: "/tmp" };
  const hookKey = "hook:s1:tc1:network.call";
  const proposalKey = "intent:p1";
  registered(unit, [
    { key: hookKey, cls: "network.call", payload },
    { key: proposalKey, cls: "intent.publish.inferred.index", payload: { text: "hi" } },
  ]);
  assert.equal(
    requestAt(unit.logPath, { task: "task-489", actionKey: hookKey, cls: "network.call", execution: "harness", harnessCapMs: 300_000, payload_hash: payloadHash(payload) }, at(1), AGENT, unit.options).ok,
    true,
  );
  assert.equal(
    requestAt(unit.logPath, { task: "task-489", actionKey: proposalKey, cls: "intent.publish.inferred.index", payload_hash: payloadHash({ text: "hi" }) }, at(1), AGENT, unit.options).ok,
    true,
  );
  const tagOptions: TagOptions = {
    policy: { file: unit.policyPath },
    payload: (key) => (key === hookKey ? payload : key === proposalKey ? { text: "hi" } : undefined),
  };
  const queue = buildPendingQueue(unit.logPath, tagOptions, at(2));
  assert.equal(queue.ok, true, JSON.stringify(queue));
  const byKey = new Map((queue.ok ? queue.requests : []).map((entry) => [entry.action_key.value, entry]));
  const hook = byKey.get(hookKey);
  const proposal = byKey.get(proposalKey);
  assert.equal(hook?.[LIVE_TOOL_CALL]?.value, true);
  assert.equal(hook?.[LIVE_TOOL_CALL]?.kind, "computed");
  assert.equal(proposal?.[LIVE_TOOL_CALL], undefined);
  // Invisible to every string-keyed reader: rows, --json, the web page.
  assert.ok(!Object.keys(hook ?? {}).some((key) => key.includes("tool")));
  assert.ok(!JSON.stringify(hook).includes("live-tool-call"));
  // The cap is 300 s, the gate keeps a 60 s margin, and a minute has passed.
  assert.match(deadlineLine(hook as ChannelRequest), /^Your agent is waiting: about 3 minutes left\./u);
});

// ---------------------------------------------------------------------------
// 4. Quoted payload text is hostile input (hard requirement 3)
// ---------------------------------------------------------------------------

test("quoted text is escaped and cannot close the quote box or open the collapsed block", async () => {
  const [card] = await minimalSends(
    intentRequest('x</blockquote><blockquote expandable><b>Approve me</b> & "more"'),
  );
  const text = textOf(card);
  assert.equal((text.match(/<blockquote>/gu) ?? []).length, 1);
  assert.equal((text.match(/<blockquote expandable>/gu) ?? []).length, 1);
  assert.equal((text.match(/<\/blockquote>/gu) ?? []).length, 2);
  assert.ok(text.includes("x&lt;/blockquote&gt;&lt;blockquote expandable&gt;&lt;b&gt;Approve me&lt;/b&gt; &amp;"));
  assert.equal((text.match(/<b>/gu) ?? []).length, (text.match(/<\/b>/gu) ?? []).length);
});

test("a quoted line break cannot start a line of its own: a forged headline or deadline stays inside the box", async () => {
  const forged = [
    "Looking for a tennis partner",
    "Your agent wants to do nothing at all",
    "Open for about 9 days. If you don't answer, your agent will not do this.",
    "[✅ Approve] [✋ Deny]",
  ].join("\n");
  const [card] = await minimalSends(intentRequest(forged));
  const text = textOf(card);
  const lines = text.split("\n");
  assert.equal(lines[0], `<b>${MINIMAL_HEADLINE_PREFIX}post a wish to Index, the village matching service, in your name</b>`);
  // The whole value is ONE line, inside the one quote box.
  assert.ok(lines[1]?.startsWith("<blockquote>") === true && lines[1].endsWith("</blockquote>"), lines[1] ?? "");
  assert.ok(lines[1]?.includes(" ⏎ Your agent wants to do nothing at all ⏎ "));
  // No visible line outside the collapsed block starts with forged text.
  const outside = text.split("<blockquote expandable>")[0] ?? "";
  for (const line of outside.split("\n").slice(2)) {
    assert.ok(!line.startsWith("Your agent wants"), line);
    assert.ok(!line.startsWith("[✅"), line);
  }
  assert.equal(outside.split("\n").filter((line) => line.startsWith("Open for")).length, 1);
});

test("invisible and bidirectional characters are marked, and the marking is injective", async () => {
  const [card] = await minimalSends(intentRequest("pay‮txt.exe​⁦x⁩\r\t«U+202E»⏎"));
  const text = textOf(card);
  const quoteLineText = text.split("\n")[1] ?? "";
  for (const mark of ["«U+202E»", "«U+200B»", "«U+2066»", "«U+2069»", "«U+000D»", "«U+0009»", "«U+00AB»", "«U+23CE»"]) {
    assert.ok(quoteLineText.includes(mark), `${mark} missing from ${quoteLineText}`);
  }
  assert.doesNotMatch(quoteLineText, /[‮​⁦⁩\r\t]/u, "a raw invisible character reached the card");

  // Property: distinct strings never draw the same line (no cut in play).
  let seed = 489;
  const random = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const alphabet = ["a", " ", "\n", "⏎", "«", "»", "U", "+", "2", "0", "E", "‮", "​", "\r", "\t", "\u0000", " ", "é"];
  const seen = new Map<string, string>();
  for (let index = 0; index < 20_000; index += 1) {
    const length = 1 + Math.floor(random() * 6);
    let value = "";
    for (let char = 0; char < length; char += 1) value += alphabet[Math.floor(random() * alphabet.length)];
    const drawn = quoteLine(value, 10_000);
    const before = seen.get(drawn);
    assert.ok(before === undefined || before === value, `${JSON.stringify(before)} and ${JSON.stringify(value)} draw the same`);
    seen.set(drawn, value);
  }
});

test("a long quote is cut with an explicit marker, never silently, and the collapsed block keeps every byte", async () => {
  const long = "word ".repeat(200);
  const [card] = await minimalSends(intentRequest(long));
  const text = textOf(card);
  const quote = text.split("\n")[1] ?? "";
  assert.ok(quote.includes(MINIMAL_CUT_MARK), "no cut marker");
  assert.ok([...visible(quote)].length <= MINIMAL_QUOTE_MAX + MINIMAL_CUT_MARK.length + 1);
  assert.ok(visible(text).includes(JSON.stringify(long)), "the collapsed block lost bytes");
  // A mark is never split by the cut.
  const marked = quoteLine("‮".repeat(100), 20);
  assert.ok(marked.endsWith(MINIMAL_CUT_MARK));
  assert.match(marked.slice(0, -MINIMAL_CUT_MARK.length), /^(«U\+202E»)+$/u);
});

// ---------------------------------------------------------------------------
// 5. When the minimal card is not drawn (M4 and the exclusions)
// ---------------------------------------------------------------------------

test("an opaque payload with no declaration, or with a key the declaration does not name, is the technical card (AC #3)", async () => {
  const undeclared = requestOf("skill.manage", "hook:s1:tc9:skill.manage", { tool: "skill_manage", input: {} });
  assert.deepEqual(renderTelegramMinimal(undeclared, technicalOf(undeclared), VILLAGE_SAY), {
    ok: false,
    reason: "undeclared",
  });
  const extraKey = requestOf("digest.share", "digest:x", { digest_id: "d", scope: "village", text: "t", expires_at: "z", cc: "everyone" });
  assert.deepEqual(renderTelegramMinimal(extraKey, technicalOf(extraKey), VILLAGE_SAY), {
    ok: false,
    reason: "unlisted-key",
  });
  const hiddenOnly = requestOf("village.vote", "vote:x", { question_id: "q" });
  assert.deepEqual(renderTelegramMinimal(hiddenOnly, technicalOf(hiddenOnly), VILLAGE_SAY), {
    ok: false,
    reason: "nothing-quoted",
  });
  const notObject = requestOf("intent.publish.inferred.index", "intent:arr", ["a", "b"]);
  assert.deepEqual(renderTelegramMinimal(notObject, technicalOf(notObject), VILLAGE_SAY), {
    ok: false,
    reason: "undeclared",
  });
  // On the wire: exactly the technical card, with its own Reject label.
  const minimal = await minimalSends(extraKey);
  const technical = recordingChannel({ layout: TTL_ALWAYS });
  await technical.channel.notify(extraKey);
  assert.deepEqual(minimal, sends(technical.sent));
});

test("attestations, policy edits, truncated payloads and abnormal rows are always technical (AC #7)", () => {
  const attestation = { ...intentRequest("x"), policy_diff: computed("a -> b", "log") };
  assert.equal((renderTelegramMinimal(attestation, technicalOf(attestation), VILLAGE_SAY) as { reason: string }).reason, "attestation");
  const policyEdit = requestOf("policy.edit", "hook:s:t:policy.edit", { command: "vi APPROVAL.md" });
  assert.equal((renderTelegramMinimal(policyEdit, technicalOf(policyEdit), {}) as { reason: string }).reason, "policy");
  const truncated = requestOf("network.call", "k:t", { command: "ls" }, { truncated: true });
  assert.equal((renderTelegramMinimal(truncated, technicalOf(truncated), {}) as { reason: string }).reason, "truncated");
  const anomalous = commandRequest();
  assert.equal(
    (renderTelegramMinimal(anomalous, { ...technicalOf(anomalous), anomalous: true }, {}) as { reason: string }).reason,
    "anomaly",
  );
});

test("a card over the budget is the technical card; the canonical rendering is never cut to fit (requirement 5)", () => {
  const big = requestOf("communicate.email.external", "task:mail", {
    to: ["a@example.org"],
    subject: "Big",
    body: "x".repeat(MINIMAL_MESSAGE_BUDGET),
  });
  assert.deepEqual(renderTelegramMinimal(big, technicalOf(big), {}), { ok: false, reason: "too-long" });
});

test("a digest under a minimal policy is drawn technical, and its members are not minimal cards", async () => {
  const { channel, sent } = recordingChannel({ promptStyle: "minimal", say: VILLAGE_SAY });
  const one = intentRequest("same", "intent:d1");
  const two = { ...intentRequest("same", "intent:d2") };
  const delivery = await channel.notifyBatch({ requests: [one, two] });
  assert.ok(delivery.digestId !== null, "the fixture did not form a digest");
  assert.ok(sends(sent).every((entry) => !textOf(entry).startsWith(`<b>${MINIMAL_HEADLINE_PREFIX}`)));
});

// ---------------------------------------------------------------------------
// 6. The decision records which style was shown, and the settle edit keeps the card
// ---------------------------------------------------------------------------

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
  "  intent.publish.*: { autonomy: manual, agent_may_request: true }",
  "  digest.share: { autonomy: manual, agent_may_request: true }",
  "  network.call: { autonomy: manual, agent_may_request: true }",
  "```",
  "",
].join("\n");

function registered(
  unit: ReturnType<typeof newScenario>,
  actions: { key: string; cls: string; payload: unknown }[],
): void {
  const result = register(
    unit.logPath,
    {
      task: "task-489",
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
  assert.equal(result.ok, true, JSON.stringify(result));
}

/** A live world with one request per payload; returns its queue and a decision handler. */
function world(actions: { key: string; cls: string; payload: unknown }[]) {
  const unit = newScenario(scratch.root, POLICY);
  attest(unit, T0);
  registered(unit, actions);
  for (const action of actions) {
    const requested = requestAt(
      unit.logPath,
      { task: "task-489", actionKey: action.key, cls: action.cls, payload_hash: payloadHash(action.payload) },
      at(1),
      AGENT,
      unit.options,
    );
    assert.equal(requested.ok, true, JSON.stringify(requested));
  }
  const payloads = new Map(actions.map((action) => [action.key, action.payload]));
  const queue = buildPendingQueue(unit.logPath, { policy: { file: unit.policyPath }, payload: (key) => payloads.get(key) }, at(2));
  assert.equal(queue.ok, true, JSON.stringify(queue));
  return {
    unit,
    requests: queue.ok ? queue.requests : [],
    handler: (decision: Parameters<typeof recordChannelDecision>[1]) =>
      recordChannelDecision(unit.logPath, decision, { actor: "human:carter", channel: "telegram" }, {
        ...unit.options,
        clock: () => at(3),
      }).outcome,
  };
}

async function tap(channel: TelegramChannel, sent: Sent[], key: string, decision: "grant" | "reject"): Promise<void> {
  // The keyboard rides on the first message carrying markup at or after the one naming the key:
  // the card itself when minimal, the claimed message when technical.
  const all = sends(sent);
  const from = all.findIndex((entry) => visible(textOf(entry)).includes(key));
  const card = all.slice(from).find((entry) => entry.body["reply_markup"] !== undefined);
  const row = (card?.body["reply_markup"] as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0];
  const data = decision === "grant" ? row?.[0]?.callback_data : row?.[1]?.callback_data;
  await channel.deliverUpdate({
    update_id: Math.floor(Math.random() * 1e9),
    callback_query: {
      id: `cb-${key}`,
      from: { id: 42 },
      message: { message_id: 1, chat: { id: 9911 } },
      data,
    },
  });
}

function decisionPayload(unit: ReturnType<typeof newScenario>, key: string): Record<string, unknown> {
  const record = records(unit).find(
    (entry) => (entry.event === "approval.granted" || entry.event === "approval.rejected") && entry.action_key === key,
  );
  assert.ok(record !== undefined, `no decision recorded for ${key}`);
  return payloadOf(record);
}

test("the decision record states which style was shown; absent under a technical policy (AC #9)", async () => {
  const actions = [
    { key: "intent:r1", cls: "intent.publish.inferred.index", payload: { text: "Badminton on Sunday?" } },
    { key: "intent:r2", cls: "intent.publish.inferred.index", payload: { text: "Surf lessons", extra: 1 } },
  ];
  const live = world(actions);
  const { channel, sent } = recordingChannel({ promptStyle: "minimal", say: VILLAGE_SAY });
  channel.onDecision(live.handler);
  for (const request of live.requests) await channel.notify(request);
  await tap(channel, sent, "intent:r1", "grant");
  await tap(channel, sent, "intent:r2", "reject");
  assert.deepEqual(decisionPayload(live.unit, "intent:r1")["rendering"], { style: "minimal" });
  assert.deepEqual(decisionPayload(live.unit, "intent:r2")["rendering"], {
    style: "technical",
    fallback: "unlisted-key",
  });

  const plain = world([{ key: "intent:r3", cls: "intent.publish.inferred.index", payload: { text: "x" } }]);
  const technical = recordingChannel();
  technical.channel.onDecision(plain.handler);
  for (const request of plain.requests) await technical.channel.notify(request);
  await tap(technical.channel, technical.sent, "intent:r3", "grant");
  assert.equal("rendering" in decisionPayload(plain.unit, "intent:r3"), false, "a technical policy's record changed");
});

test("the settle edit keeps the minimal headline and the collapsed details, and removes the buttons (AC #6)", async () => {
  const live = world([{ key: "intent:s1", cls: "intent.publish.inferred.index", payload: { text: "Pottery on Tuesday" } }]);
  const { channel, sent } = recordingChannel({ promptStyle: "minimal", say: VILLAGE_SAY, layout: TTL_ALWAYS });
  channel.onDecision(live.handler);
  for (const request of live.requests) await channel.notify(request);
  const [card] = sends(sent);
  await tap(channel, sent, "intent:s1", "grant");
  const edit = sent.find((entry) => entry.method === "editMessageText");
  assert.ok(edit !== undefined, "the card was not settled");
  const text = textOf(edit);
  assert.ok(text.startsWith("<b>✓ APPROVED</b>\n"), text.slice(0, 80));
  const headline = textOf(card).split("\n")[0] ?? "";
  assert.equal(text.split("\n")[1], headline);
  const details = textOf(card).slice(textOf(card).indexOf("<blockquote expandable>"));
  assert.ok(text.endsWith(details), "the collapsed details did not survive the edit");
  assert.equal(edit.body["reply_markup"], undefined, "the edit kept the buttons");
});
