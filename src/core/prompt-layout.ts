/**
 * Prompt layout: which INFORMATIONAL rows a channel puts in front of an
 * approver, as a policy decision rather than a code decision (APRV-218).
 *
 * SPEC.md §5.2 gains `channels.<name>.prompt`; SPEC.md §10.3 already says a
 * channel holds no truth, and this module is what keeps that so — the block
 * decides what is SHOWN, never what is true, and every field it can reach was
 * already on the `ChannelRequest` and already in `--json`, `approval queue` and
 * the web page. Nothing here reads the log, and no key added here lets a
 * channel learn anything about it.
 *
 * ## Why this is a policy key at all
 *
 * The Telegram prompt was slimmed deliberately: APRV-143 dropped the `ttl` row
 * because the `waiting … expires HH:MM UTC` line already states the deadline,
 * and APRV-163 dropped six bookkeeping rows and made three health rows render
 * only when abnormal. That layout fits ONE operator's workflow. Another wants
 * the budget line on every prompt, or the TTL as a duration, or the task id
 * always visible. Those are preferences about a screen, and preferences about a
 * screen belong in the policy file beside the other things an operator chooses,
 * not in a `git blame` argument about a default.
 *
 * ## What a layout may NOT do
 *
 * A layout chooses among rows the approver may read. It cannot touch what the
 * approver SIGNS. Three things are therefore out of its reach entirely:
 *
 * 1. **The canonical block** (SPEC.md §9's "what you see is what you sign") is
 *    not a row. It carries the payload bytes, the renderer version, the class,
 *    the kind and the bound `payload sha256`, it is rendered verbatim, and no
 *    key in this module can reorder, shorten, or remove it.
 * 2. **The computed/claimed split.** A row's side of the boundary is a property
 *    of the field (`TaggedField.kind`), not of the layout. `rows` reorders; it
 *    cannot move a claimed line into the computed block, because a channel
 *    partitions by kind AFTER it applies the order. That is the property
 *    APRV-144's CLAIMED heading exists for, and a test pins it.
 * 3. **{@link REQUIRED_PROMPT_ROWS}**, the rows the contract marks as required
 *    for a decision. Naming one in `hide` is a policy that fails to load.
 *
 * The buttons are not a row either, for the same reason the block is not: a
 * prompt with no way to answer it is not a prompt.
 *
 * ## Fail directions
 *
 * Soft on ABSENCE, closed on INVALIDITY, which is the split every other policy
 * key in this runtime keeps. No `prompt` block, or a policy that did not load,
 * means today's rows: a layout is not a permission, and an unrelated typo in a
 * class rule must not silently redecorate a phone screen. An unknown row name
 * or a required row in `hide` is a statement the runtime cannot honour, so the
 * WHOLE policy fails schema validation and every class resolves to `manual` —
 * the operator repairs the file, and until they do the gate is at its
 * strictest.
 *
 * Pure: no clock, no IO, no environment. It sits in `core/` rather than in
 * `channels/` for `core/telegram-config.ts`'s reason — more than one layer asks
 * "which rows does this policy want?" and none of them may answer differently —
 * and it imports nothing from `channels/`, so `tests/layering.test.ts` stays
 * true. The row names below are the `ChannelRequest` member names spelled as
 * plain strings for exactly that reason.
 */

import type { Policy, PolicyLoadResult } from "./policy-load.js";
import type { ValidationError } from "./validate.js";

/**
 * The row vocabulary: every `ChannelRequest` member a channel renders as a row.
 *
 * Closed, and closed for `delivery`'s reason (APRV-216): a name this runtime
 * cannot place is a row the author believes is in force that nothing reads, and
 * guessing at it would be the silent no-op the whole policy schema is shaped to
 * prevent.
 *
 * `fullPayload` is deliberately ABSENT. The canonical block is not a row.
 */
export const PROMPT_ROWS = [
  "action_key",
  "task",
  "class",
  "command_breakdown",
  "protected_path",
  "policy_diff",
  "policy_load",
  "autonomy",
  "provenance",
  "state",
  "requested_ts",
  "waiting",
  "ttl_remaining_ms",
  "payload_hash",
  "attestation",
  "budgets",
  "chain",
  "token_delivery",
  "est_cost_usd",
  "gloss",
  "summary",
  "rationale",
  "confidence",
] as const;

/** One row name from {@link PROMPT_ROWS}. */
export type PromptRow = (typeof PROMPT_ROWS)[number];

