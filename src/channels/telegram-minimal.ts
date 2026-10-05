/**
 * The minimal Telegram card (APRV-489): one message, in plain words, with the
 * whole technical card collapsed inside it.
 *
 * The owner's complaint was that an approval prompt is "very verbose and
 * technical", and that the people approving (village residents on a phone) are
 * not engineers. The answer is a second LAYOUT of the same request, chosen by
 * the attested policy (`channels.telegram.prompt.style: minimal`). It is never
 * a second READING of the payload: SPEC.md §10.3 (amended APRV-489) lets the
 * canonical rendering be collapsed behind one tap, inside the message that
 * carries the buttons, and nothing more.
 *
 * ## What the card is made of, and who wrote each part
 *
 * ```
 * <b>Your agent wants to <phrase></b>          computed: chosen by the class the LOG records
 * <blockquote>quoted payload lines</blockquote> verbatim from the BOUND bytes, marked as a quote
 * <i>AI summary (not checked):</i> …            claimed: a model's sentence, below the quote
 * <i>Your agent says (not checked):</i> …       claimed: the agent's summary, below the quote
 * Open for about 3 days. If you don't answer…  computed: the gate's own window, from the log
 * <blockquote expandable>Full details …</blockquote>  the technical card, canonical rendering whole
 * [✅ Approve] [✋ Deny]                          the same callback data as the technical card
 * ```
 *
 * The phrase comes from the operator's attested `say.<class>.does`, from the
 * runtime's own table for the classes core emits, or from the payload's
 * structural kind. Nothing the agent writes can reach the first line.
 *
 * ## Quoted text is hostile input
 *
 * Every quoted value was written by the party asking for approval. So each one
 * is one line (a line break is drawn as ` ⏎ `), invisible, format and
 * bidirectional characters are drawn as `«U+202E»`, `«` and `⏎` themselves are
 * drawn the same way so the marking is injective, the length is bounded with an
 * explicit `…(cut; see full details)`, and the result is HTML-escaped. A value
 * therefore cannot start a line of its own, cannot close the quote box, cannot
 * open or close the collapsed block, and cannot be bold: the headline and the
 * deadline line are bold or outside the box, and nothing quoted can be either.
 *
 * ## When the card is NOT drawn
 *
 * Every case below is sent as the technical card instead, and the reason is
 * recorded on the decision ({@link MinimalFallback}): never a guessed or partial
 * minimal card.
 *
 * - an attestation prompt, a policy edit (`policy.*`, `log.*`, or a protected
 *   path): SPEC.md §10.3 wants the diff in front of the approver;
 * - a truncated payload, or none: there is no canonical rendering to collapse;
 * - an abnormal health row (a budget over, a policy not attested, an autonomy
 *   that is not `manual`): the reason to look is the technical card's;
 * - an opaque payload with no `say` declaration, with a key its `quote` map does
 *   not name (the closed-field-set rule of SPEC.md §9), that is not an object,
 *   or whose declaration quotes nothing;
 * - a card longer than {@link MINIMAL_MESSAGE_BUDGET}: the canonical rendering
 *   is never cut to fit.
 *
 * Pure: no clock, no IO. It imports nothing from `telegram.ts`, which calls it.
 */

import { LIVE_TOOL_CALL, type ChannelRequest } from "./contract.js";
import {
  changePayloadView,
  commandPayloadView,
  emailPayloadFields,
} from "../core/wysiwys.js";
import { sayEntryFor, type PromptSay, type PromptSayEntry } from "../core/prompt-layout.js";

/**
 * The longest a minimal card may be, in characters of HTML.
 *
 * Telegram's limit is 4096 characters after entity parsing; the raw HTML is
 * always at least as long, so a card under this is under the limit. The rest is
 * room for the line a relay prepends (the control plane's `Agent: <name>`,
 * name at most 48 characters), so the card stays one message there too.
 */
export const MINIMAL_MESSAGE_BUDGET = 3800;

/** The longest quoted value, in code points, before the cut marker. */
export const MINIMAL_QUOTE_MAX = 280;

/** The longest command shown whole on the card; a longer one is cut and its steps shown. */
export const MINIMAL_COMMAND_MAX = 160;

