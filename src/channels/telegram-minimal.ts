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
 * The phrase comes from the runtime's own table for the classes core emits;
 * else, for a payload the runtime reads itself (a command, a file change, an
 * email), from that payload's kind with `(type: <class>)`; else, for an opaque
 * payload only, from the operator's attested `say.<class>.does` (R3-S1).
 * Nothing the agent writes can reach the first line.
 *
 * ## Quoted text is hostile input
 *
 * Every quoted value was written by the party asking for approval. So each one
 * is one line (a line break is drawn as ` ⏎ `); control, format, bidirectional,
 * default-ignorable and blank-looking characters, and combining marks beyond two
 * on one character, are drawn as `«U+202E»`; `«` and `⏎` themselves are drawn
 * the same way so the marking is injective; the length is bounded with an
 * explicit `…(cut; see full details)` taken between grapheme clusters; and the
 * result is HTML-escaped. A value therefore cannot start a line of its own,
 * cannot close the quote box, cannot open or close the collapsed block, and
 * cannot be bold: the headline and the deadline line are bold or outside the
 * box, and nothing quoted can be either.
 *
 * ## The box holds payload bytes and nothing else (fix round 2, B1)
 *
 * Every line inside the quote box is ONE payload value, verbatim (marked and,
 * where cut, visibly cut), under a label: the operator's attested label, or the
 * runtime's fixed label for a field of a shape the runtime knows (`From`,
 * `In folder`, `replace_all`, …). Nothing computed or paraphrased goes inside
 * the box: no outline of a command, no "yes" for `true`. What the box does not
 * show is said OUTSIDE it, by computed notices: a cut, and the names of fields
 * not quoted.
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
import { commandSegmentWords } from "../core/command-class.js";
import {
  changePayloadView,
  commandPayloadView,
  emailPayloadFields,
} from "../core/wysiwys.js";
import {
  BUILTIN_CLASS_PHRASES,
  sayEntryFor,
  type PromptSay,
  type PromptSayEntry,
} from "../core/prompt-layout.js";

/**
 * The longest a minimal card may be, in characters of HTML.
 *
 * Telegram's limit is 4096 characters after entity parsing; the raw HTML is
 * always at least as long, so a card under this is under the limit. The rest is
 * room for the line a relay prepends (the control plane's `Agent: <name>`,
 * name at most 48 characters), so the card stays one message there too.
 */
export const MINIMAL_MESSAGE_BUDGET = 3800;

/** The longest key name a hidden-fields notice names, in code points. */
export const MINIMAL_KEY_MAX = 64;

/** The longest quoted value, in code points, before the cut marker. */
export const MINIMAL_QUOTE_MAX = 280;

/** The longest command shown whole on the card; a longer one is cut, visibly, and announced. */
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
 * The computed line under the quote box when the box leaves a field the payload
 * carries unquoted (a `~` key in the operator's `quote` map), naming the
 * fields by the payload's own key names, marked like quoted text (S5).
 */
export function hiddenFieldsLine(keys: readonly string[]): string {
  const names = keys.map((key) => isolate(quoteLine(key, MINIMAL_KEY_MAX - 2))).join(", ");
  return `Not shown here: ${names}. Open Full details before deciding.`;
}

/** The fixed opening of {@link hiddenFieldsLine}, for tests and for readers. */
export const MINIMAL_HIDDEN_PREFIX = "Not shown here: ";

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
  "batch",
  "send-refused",
  "policy-unattested",
] as const;

export type MinimalFallback = (typeof MINIMAL_FALLBACKS)[number];

/** The phrases for the classes core itself emits; the table lives in `core/prompt-layout.ts` (R2-S2). */
export { BUILTIN_CLASS_PHRASES };

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
  /**
   * Present, and `true`, when the class's `say` entry set a `does` phrase and
   * the runtime drew its own kind phrase instead, because it reads the payload
   * itself (R3-S1). Recorded on the decision as `rendering.say_does_ignored`.
   */
  sayDoesIgnored?: true;
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