/** Whether a string is a row name this runtime knows how to place. */
export function isPromptRow(value: unknown): value is PromptRow {
  return typeof value === "string" && (PROMPT_ROWS as readonly string[]).includes(value);
}

/**
 * The rows an operator may reorder but never remove.
 *
 * Each is required for a DECISION rather than for a screen. `action_key`
 * identifies which request the gesture answers; `class` is the resolution the
 * whole gate turns on; `command_breakdown` and `protected_path` are APRV-144
 * and APRV-143's answer to "what does this command actually do, and which
 * protected path earned the class", derived from the bound bytes by the same
 * classifier the hook decided with; `policy_diff` and `policy_load` are what
 * SPEC.md §10.3 requires of an attestation prompt, where "a prompt carrying
 * only a hash asks a human to sign for sixty-four characters and is a
 * conformance failure".
 *
 * `payload_hash` is NOT here, and its absence is not an oversight. The bound
 * hash is stated inside the canonical block on every channel, and the block is
 * out of a layout's reach, so an operator who hides the row removes a
 * duplicate rather than the binding. Telegram's default layout already does
 * exactly that (APRV-163).
 *
 * A required row a request does not CARRY renders nothing, as it does today.
 * Requirement is about what a policy may instruct, not about what a particular
 * request happens to hold.
 */
export const REQUIRED_PROMPT_ROWS: readonly PromptRow[] = [
  "action_key",
  "class",
  "command_breakdown",
  "protected_path",
  "policy_diff",
  "policy_load",
];

/**
 * How a row renders when nothing in the policy says otherwise.
 *
 * - `always` — on every prompt the request carries the field for.
 * - `abnormal` — only when the value is the reason to look. APRV-163's
 *   argument: a row that says "everything is fine" on every ordinary request is
 *   a row a reader learns to skip, and the skipping does not stop on the one
 *   request where it says something else.
 * - `off` — the channel does not render it by default. The field still travels
 *   on the request, so `--json`, `approval queue` and the web page carry it.
 */
export type RowVisibility = "always" | "abnormal" | "off";

/** A resolved layout: the order rows render in, and each row's visibility. */
export interface PromptLayout {
  /** Every row in {@link PROMPT_ROWS}, in render order. */
  order: readonly PromptRow[];
  /** Visibility per row. Total: every row name has an entry. */
  visibility: Readonly<Record<PromptRow, RowVisibility>>;
}

/** The channels this runtime ships (SPEC.md §10.3). */
export const PROMPT_CHANNELS = ["cli", "web", "telegram"] as const;

/** One of the three shipped channel names. */
export type PromptChannel = (typeof PROMPT_CHANNELS)[number];

function layoutOf(order: readonly PromptRow[], visibility: Partial<Record<PromptRow, RowVisibility>>): PromptLayout {
  const full = {} as Record<PromptRow, RowVisibility>;
  for (const row of PROMPT_ROWS) full[row] = visibility[row] ?? "off";
  return { order, visibility: full };
}

/**
 * Telegram's default layout: the slimmed phone prompt, exactly as APRV-143 and
 * APRV-163 left it.
 *
 * The ORDER of the rows that render is load-bearing and must not drift: it is
 * the sequence a reader's eye has learned. The `off` rows are interleaved where
 * they belong if an operator turns them on, which costs nothing while they are
 * off and saves an operator from writing a `rows` list to get a sensible
 * position.
 *
 * `action_key` is `off` here because Telegram renders it STRUCTURALLY, as the
 * message's second line in a `<code>` span. It is required, so it cannot be
 * hidden, and it is not a bullet, so promoting it changes nothing.
 */
export const TELEGRAM_PROMPT_LAYOUT: PromptLayout = layoutOf(
  [
    "action_key",
    "task",
    "class",
    "command_breakdown",
    "protected_path",
    "policy_diff",
    "policy_load",
    "autonomy",
    "budgets",
    "attestation",
    "provenance",
    "state",
    "requested_ts",
    "waiting",
    "ttl_remaining_ms",
    "payload_hash",
    "chain",
    "token_delivery",
    "gloss",
    "summary",
    "est_cost_usd",
    "rationale",
    "confidence",
  ],
  {
    class: "always",
    command_breakdown: "always",
    protected_path: "always",
    policy_diff: "always",
    policy_load: "always",
    autonomy: "abnormal",
    budgets: "abnormal",
    attestation: "abnormal",
    waiting: "always",
    gloss: "always",
    summary: "always",
    est_cost_usd: "always",
    rationale: "always",
    confidence: "always",
  },
);