/** What a cut value ends with. Plain words, because the reader is not an engineer. */
export const MINIMAL_CUT_MARK = "…(cut; see full details)";

/** How a line break inside a quoted value is drawn. */
export const MINIMAL_NEWLINE_MARK = " ⏎ ";

/** How an empty quoted value is drawn (`«` is always marked in input, so this cannot be forged). */
export const MINIMAL_EMPTY_MARK = "«empty»";

/** The headline's fixed opening. */
export const MINIMAL_HEADLINE_PREFIX = "Your agent wants to ";

/** The labels on claimed lines: what wrote them, and that nobody checked. */
export const MINIMAL_GLOSS_LABEL = "AI summary (not checked):";
export const MINIMAL_SUMMARY_LABEL = "Your agent says (not checked):";
export const MINIMAL_COST_LABEL = "Your agent estimates the cost (not checked):";

/**
 * The computed line under the quote box when the box does not show every byte
 * of the payload in full (a value was cut). Plain words, and outside the box,
 * so no quoted text can produce or suppress it.
 */
export const MINIMAL_MORE_LINE = "⚠ There is more than fits here: open Full details before deciding.";

/**
 * The computed line under the quote box when the operator's declaration leaves
 * a field the payload carries off the simple card (a `~` key in `quote`).
 */
export const MINIMAL_HIDDEN_LINE = "Some of what your agent sent is shown only in Full details.";

/** The first line of the collapsed block: what a reader sees before tapping. */
export const MINIMAL_DETAILS_HEADING = "Full details (tap to open)";

/** The label of the reject button on a minimal card (R7: label only; the verb is still `r`). */
export const MINIMAL_DENY_LABEL = "✋ Deny";

/**
 * Why a request was sent as the technical card although the policy asked for
 * minimal. Recorded on the decision as `rendering.fallback`.
 */
export const MINIMAL_FALLBACKS = [
  "attestation",
  "policy",
  "no-payload",
  "truncated",
  "anomaly",
  "undeclared",
  "unlisted-key",
  "nothing-quoted",
  "too-long",
  "digest",
  "stale-summary",
] as const;

export type MinimalFallback = (typeof MINIMAL_FALLBACKS)[number];

/**
 * The phrases for the classes core itself emits (R3: core supplies phrases only
 * for its own built-in classes and payload kinds; an operator's class is
 * phrased by its attested `say` entry). `policy.edit` is absent on purpose: a
 * policy edit is always the technical card.
 */
export const BUILTIN_CLASS_PHRASES: Readonly<Record<string, string>> = {
  "network.call": "contact a website or online service",
  "read.web": "read a web page",
  "browser.exec": "use a web browser",
  "cron.manage": "change its scheduled jobs",
  "process.write": "control a program it is running",
  "skill.manage": "add or change one of its skills",
  "agent.delegate": "hand a task to another agent",
  "message.send": "send a message",
  "files.delete.scratch": "delete files in its scratch space",
};

/** The phrase for a structured payload kind, when the class has none. */
const KIND_PHRASES = {
  command: "run a command",
  "file-change": "change a file",
  email: "send an email",
} as const;

/** The technical card's three regions, as `renderTelegram` drew them. */
export interface TechnicalRegions {
  /** Heading, action key line (`<code>…</code>`), computed block. */
  header: string;
  /** The canonical rendering (or truncated text), plain, unescaped; `null` when there is none. */
  payloadText: string | null;
  /** The claimed block, already HTML. */
  claimedText: string;
  /** Whether any row the technical card shows carries the anomaly mark. */
  anomalous: boolean;
  /** The bold label the technical card puts over a one-chunk payload, already HTML. */
  payloadLabel: string;
}

/** A drawn minimal card. */
export interface MinimalCard {
  ok: true;
  /** The whole message, HTML. */
  text: string;
  /** The first line, HTML (kept for the settle edit). */
  headline: string;
  /** The collapsed block, HTML, `<blockquote expandable>` included (kept for the settle edit). */
  details: string;
}

/** A request the minimal card does not draw, and why. */
export interface MinimalRefusal {
  ok: false;
  reason: MinimalFallback;
}