/**
 * Characters drawn as `«U+XXXX»`: controls, format (bidi, zero-width), line and
 * paragraph separators, private use, lone surrogates, every default-ignorable
 * code point (variation selectors, U+034F, the Khmer and Mongolian invisibles,
 * tag characters, …), and the blank-looking letters and symbols that are not
 * default-ignorable: the Hangul fillers U+115F, U+1160, U+3164, U+FFA0 and the
 * braille blank U+2800 (S1).
 */
const MARKED =
  /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Default_Ignorable_Code_Point}\u115F\u1160\u3164\uFFA0\u2800]$/u;

/** A combining mark. */
const COMBINING = /^\p{M}$/u;

/** Combining marks drawn as themselves on one character; the rest are marked. */
export const MINIMAL_COMBINING_MAX = 2;


/** `«U+XXXX»` for one code point. */
function codeMark(character: string): string {
  const code = character.codePointAt(0) ?? 0;
  return `«U+${code.toString(16).toUpperCase().padStart(4, "0")}»`;
}

/**
 * A recognised emoji sequence (Unicode's RGI set: `\p{RGI_Emoji}`, a property
 * of strings that needs the regular expression `v` flag), or `null` on a
 * runtime without it (fix round 3, R2-B1).
 *
 * A grapheme cluster is drawn untouched ONLY when the whole cluster is one such
 * sequence (❤️, 👨‍👩‍👧, 1️⃣, 🏴 with its tag characters): then every
 * presentation selector, joiner and tag in it is part of the emoji's look. In
 * every other cluster each of them is marked, so U+FE0F after a face that is
 * already an emoji, or U+200D between two pictographs that form no emoji, cannot
 * carry hidden bits. On a runtime without the property the answer is `null`
 * and NOTHING is exempt: every selector and joiner is marked. Node 20, this
 * package's floor, ships V8 11.3, which supports the `v` flag (V8 11.2).
 */
const RGI_EMOJI: RegExp | null = (() => {
  try {
    return new RegExp("^\\p{RGI_Emoji}$", "v");
  } catch {
    return null;
  }
})();

/** Whether `cluster` is drawn as itself: a recognised emoji sequence, on a runtime that can tell. */
export function isRecognisedEmoji(cluster: string): boolean {
  return RGI_EMOJI !== null && RGI_EMOJI.test(cluster);
}

/**
 * One grapheme cluster as the card draws it. A recognised emoji sequence is
 * itself; in any other cluster every marked character, including every
 * presentation selector and joiner, is drawn `«U+XXXX»`.
 */
function drawCluster(cluster: string): string {
  if (isRecognisedEmoji(cluster)) return cluster;
  const points = [...cluster];
  let out = "";
  let marks = 0;
  for (const character of points) {
    if (character === "\n") {
      out += MINIMAL_NEWLINE_MARK;
      marks = 0;
      continue;
    }
    if (character === "«" || character === "⏎") {
      out += codeMark(character);
      marks = 0;
      continue;
    }
    if (MARKED.test(character)) {
      out += codeMark(character);
      continue;
    }
    if (COMBINING.test(character)) {
      marks += 1;
      out += marks > MINIMAL_COMBINING_MAX ? codeMark(character) : character;
      continue;
    }
    marks = 0;
    out += character;
  }
  return out;
}

/** Grapheme clusters, so a cut never splits a flag, an emoji sequence or a letter with its accents. */
const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * A quoted value as one marked, bounded, UNESCAPED line.
 *
 * Injective up to the cut: every output token comes from exactly one input
 * code point, and the tokens `«U+…»` and ` ⏎ ` arise only from marking,
 * because `«` and `⏎` in the input are themselves marked. The cut is taken
 * between grapheme clusters, so neither a mark nor a cluster is ever split.
 *
 * Injective is not the same as "never looks the same". Two different values can
 * still look alike to a reader: look-alike letters from other scripts
 * (Cyrillic а and Latin a), a lone emoji with and without its presentation
 * selector, and runs of ordinary spaces are drawn as themselves. The marking
 * removes the invisible differences, not the visible but subtle ones.
 */