/**
 * The order the terminal and the page have used since APRV-23: computed
 * identity and authority first, claimed persuasion last, so a reader who stops
 * halfway has read the runtime's answer and not the agent's pitch.
 *
 * `token_delivery` sits at the end because that is where it lands today —
 * neither channel's `FIELD_ORDER` named it, and both append a member they do
 * not list. Naming it here makes it reachable by `hide` and `rows` without
 * moving it.
 */
const FULL_ROW_ORDER: readonly PromptRow[] = [
  "action_key",
  "task",
  "class",
  "command_breakdown",
  "protected_path",
  "policy_diff",
  "policy_load",
  "autonomy",
  "provenance",
  "state",
  "requested_ts",
  "waiting",
  "ttl_remaining_ms",
  "payload_hash",
  "attestation",
  "budgets",
  "chain",
  "est_cost_usd",
  "gloss",
  "summary",
  "rationale",
  "confidence",
  "token_delivery",
];

const ALL_ALWAYS: Partial<Record<PromptRow, RowVisibility>> = Object.fromEntries(
  PROMPT_ROWS.map((row) => [row, "always" as RowVisibility]),
);

/**
 * The CLI channel's default layout: every row the request carries.
 *
 * A terminal has room, and a one-shot rendering an operator asked for by typing
 * a verb is not the place to economise on lines the way a push notification is.
 */
export const CLI_PROMPT_LAYOUT: PromptLayout = layoutOf(FULL_ROW_ORDER, ALL_ALWAYS);

/** The web channel's default layout. Same reasoning as the CLI's: a page scrolls. */
export const WEB_PROMPT_LAYOUT: PromptLayout = layoutOf(FULL_ROW_ORDER, ALL_ALWAYS);

/** Default layout per shipped channel. What an absent `prompt` block means. */
export const DEFAULT_PROMPT_LAYOUTS: Readonly<Record<PromptChannel, PromptLayout>> = {
  cli: CLI_PROMPT_LAYOUT,
  web: WEB_PROMPT_LAYOUT,
  telegram: TELEGRAM_PROMPT_LAYOUT,
};

/**
 * A `channels.<name>.prompt` block as a policy may write it.
 *
 * Three keys, and each does ONE thing, because a key that both orders and
 * hides would leave an operator guessing which of the two a short list meant:
 *
 * - `rows` — ORDER ONLY. The rows it names render in that order, ahead of every
 *   row it does not name; those keep their default relative order behind them.
 *   It is never a whitelist, so a `ChannelRequest` widened by a later task
 *   cannot silently lose a field to a list written before that field existed —
 *   the same property `orderedFields` has held since APRV-23.
 * - `always` — visibility UP. A row that is `abnormal` or `off` by default
 *   renders on every prompt.
 * - `hide` — visibility DOWN. A row never renders. Refused for
 *   {@link REQUIRED_PROMPT_ROWS}.
 *
 * `always` and `hide` naming the same row is refused rather than resolved by
 * precedence: a policy that says both things about one row has an author who
 * believes one of them, and picking for them is the guess this schema does not
 * make.
 */
export interface PromptBlock {
  rows?: PromptRow[];
  always?: PromptRow[];
  hide?: PromptRow[];
  /** {@link PromptStyle} (APRV-489). Read by {@link promptStyleFor}, never by the row layout. */
  style?: PromptStyle;
  /** {@link PromptSay} (APRV-489). Read by {@link promptSayFor}, never by the row layout. */
  say?: PromptSay;
}

// ---------------------------------------------------------------------------
// The prompt style (APRV-489)
// ---------------------------------------------------------------------------

/**
 * How a channel lays out a prompt, as the attested policy chooses it (APRV-489).
 *
 * - `technical` is every prompt this runtime has ever sent: the computed block,
 *   the canonical rendering, the claimed block. It is the default, and what an
 *   absent key means, so every policy written before the key renders byte for
 *   byte what it rendered before.
 * - `minimal` is a short card in plain words for a reader who is not an
 *   engineer: a headline the RUNTIME computes from the class, the payload's own
 *   words quoted from the bound bytes, a deadline in plain words, and the whole
 *   technical card, canonical rendering included, collapsed inside the same
 *   message as the buttons (SPEC.md §10.3, amended APRV-489).
 *
 * A style chooses what is in front of the reader first. It cannot change what
 * the approver SIGNS: the canonical rendering is in the button-bearing message
 * either way, the `display_hash` names the same text, and the callback data and
 * the log are the same.
 *
 * Closed for `delivery`'s reason: a style this runtime cannot draw is a screen
 * the author believes is in force that nothing renders.
 */