/** The three characters Telegram's HTML mode treats as markup (same rule as `telegram.ts`). */
function escapeHtml(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

/** Characters drawn as `«U+XXXX»`: controls, format (bidi, zero-width), separators, private use, lone surrogates. */
const MARKED = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}]$/u;

/** One code point as the card draws it. */
function markOne(character: string): string {
  if (character === "\n") return MINIMAL_NEWLINE_MARK;
  if (character === "«" || character === "⏎" || MARKED.test(character)) {
    const code = character.codePointAt(0) ?? 0;
    return `«U+${code.toString(16).toUpperCase().padStart(4, "0")}»`;
  }
  return character;
}

/**
 * A quoted value as one marked, bounded, UNESCAPED line.
 *
 * Injective up to the cut: every output token comes from exactly one input
 * code point, and the tokens `«U+…»` and ` ⏎ ` arise only from marking,
 * because `«` and `⏎` in the input are themselves marked. The cut is taken
 * between tokens, so a mark is never split.
 */
export function quoteLine(value: string, max: number = MINIMAL_QUOTE_MAX): string {
  return drawQuote(value, max).text;
}

/** {@link quoteLine}, and whether the value was cut. */
function drawQuote(value: string, max: number): { text: string; cut: boolean } {
  if (value.length === 0) return { text: MINIMAL_EMPTY_MARK, cut: false };
  let out = "";
  let used = 0;
  for (const character of value) {
    const token = markOne(character);
    const cost = [...token].length;
    if (used + cost > max) return { text: `${out}${MINIMAL_CUT_MARK}`, cut: true };
    out += token;
    used += cost;
  }
  return { text: out, cut: false };
}

/** A value of any JSON type as text: strings as themselves, everything else as JSON. */
function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

/** One quote-box line, HTML: `<b>label:</b> value`, or the value alone for an empty label; and whether it was cut. */
function quoted(label: string, value: string, max: number = MINIMAL_QUOTE_MAX): { html: string; cut: boolean } {
  const line = drawQuote(value, max);
  const shown = escapeHtml(line.text);
  return { html: label.length === 0 ? shown : `<b>${escapeHtml(label)}:</b> ${shown}`, cut: line.cut };
}

/** A class name as the headline may show it: marked like a quoted value, one line, bounded. */
function className(actionClass: string): string {
  return quoteLine(actionClass, 80);
}

/** "about 4 minutes", "about 3 days": a duration a non-engineer reads at a glance. */
export function plainDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (ms < 60_000 || minutes < 1) return "less than a minute";
  if (minutes < 90) return `about ${String(minutes)} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 36) return `about ${String(hours)} hours`;
  const days = Math.round(ms / 86_400_000);
  return `about ${String(days)} day${days === 1 ? "" : "s"}`;
}

/**
 * How long the approver has and what doing nothing means, in plain words.
 *
 * Computed from the window the GATE judges the request by (`ttl_remaining_ms`:
 * the policy's TTL narrowed by a harness hook's cap, from the verified log) and
 * from whether the request is a tool call the agent is blocked in
 * ({@link LIVE_TOOL_CALL}, set by the tagger from the request record). Doing
 * nothing never makes anything happen: the only `on_expiry` is `reject`, and a
 * hook request that outlives its cap is withdrawn.
 */
export function deadlineLine(request: ChannelRequest): string {
  const ms = request.ttl_remaining_ms.value;
  const toolCall = request[LIVE_TOOL_CALL]?.value === true;
  if (ms === null) {
    return toolCall
      ? "Your agent is waiting. There is no time limit on this question."
      : "There is no time limit. Nothing happens until you answer.";
  }
  const left = plainDuration(ms);
  return toolCall
    ? `Your agent is waiting: ${left} left. If you don't answer, it will not do this.`
    : `Open for ${left}. If you don't answer, your agent will not do this.`;
}