export function quoteLine(value: string, max: number = MINIMAL_QUOTE_MAX): string {
  return drawQuote(value, max).text;
}

/** {@link quoteLine}, and whether the value was cut. */
function drawQuote(value: string, max: number): { text: string; cut: boolean } {
  if (value.length === 0) return { text: MINIMAL_EMPTY_MARK, cut: false };
  let out = "";
  let used = 0;
  for (const { segment } of GRAPHEMES.segment(value)) {
    const token = drawCluster(segment);
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

/**
 * The runtime's own first-strong isolate around every quoted value (fix round
 * 3, R2-S1). Letters of a right-to-left script reorder the digits and words
 * near them with no control character present (`pay 100 א 5`); inside an
 * isolate a value can reorder only what is inside the isolate, never its
 * label, a neighbouring line or the card's text around it. What is inside
 * includes the cut mark, which is drawn within the value's isolate: a cut
 * right-to-left value shows `…(cut; see full details)` at its LEFT edge (the
 * end, in its reading order). The mark is still on the line and still visible,
 * and the computed notice under the box says the same thing outside any
 * isolate. Added AFTER marking, so payload U+2068/U+2069 are still marked and
 * these two never are; counted in every length bound; never inside the
 * collapsed block, which stays the technical card byte for byte.
 *
 * Quoted values, hidden-field names and the class name in a headline are
 * isolated. The operator's attested `does` phrase is NOT: it is drawn as
 * written inside the bold headline, so a right-to-left phrase follows the
 * ordinary bidirectional rules within that one line (R3-S2).
 */
export const ISOLATE_OPEN = "\u2068";
export const ISOLATE_CLOSE = "\u2069";

function isolate(text: string): string {
  return `${ISOLATE_OPEN}${text}${ISOLATE_CLOSE}`;
}

/** A value drawn, bounded (the two isolate characters counted), escaped and isolated. */
function drawIsolated(value: string, max: number): { html: string; cut: boolean } {
  const line = drawQuote(value, Math.max(1, max - 2));
  return { html: isolate(escapeHtml(line.text)), cut: line.cut };
}

/** One quote-box line, HTML: `<b>label:</b> value`, or the value alone for an empty label; and whether it was cut. */
function quoted(label: string, value: string, max: number = MINIMAL_QUOTE_MAX): QuoteLine {
  const line = drawIsolated(value, max);
  return { html: label.length === 0 ? line.html : `<b>${escapeHtml(label)}:</b> ${line.html}`, cut: line.cut, label };
}

/** One quote-box line and what the box rule needs to know about it. */
interface QuoteLine {
  html: string;
  cut: boolean;
  label: string;
}

/** A class name as the headline may show it: marked like a quoted value, bounded, isolated. */
function className(actionClass: string): string {
  return isolate(quoteLine(actionClass, 78));
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
  if (ms <= 0) return "Time is up: this request has closed, and an answer now will not count.";
  const left = plainDuration(ms);
  return toolCall
    ? `Your agent is waiting: ${left} left. If you don't answer, it will not do this.`
    : `Open for ${left}. If you don't answer, your agent will not do this.`;
}

/**
 * The computed line under a command's quote box when the box does NOT show the
 * whole command (fix round 4, R3-B1), or `null` when it does.
 *
 * A notice of what the box leaves out, and nothing else (SPEC.md §10.3,
 * amended). A command shown whole gets no line at all, whatever it contains:
 * the bytes are in the box, and the card makes no claim about how many
 * commands they are or what they run. The classifier's segment count does not
 * see commands started inside other commands (a here-document piped into a
 * shell, `$( … )`, backticks, `bash -c '…'`, `eval`), so the count can only be
 * a LOWER bound: the cut form says "at least N", and only when N is two or
 * more. `count` is that count, or `null` when the classifier cannot read the
 * command. The line never names or paraphrases a command the box does not show.
 */
export function commandNotice(count: number | null, cut: boolean): string | null {
  if (!cut) return null;
  if (count === null) {
    return "⚠ More than one command may be here, and only the beginning is shown above: open Full details before deciding.";
  }
  return count > 1
    ? `⚠ This runs at least ${String(count)} commands. Only the beginning is shown above: open Full details before deciding.`
    : "⚠ Only the beginning of this command is shown above: open Full details before deciding.";
}

/** The quote-box lines for a payload, or why there are none. */
function excerptOf(value: unknown, entry: PromptSayEntry | null): Excerpt | MinimalRefusal {
  const command = commandPayloadView(value);
  if (command !== null) {
    // R2-B2: a value stands alone only when it is the only quotation, so the
    // command takes a label whenever its folder is quoted too.
    const commandLine = quoted(command.cwd === null ? "" : "Command", command.command, MINIMAL_COMMAND_MAX);
    const lines = [commandLine];
    // Where it runs is part of what it does (`rm -rf *` in a scratch folder
    // and in a home folder are different requests), so it is always shown.
    const folder = command.cwd === null ? null : quoted("In folder", command.cwd);
    if (folder !== null) lines.push(folder);
    // B1: no outline of the command inside the box, and none outside it. The
    // classifier's breakdown drops flags and their values, which is exactly
    // where a deletion target or an uploaded file lives. What the card says
    // instead is COMPUTED, outside the box, and only when the command is cut:
    // that only the beginning is shown, with the classifier's count as a lower
    // bound (R3-B1: a whole command carries no count line).
    const segments = commandSegmentWords(command.command);
    return {
      ...excerpt("command", lines, false),
      // The command line's own cut is said by the command notice below; the
      // generic warning is left for the folder line alone.
      partial: folder?.cut === true,
      commandNotice: commandNotice(segments === null ? null : segments.length, commandLine.cut),
    };
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
    // Every other field of the shape, under its own key name and verbatim
    // value (B1: `replace_all: true`, never a paraphrase of it).
    for (const field of change.labels) {
      if (field.label !== "file") lines.push(quoted(field.label, field.text));
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
    const lines: QuoteLine[] = [];
    const record = value as Record<string, unknown>;
    for (const field of email) {
      const label = labels[field.label];
      if (label === undefined) continue;
      // R2-B2: a list of addresses is one quoted line PER ADDRESS under the
      // same label, never the addresses joined with ", " (which would draw
      // ["a, b"] and ["a", "b"] the same).
      const raw = record[field.label];
      if (Array.isArray(raw)) {
        for (const address of raw as string[]) lines.push(quoted(label, address));
      } else {
        lines.push(quoted(label, field.text));
      }
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
  const lines: QuoteLine[] = [];
  const hidden: string[] = [];
  for (const [key, label] of Object.entries(entry.quote)) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    if (label === null) {
      hidden.push(key);
      continue;
    }
    lines.push(quoted(label, valueText(record[key])));
  }
  if (lines.length === 0) return { ok: false, reason: "nothing-quoted" };
  // R2-B2: an unlabelled value only as the ONLY quotation. A loaded policy
  // cannot declare otherwise (refused at load); a hand-built map falls back.
  if (lines.length > 1 && lines.some((line) => line.label.length === 0)) {
    return { ok: false, reason: "undeclared" };
  }
  return { ...excerpt("opaque", lines, false), hidden };
}

/** What the quote box holds, and what it does not show. */
interface Excerpt {
  kind: keyof typeof KIND_PHRASES | "opaque";
  /** HTML lines inside the box. */
  lines: string[];
  /** Some value was cut, or (a command) not shown whole: the card must say so. */
  partial: boolean;
  /** Payload keys the declaration leaves off the card, in declaration order. */
  hidden: string[];
  /** A command's computed notice, replacing the generic warning for its command line. */
  commandNotice?: string | null;
}

function excerpt(kind: Excerpt["kind"], lines: QuoteLine[], partial: boolean): Excerpt {
  return {
    kind,
    lines: lines.map((line) => line.html),
    partial: partial || lines.some((line) => line.cut),
    hidden: [],
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
  // Any abnormal health fact draws the technical card, whether or not the
  // operator's row layout would have shown its row (fix round 2, S7): a hidden
  // row must not let an unattested policy, a budget over its ceiling or an
  // autonomy that is not manual reach the approver as a simple card.
  if (
    technical.anomalous ||
    request.autonomy.value !== "manual" ||
    !request.budgets.value.every((verdict) => verdict.pass) ||
    request.attestation.value.status !== "attested"
  ) {
    return { ok: false, reason: "anomaly" };
  }

  const declared = sayEntryFor(say, actionClass);
  const entry = declared?.entry ?? null;
  const excerpt = excerptOf(payload.value, entry);
  if ("ok" in excerpt) return excerpt;

  const builtin = Object.prototype.hasOwnProperty.call(BUILTIN_CLASS_PHRASES, actionClass)
    ? BUILTIN_CLASS_PHRASES[actionClass]
    : undefined;
  // R2-S2: core's own phrase always wins for core's own classes (a say entry
  // may not set `does` for them; refused at load).
  // R3-S1: the runtime's kind phrase always wins for a payload the runtime
  // reads itself (a command, a file change, an email), whatever the class: an
  // operator's `does` is for payloads the runtime cannot read, which is what
  // `say` exists for. A `does` for a class the classifier emits is refused at
  // load (`prompt-say-kind`); for any other class the payload's kind is known
  // only here, so the phrase is ignored here and the card says so to the
  // caller, which notes it on the decision record.
  let phrase: string;
  let sayDoesIgnored = false;
  if (builtin !== undefined) phrase = builtin;
  else if (excerpt.kind !== "opaque") {
    phrase = `${KIND_PHRASES[excerpt.kind]} (type: ${className(actionClass)})`;
    sayDoesIgnored = entry?.does !== undefined;
  } else if (entry?.does !== undefined) phrase = entry.does;
  else return { ok: false, reason: "undeclared" };

  const headline = `<b>${escapeHtml(`${MINIMAL_HEADLINE_PREFIX}${phrase}`)}</b>`;

  const lines = [headline, `<blockquote>${excerpt.lines.join("\n")}</blockquote>`];
  // Computed, outside the box, before any claimed line: what the box does NOT
  // show. A partial excerpt is never presented as if it were the whole.
  if (excerpt.commandNotice !== undefined && excerpt.commandNotice !== null) {
    lines.push(escapeHtml(excerpt.commandNotice));
  }
  if (excerpt.partial) lines.push(escapeHtml(MINIMAL_MORE_LINE));
  if (excerpt.hidden.length > 0) lines.push(escapeHtml(hiddenFieldsLine(excerpt.hidden)));
  // Claimed lines: only below the quote, always labelled, always one line.
  if (request.gloss !== undefined && request.gloss.value.trim().length > 0) {
    lines.push(`<i>${escapeHtml(MINIMAL_GLOSS_LABEL)}</i> ${drawIsolated(request.gloss.value, MINIMAL_QUOTE_MAX).html}`);
  }
  const showSummary = entry !== null && (entry.note ?? "summary") === "summary";
  const summary = request.summary.value;
  if (showSummary && summary !== null && summary.trim().length > 0) {
    lines.push(`<i>${escapeHtml(MINIMAL_SUMMARY_LABEL)}</i> ${drawIsolated(summary, MINIMAL_QUOTE_MAX).html}`);
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
  return { ok: true, text, headline, details, ...(sayDoesIgnored ? { sayDoesIgnored: true as const } : {}) };
}