export const PROMPT_STYLES = ["technical", "minimal"] as const;

/** One of {@link PROMPT_STYLES}. */
export type PromptStyle = (typeof PROMPT_STYLES)[number];

/** What an absent `style`, a policy that did not load, and every channel but Telegram mean. */
export const DEFAULT_PROMPT_STYLE: PromptStyle = "technical";

/**
 * The channels that draw a `minimal` card. Telegram only, in this release.
 *
 * Every other channel IGNORES the key (APRV-489, documented in
 * `docs/cli-reference.md`): `style: minimal` under `channels.web.prompt` or
 * `channels.cli.prompt` loads and changes nothing. Ignoring is the safe
 * direction, because the channel then shows MORE than was asked for, never
 * less, and it is never an error at prompt time. The value is still validated
 * wherever it appears, so a misspelling fails the load on every channel alike.
 */
export const PROMPT_STYLE_CHANNELS: readonly PromptChannel[] = ["telegram"];

/**
 * Which layout an approver decided on, as a decision record states it
 * (APRV-489): `payload.rendering` on `approval.granted` / `approval.rejected`.
 *
 * Written only when the policy asked for a style other than `technical`, so a
 * record under a technical policy is byte-identical to every earlier one.
 * `style` is what was SHOWN; `fallback` is present when the policy asked for
 * `minimal` and the channel sent the technical card instead, naming why (the
 * codes are `MINIMAL_FALLBACKS` in `channels/telegram-minimal.ts`).
 *
 * A statement by the channel about its own screen, read by nothing that
 * decides: no verdict, budget, token or sampling path reads it (SPEC.md §11.1
 * invariant 4 holds by there being no reader). The style a policy requested is
 * recoverable from the policy hash the record already carries.
 */
export interface PromptRendering {
  style: PromptStyle;
  fallback?: string;
}

/** The two words `say.<class>.note` may say. */
export const PROMPT_SAY_NOTES = ["summary", "none"] as const;

/** One of {@link PROMPT_SAY_NOTES}. */
export type PromptSayNote = (typeof PROMPT_SAY_NOTES)[number];

/**
 * What the operator declares about one class for the minimal card (APRV-489).
 *
 * - `does` is the plain-words verb phrase the headline completes: "Your agent
 *   wants to <does>". Operator text the resident attested; it is the headline
 *   only for a class this entry matches, chosen by the runtime from the class
 *   the log records. Nothing the agent writes reaches it.
 * - `quote` is the closed field set for an OPAQUE payload: every top-level key
 *   the payload may carry, each with the label its value is quoted under, or
 *   `null` (YAML `~`) for "known, deliberately not on the simple card". A
 *   payload carrying a key this map does not name is drawn as the technical
 *   card instead (SPEC.md §9's closed-field-set rule, applied to the summary
 *   view). Ignored for the structured kinds (command, file change, email),
 *   whose computed excerpt is built in.
 * - `note` says whether the agent's own summary is shown, labelled as the
 *   agent's: `summary` (the default) or `none`.
 */
export interface PromptSayEntry {
  /** Absent for a class core phrases itself, where core's phrase always wins (R2-S2). */
  does?: string;
  quote?: Readonly<Record<string, string | null>>;
  note?: PromptSayNote;
}

/** `channels.telegram.prompt.say`: class pattern -> declaration. */
export type PromptSay = Readonly<Record<string, PromptSayEntry>>;

/** The longest `does` phrase, in characters. A headline is one line on a phone. */
export const PROMPT_SAY_DOES_MAX = 120;

/** The longest `quote` label, in characters. */
export const PROMPT_SAY_LABEL_MAX = 24;

/**
 * The phrases for the classes core itself emits (APRV-489; R3: core supplies
 * phrases only for its own built-in classes and payload kinds). Here in core so
 * the loader can refuse a `say.<class>.does` that would override one (fix round
 * 3, R2-S2): a phrase is the first line of a card, and an operator's friendlier
 * words for a dangerous built-in class must not replace the runtime's.
 * `policy.edit` is absent on purpose: a policy edit is always the technical card.
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

/** Whether core phrases `actionClass` itself. */
export function isBuiltinPhraseClass(actionClass: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN_CLASS_PHRASES, actionClass);
}

/** The longest payload key a `quote` map may name. */
export const PROMPT_SAY_KEY_MAX = 64;

/**
 * Whether `value` is one of {@link PROMPT_STYLES}.
 */
export function isPromptStyle(value: unknown): value is PromptStyle {
  return typeof value === "string" && (PROMPT_STYLES as readonly string[]).includes(value);
}