/** The quote-box lines for a payload, or why there are none. */
function excerptOf(
  value: unknown,
  entry: PromptSayEntry | null,
  breakdown: string | null,
): Excerpt | MinimalRefusal {
  const command = commandPayloadView(value);
  if (command !== null) {
    const whole = !command.command.includes("\n") && [...command.command].length <= MINIMAL_COMMAND_MAX;
    const lines = [quoted("", command.command, MINIMAL_COMMAND_MAX)];
    // Where it runs is part of what it does (`rm -rf *` in a scratch folder
    // and in a home folder are different requests), so it is always shown.
    if (command.cwd !== null) lines.push(quoted("In folder", command.cwd));
    if (!whole && breakdown !== null) lines.push(quoted("Steps", breakdown));
    // A command shown only in part is ALWAYS flagged, even when the steps line
    // happens to fit: the steps are the classifier's abbreviation, not the bytes.
    return excerpt("command", lines, !whole);
  }

  const change = changePayloadView(value);
  if (change !== null) {
    const file = change.labels.find((field) => field.label === "file")?.text ?? "";
    const lines = [quoted("File", file)];
    if (change.before === null) {
      lines.push(quoted("New content", change.after));
    } else {
      lines.push(quoted("Replaces", change.before), quoted("With", change.after));
    }
    // `replace_all: true` changes every match, not one: the same before/after
    // text means a different edit, so it is on the card whenever it is set.
    if (change.labels.some((field) => field.label === "replace_all" && field.text === "true")) {
      lines.push(quoted("Every match", "yes"));
    }
    return excerpt("file-change", lines, false);
  }

  const email = emailPayloadFields(value);
  if (email !== null) {
    const labels: Record<string, string> = {
      from: "From",
      to: "To",
      cc: "Cc",
      bcc: "Bcc",
      subject: "Subject",
      body: "Message",
      content_type: "Format",
    };
    const lines: { html: string; cut: boolean }[] = [];
    for (const field of email) {
      const label = labels[field.label];
      if (label !== undefined) lines.push(quoted(label, field.text));
    }
    return excerpt("email", lines, false);
  }

  // Opaque: the closed field set is the operator's declaration, or nothing.
  if (entry === null || entry.quote === undefined) return { ok: false, reason: "undeclared" };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "undeclared" };
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!Object.prototype.hasOwnProperty.call(entry.quote, key)) {
      return { ok: false, reason: "unlisted-key" };
    }
  }
  const lines: { html: string; cut: boolean }[] = [];
  let hidden = false;
  for (const [key, label] of Object.entries(entry.quote)) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    if (label === null) {
      hidden = true;
      continue;
    }
    lines.push(quoted(label, valueText(record[key])));
  }
  if (lines.length === 0) return { ok: false, reason: "nothing-quoted" };
  return { ...excerpt("opaque", lines, false), hidden };
}

/** What the quote box holds, and what it does not show. */
interface Excerpt {
  kind: keyof typeof KIND_PHRASES | "opaque";
  /** HTML lines inside the box. */
  lines: string[];
  /** Some value was cut, or (a command) not shown whole: the card must say so. */
  partial: boolean;
  /** The declaration left a field the payload carries off the card. */
  hidden: boolean;
}

function excerpt(
  kind: Excerpt["kind"],
  lines: { html: string; cut: boolean }[],
  partial: boolean,
): Excerpt {
  return {
    kind,
    lines: lines.map((line) => line.html),
    partial: partial || lines.some((line) => line.cut),
    hidden: false,
  };
}

/**
 * The collapsed block: the technical card's three regions, in the order the
 * technical card sends them, inside one expandable blockquote.
 *
 * Two wrappers are dropped and nothing else changes: the `<code>` around the
 * action key and the `<pre>` around the canonical rendering. The Bot API's
 * formatting rules (core.telegram.org/bots/api#formatting-options) let bold and
 * italic sit inside any entity, say blockquotes cannot nest, and say the other
 * entities cannot contain each other, so `pre` and `code` inside a blockquote
 * are not a combination this card relies on. The TEXT is unchanged character
 * for character: the canonical rendering is escaped exactly as inside `<pre>`,
 * so what the reader sees, and what a test decodes back, is the rendering byte
 * for byte.
 */