/**
 * The style in force for `channel` (APRV-489).
 *
 * Fail-soft to {@link DEFAULT_PROMPT_STYLE}, in the direction
 * {@link promptLayoutFor} fails: a policy that did not load, an absent key, a
 * channel that does not draw a minimal card, and a value from a later version
 * all mean `technical`, which shows more rather than less. A LOADED policy
 * cannot carry an unknown value, because {@link promptBlockErrors} and the
 * schema refuse it at load.
 */
export function promptStyleFor(load: PolicyLoadResult, channel: string): PromptStyle {
  if (!load.ok) return DEFAULT_PROMPT_STYLE;
  if (!(PROMPT_STYLE_CHANNELS as readonly string[]).includes(channel)) return DEFAULT_PROMPT_STYLE;
  const raw = promptObjectOf(load.policy.channels?.[channel]);
  if (raw === null) return DEFAULT_PROMPT_STYLE;
  const style = raw["style"];
  return isPromptStyle(style) ? style : DEFAULT_PROMPT_STYLE;
}

/**
 * The `say` declarations in force for `channel`, or an empty map (APRV-489).
 *
 * Same fail-soft rule as {@link promptStyleFor}. An entry that is not
 * well-formed is dropped rather than half-read; from a loaded policy none is,
 * since {@link promptBlockErrors} refuses it at load. An empty map is safe:
 * every opaque payload then falls back to the technical card.
 */
export function promptSayFor(load: PolicyLoadResult, channel: string): PromptSay {
  if (!load.ok) return {};
  if (!(PROMPT_STYLE_CHANNELS as readonly string[]).includes(channel)) return {};
  const raw = promptObjectOf(load.policy.channels?.[channel]);
  if (raw === null) return {};
  const say = raw["say"];
  if (say === null || typeof say !== "object" || Array.isArray(say)) return {};
  const out: Record<string, PromptSayEntry> = {};
  for (const [pattern, entry] of Object.entries(say as Record<string, unknown>)) {
    if (sayEntryErrors(entry, "", pattern).length > 0 || !EXACT_CLASS.test(pattern)) continue;
    const record = entry as Record<string, unknown>;
    const quote = record["quote"] as Record<string, string | null> | undefined;
    const note = record["note"] as PromptSayNote | undefined;
    const does = record["does"] as string | undefined;
    out[pattern] = {
      ...(does === undefined ? {} : { does }),
      ...(quote === undefined ? {} : { quote: { ...quote } }),
      ...(note === undefined ? {} : { note }),
    };
  }
  return out;
}

/**
 * The declaration for exactly `actionClass`, or `null` (APRV-489).
 *
 * EXACT class names only (fix round 2, S6). A pattern such as `files.*` would
 * let one friendly phrase ("tidy up a little") stand for every class under it,
 * dangerous ones included, so `say` keys are refused at load unless they name
 * one class. The class is the one the LOG records; nothing a payload or an
 * agent says chooses it.
 */
export function sayEntryFor(
  say: PromptSay,
  actionClass: string,
): { pattern: string; entry: PromptSayEntry } | null {
  if (!Object.prototype.hasOwnProperty.call(say, actionClass)) return null;
  const entry = say[actionClass];
  return entry === undefined ? null : { pattern: actionClass, entry };
}

/** A `say` key: one exact class name, no wildcard segment (`$defs.exactClass` in the policy schema). */
const EXACT_CLASS = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$/u;

/** A `say` key that is a class PATTERN: well-formed, but carrying a `*` segment. */
const CLASS_PATTERN = /^(?:[a-z0-9][a-z0-9_-]*|\*)(?:\.(?:[a-z0-9][a-z0-9_-]*|\*))*$/u;

/**
 * The marker the minimal card reserves for its own computed notices. An
 * operator's phrase or label may not carry it, so attested operator text cannot
 * look like the runtime's warning that a quotation was cut (fix round 2, S6).
 */
const RESERVED_NOTICE_MARK = "⚠";

/** Characters an operator's phrase or label may not carry: controls, format (bidi, zero-width) and line separators. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** The `prompt` object under one channel entry, or `null`. */
function promptObjectOf(entry: unknown): Record<string, unknown> | null {
  if (entry === null || typeof entry !== "object") return null;
  const raw = (entry as Record<string, unknown>)["prompt"];
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/**
 * What a `does` phrase may be (fix round 3, R2-S3): a plain verb phrase that
 * completes "Your agent wants to …". It starts with a letter (no symbol, emoji
 * or ⚠ that could pass for the runtime's notices), and carries no sentence
 * punctuation, no colon and no markup, so operator text cannot read as a second
 * sentence such as "There is no time limit" or "Not shown here:".
 */
const DOES_SHAPE = /^\p{L}[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}.!?…:;<>&]*$/u;

/** What a `quote` label may be: letters, digits and spaces, nothing else (R2-S3). */
const LABEL_SHAPE = /^[\p{L}\p{N} ]*$/u;

/** The shape errors of one `say` entry for class `className`; empty means well-formed. */
function sayEntryErrors(entry: unknown, at: string, className: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const shape = (path: string, message: string): void => {
    errors.push({ path, keyword: "prompt-say-shape", message });
  };
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    shape(at, "expected an object with any of does, quote, note");
    return errors;
  }
  const record = entry as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    if (key !== "does" && key !== "quote" && key !== "note") {
      shape(`${at}/${key}`, "unknown key; a say entry defines does, quote, note");
    }
  }
  const does = record["does"];
  const builtin = isBuiltinPhraseClass(className);
  if (does !== undefined && builtin) {
    errors.push({
      path: `${at}/does`,
      keyword: "prompt-say-builtin",
      message: `core phrases ${JSON.stringify(className)} itself (${JSON.stringify(BUILTIN_CLASS_PHRASES[className])}); a say entry for it may set quote and note but not does`,
    });
  } else if (does === undefined && !builtin) {
    errors.push({
      path: `${at}/does`,
      keyword: "prompt-say-does",
      message: "a class core does not phrase needs a does phrase",
    });
  } else if (
    does !== undefined &&
    (typeof does !== "string" ||
      [...does].length > PROMPT_SAY_DOES_MAX ||
      !DOES_SHAPE.test(does) ||
      does.includes(RESERVED_NOTICE_MARK))
  ) {
    errors.push({
      path: `${at}/does`,
      keyword: "prompt-say-does",
      message: `expected a verb phrase of 1 to ${String(PROMPT_SAY_DOES_MAX)} characters that starts with a letter and has no line break, sentence punctuation (. ! ? … : ;), markup (< > &) or ${RESERVED_NOTICE_MARK}`,
    });
  }
  const quote = record["quote"];
  if (quote !== undefined) {
    if (quote === null || typeof quote !== "object" || Array.isArray(quote)) {
      shape(`${at}/quote`, "expected a map from payload key to a label or ~");
    } else {
      const entries = Object.entries(quote as Record<string, unknown>);
      const shown = entries.filter(([, label]) => typeof label === "string");
      // A quote map that shows nothing is a minimal card that can never be
      // drawn: refused at load rather than falling back on every request while
      // its author believes the simple card is on (fix round 2, S6).
      if (shown.length === 0) shape(`${at}/quote`, "the quote map shows no field: give at least one key a label");
      for (const [key, label] of entries) {
        const keyOk = key.length > 0 && [...key].length <= PROMPT_SAY_KEY_MAX && !INVISIBLE.test(key);
        if (!keyOk) shape(`${at}/quote/${key}`, `expected a payload key of 1 to ${String(PROMPT_SAY_KEY_MAX)} characters`);
        if (label === null) continue;
        if (typeof label !== "string" || [...label].length > PROMPT_SAY_LABEL_MAX || !LABEL_SHAPE.test(label)) {
          errors.push({
            path: `${at}/quote/${key}`,
            keyword: "prompt-say-label",
            message: `expected a label of letters, digits and spaces, at most ${String(PROMPT_SAY_LABEL_MAX)} characters, or ~`,
          });
        } else if (label.trim().length === 0 && shown.length > 1) {
          // R2-B2: a value may stand alone only when it is the only quotation.
          errors.push({
            path: `${at}/quote/${key}`,
            keyword: "prompt-say-label",
            message: "an empty label is allowed only when this is the only field quoted; with two or more, every label must say what the value is",
          });
        }
      }
    }
  }
  const note = record["note"];
  if (note !== undefined && !(PROMPT_SAY_NOTES as readonly unknown[]).includes(note)) {
    shape(`${at}/note`, `expected one of ${PROMPT_SAY_NOTES.join(", ")}`);
  }
  return errors;
}

/**
 * The layout in force for `channel`.
 *
 * Fail-soft in the same direction as `telegramDeliveryFor`: a policy that did
 * not load declares nothing, an absent block declares nothing, and a layout is
 * not a permission. Anything structurally wrong that reaches here (a hand-built
 * load result, a key from a later version) falls back to the default rather
 * than being guessed at — a LOADED policy cannot carry such a block, because
 * {@link promptBlockErrors} refuses it at load.
 */