export function detailsBlock(technical: TechnicalRegions): string {
  const header = technical.header
    .split("\n")
    .map((entry) => {
      const match = /^<code>([^<]*)<\/code>$/u.exec(entry);
      return match === null ? entry : (match[1] ?? "");
    })
    .join("\n");
  const parts = [`<b>${escapeHtml(MINIMAL_DETAILS_HEADING)}</b>`, header];
  if (technical.payloadText !== null) {
    parts.push("", `${technical.payloadLabel}\n${escapeHtml(technical.payloadText)}`);
  }
  parts.push("", technical.claimedText);
  return `<blockquote expandable>${parts.join("\n")}</blockquote>`;
}

/** Classes whose prompt is always technical: the gate's own organs. */
function isPolicyClass(actionClass: string): boolean {
  return actionClass.startsWith("policy.") || actionClass === "policy" || actionClass.startsWith("log.");
}

/**
 * Draw the minimal card for `request`, or say why it is not drawn.
 *
 * `technical` is `renderTelegram`'s output for the same request under the same
 * layout, so the collapsed block is the technical card and nothing else.
 */
export function renderTelegramMinimal(
  request: ChannelRequest,
  technical: TechnicalRegions,
  say: PromptSay,
): MinimalCard | MinimalRefusal {
  if (request.policy_diff !== undefined || request.policy_load !== undefined) {
    return { ok: false, reason: "attestation" };
  }
  const actionClass = request.class.value;
  if (isPolicyClass(actionClass) || request.protected_path !== undefined) {
    return { ok: false, reason: "policy" };
  }
  const payload = request.fullPayload.value;
  if (payload === null || technical.payloadText === null) return { ok: false, reason: "no-payload" };
  if (payload.truncated) return { ok: false, reason: "truncated" };
  if (technical.anomalous) return { ok: false, reason: "anomaly" };

  const declared = sayEntryFor(say, actionClass);
  const entry = declared?.entry ?? null;
  const excerpt = excerptOf(
    payload.value,
    entry,
    request.command_breakdown === undefined ? null : request.command_breakdown.value,
  );
  if ("ok" in excerpt) return excerpt;

  const builtin = Object.prototype.hasOwnProperty.call(BUILTIN_CLASS_PHRASES, actionClass)
    ? BUILTIN_CLASS_PHRASES[actionClass]
    : undefined;
  let phrase: string;
  if (entry !== null) phrase = entry.does;
  else if (builtin !== undefined) phrase = builtin;
  else if (excerpt.kind !== "opaque") phrase = `${KIND_PHRASES[excerpt.kind]} (type: ${className(actionClass)})`;
  else return { ok: false, reason: "undeclared" };

  const headline = `<b>${escapeHtml(`${MINIMAL_HEADLINE_PREFIX}${phrase}`)}</b>`;

  const lines = [headline, `<blockquote>${excerpt.lines.join("\n")}</blockquote>`];
  // Computed, outside the box, before any claimed line: what the box does NOT
  // show. A partial excerpt is never presented as if it were the whole.
  if (excerpt.partial) lines.push(escapeHtml(MINIMAL_MORE_LINE));
  if (excerpt.hidden) lines.push(escapeHtml(MINIMAL_HIDDEN_LINE));
  // Claimed lines: only below the quote, always labelled, always one line.
  if (request.gloss !== undefined && request.gloss.value.trim().length > 0) {
    lines.push(`<i>${escapeHtml(MINIMAL_GLOSS_LABEL)}</i> ${escapeHtml(quoteLine(request.gloss.value))}`);
  }
  const showSummary = entry !== null && (entry.note ?? "summary") === "summary";
  const summary = request.summary.value;
  if (showSummary && summary !== null && summary.trim().length > 0) {
    lines.push(`<i>${escapeHtml(MINIMAL_SUMMARY_LABEL)}</i> ${escapeHtml(quoteLine(summary))}`);
  }
  if (request.est_cost_usd.value > 0) {
    lines.push(
      `<i>${escapeHtml(MINIMAL_COST_LABEL)}</i> ${escapeHtml(`$${request.est_cost_usd.value.toFixed(2)}`)}`,
    );
  }
  lines.push(escapeHtml(deadlineLine(request)));

  const details = detailsBlock(technical);
  const text = `${lines.join("\n")}\n${details}`;
  if (text.length > MINIMAL_MESSAGE_BUDGET) return { ok: false, reason: "too-long" };
  return { ok: true, text, headline, details };
}