export function promptLayoutFor(load: PolicyLoadResult, channel: string): PromptLayout {
  const base = DEFAULT_PROMPT_LAYOUTS[channel as PromptChannel] ?? CLI_PROMPT_LAYOUT;
  if (!load.ok) return base;
  const block = readBlock(load.policy.channels?.[channel]);
  if (block === null) return base;
  return applyPromptBlock(base, block);
}

/**
 * Apply a block to a layout. Pure, total, and exported so a caller holding a
 * block already can resolve it without going back through a policy file, which
 * is what the tests do and what a future `approval policy explain` of a channel
 * would need. Nothing outside the tests calls it today, and that is fine: the
 * split keeps {@link promptLayoutFor} to one job, reading the block.
 */
export function applyPromptBlock(base: PromptLayout, block: PromptBlock): PromptLayout {
  const named = (block.rows ?? []).filter(isPromptRow);
  const order: PromptRow[] = [];
  for (const row of named) if (!order.includes(row)) order.push(row);
  for (const row of base.order) if (!order.includes(row)) order.push(row);

  const visibility = { ...base.visibility } as Record<PromptRow, RowVisibility>;
  for (const row of block.always ?? []) if (isPromptRow(row)) visibility[row] = "always";
  for (const row of block.hide ?? []) if (isPromptRow(row)) visibility[row] = "off";
  return { order, visibility };
}

/**
 * The `prompt` block under one channel entry, or `null` when there is none.
 *
 * Structural only. Every semantic check lives in {@link promptBlockErrors} and
 * has already run at load, so a block reaching here from a loaded policy is
 * known-good; this function's `null` returns are for the hand-built and
 * future-version cases the fail-soft rule above covers.
 */
function readBlock(entry: unknown): PromptBlock | null {
  if (entry === null || typeof entry !== "object") return null;
  const raw = (entry as Record<string, unknown>)["prompt"];
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return null;
  const block = raw as Record<string, unknown>;
  const list = (key: string): PromptRow[] | undefined => {
    const value = block[key];
    if (!Array.isArray(value)) return undefined;
    return value.filter(isPromptRow);
  };
  const rows = list("rows");
  const always = list("always");
  const hide = list("hide");
  return {
    ...(rows === undefined ? {} : { rows }),
    ...(always === undefined ? {} : { always }),
    ...(hide === undefined ? {} : { hide }),
  };
}

/** The machine-readable reasons a `prompt` block refuses (APRV-218). */
export const PROMPT_BLOCK_ERROR_KEYWORDS = [
  /** A row name this runtime cannot place. */
  "prompt-row-unknown",
  /** {@link REQUIRED_PROMPT_ROWS} named in `hide`. */
  "prompt-row-required",
  /** `rows`, `always` or `hide` is not an array of strings. */
  "prompt-block-shape",
  /** One row named by both `always` and `hide`. */
  "prompt-row-conflict",
  /** A key the `prompt` block does not define. */
  "prompt-key-unknown",
  /** `style` is not one of {@link PROMPT_STYLES} (APRV-489). */
  "prompt-style-unknown",
  /** `say` is not a map of class name to a well-formed declaration (APRV-489). */
  "prompt-say-shape",
  /** A `say` key is a class pattern (a `*` segment), not one exact class (fix round 2, S6). */
  "prompt-say-wildcard",
  /** A `say` entry sets `does` for a class core phrases itself (fix round 3, R2-S2). */
  "prompt-say-builtin",
  /** A `does` phrase that is not a plain verb phrase, or is missing for an operator class (fix round 3, R2-S3). */
  "prompt-say-does",
  /** A `quote` label that is not plain words, or an empty label beside another quoted field (fix round 3). */
  "prompt-say-label",
] as const;

/** The three row-list keys, each an array of row names. */
const PROMPT_ROW_KEYS = ["rows", "always", "hide"] as const;

/** Every key a `prompt` block defines (APRV-489 adds `style` and `say`). */
const PROMPT_BLOCK_KEYS = [...PROMPT_ROW_KEYS, "style", "say"] as const;

/**
 * Validate every `channels.<name>.prompt` in a policy. Empty means clean.
 *
 * This runs on top of the JSON Schema rather than instead of it, and the
 * duplication is deliberate. The schema types the three channels this runtime
 * ships and closes the row enum there, which is where SPEC.md §8's
 * validate-at-the-write-boundary rule wants it; but `channels` admits UNKNOWN
 * channel names as free-form objects on purpose, so a third-party transport
 * plugin does not invalidate a whole policy, and a `prompt` block written under
 * such a name would otherwise reach a renderer unchecked. Both nets return the
 * same verdict — the policy does not load, everything is `manual` — so an
 * operator never has to know which one caught them.
 */
export function promptBlockErrors(policy: Policy): ValidationError[] {
  const errors: ValidationError[] = [];
  const channels = policy.channels;
  if (channels === undefined || channels === null || typeof channels !== "object") return errors;

  for (const channel of Object.keys(channels).sort()) {
    const entry = channels[channel];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = (entry as Record<string, unknown>)["prompt"];
    if (raw === undefined) continue;
    const at = `/channels/${channel}/prompt`;

    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push({
        path: at,
        keyword: "prompt-block-shape",
        message: "expected an object with any of `rows`, `always`, `hide`, `style`, `say`",
      });
      continue;
    }

    const block = raw as Record<string, unknown>;
    for (const key of Object.keys(block).sort()) {
      if (!(PROMPT_BLOCK_KEYS as readonly string[]).includes(key)) {
        errors.push({
          path: `${at}/${key}`,
          keyword: "prompt-key-unknown",
          message: `unknown key; the prompt block defines ${PROMPT_BLOCK_KEYS.join(", ")}`,
        });
      }
    }

    // APRV-489. Checked wherever it appears, on every channel name, although
    // only Telegram draws it: a misspelt style is a statement the runtime cannot
    // honour on any channel, and the policy fails closed on all of them alike.
    const style = block["style"];
    if (style !== undefined && !isPromptStyle(style)) {
      errors.push({
        path: `${at}/style`,
        keyword: "prompt-style-unknown",
        message: `unknown prompt style ${JSON.stringify(style)}; known styles are ${PROMPT_STYLES.join(", ")}`,
      });
    }
    const say = block["say"];
    if (say !== undefined) {
      if (say === null || typeof say !== "object" || Array.isArray(say)) {
        errors.push({
          path: `${at}/say`,
          keyword: "prompt-say-shape",
          message: "expected a map from class pattern to { does, quote, note }",
        });
      } else {
        for (const pattern of Object.keys(say as Record<string, unknown>).sort()) {
          const entryAt = `${at}/say/${pattern}`;
          if (!EXACT_CLASS.test(pattern)) {
            const wildcard = CLASS_PATTERN.test(pattern);
            errors.push({
              path: entryAt,
              keyword: wildcard ? "prompt-say-wildcard" : "prompt-say-shape",
              message: wildcard
                ? `${JSON.stringify(pattern)} is a class pattern; a say entry names exactly one class, so one phrase can never stand for several classes`
                : `${JSON.stringify(pattern)} is not a class name`,
            });
          }
          for (const problem of sayEntryErrors((say as Record<string, unknown>)[pattern], entryAt, pattern)) {
            errors.push(problem);
          }
        }
      }
    }

    const seen: Record<string, Set<string>> = {};
    for (const key of PROMPT_ROW_KEYS) {
      const value = block[key];
      if (value === undefined) continue;
      if (!Array.isArray(value)) {
        errors.push({
          path: `${at}/${key}`,
          keyword: "prompt-block-shape",
          message: "expected an array of row names",
        });
        continue;
      }
      const names = new Set<string>();
      value.forEach((row, index) => {
        if (!isPromptRow(row)) {
          errors.push({
            path: `${at}/${key}/${String(index)}`,
            keyword: "prompt-row-unknown",
            message: `unknown row name ${JSON.stringify(row)}; known rows are ${PROMPT_ROWS.join(", ")}`,
          });
          return;
        }
        names.add(row);
        if (key === "hide" && REQUIRED_PROMPT_ROWS.includes(row)) {
          errors.push({
            path: `${at}/${key}/${String(index)}`,
            keyword: "prompt-row-required",
            message: `row ${JSON.stringify(row)} is required for a decision and may be reordered but not hidden; required rows are ${REQUIRED_PROMPT_ROWS.join(", ")}`,
          });
        }
      });
      seen[key] = names;
    }

    for (const row of seen["always"] ?? new Set<string>()) {
      if (seen["hide"]?.has(row) === true) {
        errors.push({
          path: `${at}/hide`,
          keyword: "prompt-row-conflict",
          message: `row ${JSON.stringify(row)} is named by both \`always\` and \`hide\`; say one of them`,
        });
      }
    }
  }
  return errors;
}
