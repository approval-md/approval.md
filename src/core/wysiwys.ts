/**
 * WYSIWYS: the canonical rendering of a payload (APRV-119), and the structural
 * views it is built from (APRV-100, APRV-124, APRV-126, APRV-144).
 *
 * ## What you see is what you sign
 *
 * The prompt a human approves is a deterministic function of the payload bytes
 * and the action class, and of nothing else. {@link canonicalRender} is that
 * function. Two channels, two runtimes, or two versions of this one cannot show
 * two humans two different readings of the same payload without the difference
 * being detectable: the rendering carries its own `display_hash`, the gate
 * records that hash on `approval.requested`, and a rendering that disagrees is a
 * rendering whose hash disagrees.
 *
 * The threat this closes is signoff social engineering. An approval surface that
 * renders benign text while the hashed payload is malicious leaves the human
 * signing blind. `payload_hash` binds the bytes; `display_hash` binds the
 * reading of them.
 *
 * Four properties, and they are the whole module:
 *
 * 1. **Pure.** No clock, no locale, no environment, no randomness, no IO. The
 *    only inputs are the payload value and the class string, and
 *    `tests/wysiwys.test.ts` reads this file's own source and fails on a
 *    reference to any of them.
 * 2. **Closed field set per kind.** A payload is recognised as one of four kinds
 *    (`command`, `file-change`, `email`, `opaque`) by its STRUCTURE, and each
 *    kind renders a fixed list of fields. A shape carrying one key its kind does
 *    not render is not that kind: it falls through to `opaque`, where the
 *    canonical JSON is shown whole. Nothing is hidden by being unrecognised.
 * 3. **Absent renders explicitly.** A field the payload does not carry is
 *    printed as {@link ABSENT}, never omitted. An omitted line and a line whose
 *    value happens to be empty are different facts, and a reader who cannot tell
 *    them apart is reading a rendering that lost information.
 * 4. **Claimed material stays outside.** Everything inside the canonical block
 *    is derived from the bound bytes. Summaries, cost estimates, rationale,
 *    confidence, and model-written glosses are rendered OUTSIDE it, under the
 *    channel's own claimed heading (SPEC.md §9).
 *
 * ## Why this lives in `src/core/`, not `src/channels/`
 *
 * It is deterministic core in the sense CLAUDE.md means: pure, exhaustively
 * tested, and consulted by the gate. `core/gate.ts` computes `display_hash` at
 * the write boundary from the same function every channel renders with, so the
 * log states what rendering the approver was shown. A renderer under
 * `src/channels/` would have to be imported BY core to do that, inverting the
 * direction the codebase is built on. `channels/payload-view.ts` is the
 * channel-side facade over this module and holds the one function that needs a
 * channel type.
 *
 * ## The reading aids this absorbed (APRV-100, APRV-124, APRV-126)
 *
 * SPEC.md §10.4 requires a channel to present, for a `manual` action, "the full
 * payload or a faithful rendering of it". Until now every channel used the one
 * rendering `channels/tagging.ts` builds: pretty-printed JSON. That is faithful
 * and it is exact, and for an email it is close to unreadable — the observed
 * failure (2026-08-18, examples/email-demo.md) is a body arriving on a phone as
 * a single line carrying literal `\n` sequences, which is precisely the text a
 * human is being asked to take responsibility for.
 *
 * So this module adds a second rendering *on top of* the first, never instead
 * of it:
 *
 * - A payload whose **structure** matches the email adapter's payload shape
 *   ({@link ../adapters/email.js}) is rendered field by field, with the body as
 *   the human will read it: real line breaks, no JSON escapes.
 * - A payload whose structure is a **shell command** (APRV-126: the shape
 *   `cli/hook.ts` builds for a `Bash` tool call) is rendered as the command a
 *   shell would receive, over as many lines as it really has, with `cwd` on its
 *   own line beneath it. Same reason again: `"command": "gh pr create --body
 *   'a\nb'"` on a phone is one paragraph of escaped JSON, and the observed
 *   failure (2026-08-20) is a human being asked to take responsibility for it.
 * - A payload whose structure is a **file change** (APRV-124: the shape
 *   `cli/hook.ts` builds for an `Edit` or a `Write` tool call) is rendered as a
 *   diff, so the approver reads the change rather than the fact that a file was
 *   touched. Same reason as the email case: `"before": "a\nb"` on a phone is
 *   bytes nobody can check.
 * - Every other shape falls to `opaque`, whose view IS the canonical JSON: the
 *   bytes whole, pretty-printed, exactly the rendering every payload had before
 *   the structural views existed.
 *
 * Three properties this file is careful about:
 *
 * 1. **Detection is structural.** Nothing here reads a self-declared "kind" or
 *    "type" field, because that field would be authored by the party under
 *    oversight, and a channel that lets an agent choose its own presentation
 *    has handed the agent the display. A payload is email-shaped when its keys
 *    and its value types say so, and for no other reason.
 * 2. **Nothing is hidden.** The shape is accepted only when *every* key is one
 *    this module renders, so the field-by-field view never omits a byte of the
 *    payload — a `bcc` or a `content_type` that the reader could not see would
 *    be the same failure as a truncated payload, wearing a friendlier face.
 * 3. **This is claimed content.** The payload is authored by the requesting
 *    agent. The block says so in its first line, and the computed binding (the
 *    `sha256` label each channel already prints around this region) stays where
 *    it is. Making the payload *legible* must not make it look *verified*.
 *    A `tool` or a `rule` value inside a file-change payload is rendered for
 *    the reader and is never what selects the rendering: the shape is, exactly
 *    as for an email.
 * 4. **Two different byte strings never look the same.** A reading aid that
 *    interprets escape sequences has to answer the question it creates: if a
 *    real line break becomes a line break, what does the two-byte sequence
 *    backslash-`n` become? Rendering both as a line break would let an agent
 *    write one payload and have the approver read another. So the rendering is
 *    INJECTIVE by construction ({@link markEscapes}), and the property is
 *    tested by generating pairs of distinct byte strings.
 * 5. **The view is the whole reading (APRV-162, `approval.md/wysiwys/2`).** A
 *    structured kind's view is the canonical rendering entire; no canonical-JSON
 *    appendix follows it. The completeness argument is property 2 above: kind
 *    detection is a closed field set, one unrecognised key sends the payload to
 *    `opaque` whose view is the whole JSON, so a structural view that renders at
 *    all renders every byte. The views therefore do not fold. A fold was
 *    survivable only while the appendix restated the hidden lines underneath it;
 *    with the appendix gone it would hide bytes from the only reading a human
 *    gets, which is the failure this module exists to remove.
 *
 * The output is plain text with real newlines. Escaping belongs to the channel:
 * `telegram.ts` and `web.ts` each pass this through their own `escapeHtml` and
 * their own `<pre>`, so the injection surface is exactly what it was before.
 */

import { createHash } from "node:crypto";

import {
  classifyCommand,
  commandSegmentWords,
  isProtectedPath,
  type ProtectedPathEntry,
} from "./command-class.js";
import { payloadHash } from "./payload.js";

/**
 * How a field the payload does not carry is rendered.
 *
 * Never an omission. A closed field set that silently drops its absent members
 * is not a closed field set: the reader cannot tell "no `cc`" from "a `cc` this
 * renderer does not know how to show", and those are the two cases the whole
 * design exists to keep apart.
 */
export const ABSENT = "(absent)";

/** Keys the email adapter's payload may carry (`adapters/email.ts`). */
const STRING_KEYS = ["from", "subject", "body", "content_type"] as const;
const ADDRESS_LIST_KEYS = ["to", "cc", "bcc"] as const;

/**
 * The keys that must be present for a value to read as an email at all.
 *
 * A recipient, a subject and a body: the triple that makes the JSON rendering
 * unreadable in the first place. `from` is optional here even though the
 * adapter requires it, because this module answers "will a human read this
 * better field by field?", not "will the adapter accept it?" — the adapter
 * enforces its own shape at execution, and duplicating that judgement here
 * would only mean a payload the adapter rejects gets rendered badly first.
 */
const REQUIRED_KEYS = ["to", "subject", "body"] as const;

/** Display order. `body` last: it is the only multi-line field. */
const FIELD_ORDER = ["from", "to", "cc", "bcc", "subject", "content_type", "body"] as const;

/** The heading and delimiters. Exported because the tests pin them. */
export const EMAIL_VIEW_HEADING =
  "email — rendered field by field; every value below is CLAIMED, authored by the requesting party";
export const BODY_BEGIN = "--- body begins ---";
export const BODY_END = "--- body ends ---";
export const CANONICAL_JSON_HEADING = "--- the same bytes, canonical JSON ---";

/** One labelled line of the field-by-field view. */
export interface EmailViewField {
  label: string;
  /** The value as text. For `body`, this may contain newlines. */
  text: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Recognise an email-shaped payload, structurally.
 *
 * Returns the fields in display order, or `null` when the value is any other
 * shape — including an email-ish object carrying one key this module does not
 * know how to show, which falls back to JSON rather than hiding it.
 */
export function emailPayloadFields(value: unknown): EmailViewField[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const known = new Set<string>([...STRING_KEYS, ...ADDRESS_LIST_KEYS]);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) return null;
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in record)) return null;
  }

  for (const key of STRING_KEYS) {
    if (key in record && typeof record[key] !== "string") return null;
  }
  for (const key of ADDRESS_LIST_KEYS) {
    if (!(key in record)) continue;
    const entry = record[key];
    if (typeof entry !== "string" && !isStringArray(entry)) return null;
  }

  const fields: EmailViewField[] = [];
  for (const key of FIELD_ORDER) {
    if (!(key in record)) continue;
    const entry = record[key];
    fields.push({
      label: key,
      text: typeof entry === "string" ? entry : (entry as string[]).join(", "),
    });
  }
  return fields;
}

// ---------------------------------------------------------------------------
// File changes (APRV-124)
// ---------------------------------------------------------------------------

/**
 * Keys a file-change payload may carry (`cli/hook.ts`).
 *
 * `tool` and `rule` are rendered, never consulted: `tool` is the harness's name
 * for the call, and `rule` is the hook's own qualifier (`protected-path` or
 * `protected-path-proposal`, APRV-124). Which rendering this module uses is
 * decided by the presence of `file` and of the change itself, below.
 */
const CHANGE_LABEL_KEYS = ["tool", "rule", "file"] as const;
const CHANGE_TEXT_KEYS = ["before", "after", "content"] as const;
const CHANGE_BOOL_KEYS = ["replace_all"] as const;

/** The heading and delimiters of the diff view. Exported because tests pin them. */
export const EDIT_VIEW_HEADING =
  "file change — the change itself, not the touch; every value below is CLAIMED, authored by the requesting party";
export const DIFF_BEGIN = "--- change begins ---";
export const DIFF_END = "--- change ends ---";

/** The qualifier a proposal-tier touch renders (APRV-124). */
export const PROPOSAL_QUALIFIER =
  "this edit targets a file inside an AGENT WORKTREE: it is a branch PROPOSAL, not the live file. Merging it to the live checkout is a separate gated action.";
export const LIVE_QUALIFIER = "this edit targets the LIVE checkout, not a branch proposal.";

/** The qualifier a protected-name touch outside the gated checkout renders (APRV-161). */
export const ELSEWHERE_QUALIFIER =
  "this edit targets a file NAMED like a policy file, OUTSIDE the gated checkout: it is not the live policy. It gates because the name is protected wherever it sits.";

/** A file change, recognised structurally. */
export interface ChangeView {
  /** Labelled single-line fields, in display order. */
  labels: EmailViewField[];
  /** The removed side, or `null` for a whole-file write. */
  before: string | null;
  /** The added side: the new text, or the whole new content. */
  after: string;
}

/**
 * Recognise a file-change payload, structurally.
 *
 * Accepted when the payload names a `file` and carries either both sides of an
 * edit (`before` and `after`) or a whole-file `content`, and every other key is
 * one this module renders. Anything else — including a payload that carries
 * only `before`, where the reader would be shown half a change — is `null` and
 * falls back to JSON.
 */
export function changePayloadView(value: unknown): ChangeView | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const known = new Set<string>([...CHANGE_LABEL_KEYS, ...CHANGE_TEXT_KEYS, ...CHANGE_BOOL_KEYS]);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) return null;
  }
  if (typeof record["file"] !== "string") return null;
  for (const key of [...CHANGE_LABEL_KEYS, ...CHANGE_TEXT_KEYS]) {
    if (key in record && typeof record[key] !== "string") return null;
  }
  for (const key of CHANGE_BOOL_KEYS) {
    if (key in record && typeof record[key] !== "boolean") return null;
  }

  const before = record["before"];
  const after = record["after"];
  const content = record["content"];
  const isEdit = typeof before === "string" && typeof after === "string";
  const isWrite = typeof content === "string" && before === undefined && after === undefined;
  if (!isEdit && !isWrite) return null;
  if (isEdit && content !== undefined) return null;

  const labels: EmailViewField[] = [];
  for (const key of CHANGE_LABEL_KEYS) {
    const entry = record[key];
    if (typeof entry === "string") labels.push({ label: key, text: entry });
  }
  for (const key of CHANGE_BOOL_KEYS) {
    const entry = record[key];
    if (typeof entry === "boolean") labels.push({ label: key, text: entry ? "true" : "false" });
  }

  return {
    labels,
    before: isEdit ? (before as string) : null,
    after: isEdit ? (after as string) : (content as string),
  };
}

/**
 * `text` as prefixed diff lines, whole (APRV-162).
 *
 * No budget and no fold: this view is the entire canonical rendering of the
 * payload, so a line it stops showing is a line nobody sees. Length is the
 * channel's problem (`telegram.ts` chunks, never truncates).
 */
function diffLines(text: string, marker: "-" | "+"): string[] {
  return text.split("\n").map((line) => `${marker}${line}`);
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

/**
 * The closed field set of a file change, in display order (APRV-119).
 *
 * Every one of these is printed for every file change, {@link ABSENT} where the
 * payload carries none. `replace_all` is the field this matters most for: an
 * edit that replaces one occurrence and an edit that replaces all of them are
 * different actions, and a rendering that showed the flag only when it was set
 * would leave the reader unable to tell "replace_all: false" from "a renderer
 * that does not show this".
 */
const CHANGE_FIELD_ORDER = [...CHANGE_LABEL_KEYS, ...CHANGE_BOOL_KEYS] as const;

/** The diff view: labels, then one block per side, `-` removed, `+` added. */
function changeRegionText(view: ChangeView, hash: string): string[] {
  const lines: string[] = [EDIT_VIEW_HEADING];
  for (const key of CHANGE_FIELD_ORDER) {
    const field = view.labels.find((entry) => entry.label === key);
    lines.push(`${key}: ${field === undefined ? ABSENT : field.text}`);
  }
  // The tier qualifier, rendered for EVERY tier. Printing it only for the
  // qualified tiers would make "live" the silent default, and the silent
  // default is the one that reaches the real file. Each tier has its own
  // wording: LIVE_QUALIFIER is a claim about the file the edit lands in, so a
  // protected-name touch elsewhere (APRV-161) must not borrow it.
  const rule = view.labels.find((field) => field.label === "rule");
  if (rule !== undefined && rule.text === "protected-name-elsewhere") {
    lines.push(`note: ${ELSEWHERE_QUALIFIER}`);
  } else if (rule !== undefined && rule.text.startsWith("protected-path")) {
    lines.push(`note: ${rule.text.endsWith("-proposal") ? PROPOSAL_QUALIFIER : LIVE_QUALIFIER}`);
  }

  lines.push(DIFF_BEGIN);
  if (view.before === null) {
    lines.push(
      `the whole file as it will be written (${String(lineCount(view.after))} lines); the bytes it replaces are not part of what is being approved`,
    );
    lines.push(...diffLines(view.after, "+"));
  } else {
    lines.push(
      `replacing ${String(lineCount(view.before))} line(s) with ${String(lineCount(view.after))}`,
    );
    lines.push(...diffLines(view.before, "-"));
    lines.push(...diffLines(view.after, "+"));
  }
  lines.push(DIFF_END);
  lines.push(rawBytesLine(hash));
  return lines;
}

// ---------------------------------------------------------------------------
// Shell commands (APRV-126)
// ---------------------------------------------------------------------------

/** Keys a command payload may carry (`cli/hook.ts`: `{command, cwd}`). */
const COMMAND_KEYS = ["command", "cwd"] as const;

/** The heading and delimiters of the command view. Exported because tests pin them. */
export const COMMAND_VIEW_HEADING =
  "command — rendered; the hash binds the RAW BYTES, not this view. Every value below is CLAIMED, authored by the requesting party";
export const COMMAND_BEGIN = "--- command begins ---";
export const COMMAND_END = "--- command ends ---";

/**
 * The delimiters around a marked escape sequence.
 *
 * Guillemets rather than brackets: `[` and `]` are ordinary shell and regex
 * characters, so a marker built from them would be indistinguishable from the
 * command's own text at a glance, which is the failure this marker exists to
 * prevent.
 */
export const ESCAPE_OPEN = "«";
export const ESCAPE_CLOSE = "»";

/** The legend printed above every command block, so the marker needs no lore. */
export const ESCAPE_LEGEND = `escapes: ${ESCAPE_OPEN}\\n${ESCAPE_CLOSE} is the two LITERAL bytes backslash-n; a real line break is a line break`;

/**
 * The escape letters that name a character the reader could otherwise mistake
 * for the real thing.
 *
 * `\` is in the set for the same reason: `\\n` and `\n` are different bytes and
 * a reader must not have to count backslashes to tell them apart.
 */
const MARKED_ESCAPES = new Set(["n", "r", "t", "\\"]);

/**
 * One line of a command, with literal escape sequences marked.
 *
 * INJECTIVE, and the proof is short enough to keep here. The rendering is a
 * left-to-right tokenizer over two tokens: a backslash followed by a letter in
 * {@link MARKED_ESCAPES} becomes `«\c»`, and every other character is itself.
 * A `«\c»` in the OUTPUT can therefore only have come from that first token,
 * because a backslash followed by such a letter in the input is never emitted
 * bare — so reading the output back left to right recovers the input exactly,
 * and a left inverse is all injectivity needs.
 *
 * Real newlines are handled by the caller, which splits on them before calling
 * this: a line break in the output comes from a line break in the input, and
 * from nothing else.
 */
export function markEscapes(line: string): string {
  let out = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] as string;
    const next = index + 1 < line.length ? (line[index + 1] as string) : "";
    if (character === "\\" && MARKED_ESCAPES.has(next)) {
      out += `${ESCAPE_OPEN}\\${next}${ESCAPE_CLOSE}`;
      index += 1;
      continue;
    }
    out += character;
  }
  return out;
}

/** A shell command, recognised structurally. */
export interface CommandView {
  /** The command, exactly as the payload carries it. */
  command: string;
  /** The working directory, or `null` when the payload names none. */
  cwd: string | null;
}

/**
 * Recognise a command payload, structurally.
 *
 * Accepted when the payload carries a string `command` and nothing this module
 * cannot show. `cwd` is optional here even though `cli/hook.ts` always sets it:
 * the question this answers is "will a human read this better as a command?",
 * and a payload missing its directory reads better either way.
 */
export function commandPayloadView(value: unknown): CommandView | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const known = new Set<string>(COMMAND_KEYS);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) return null;
  }
  if (typeof record["command"] !== "string") return null;
  const cwd = record["cwd"];
  if (cwd !== undefined && typeof cwd !== "string") return null;

  return { command: record["command"], cwd: typeof cwd === "string" ? cwd : null };
}

/**
 * Where the exact bytes live, and how to get them back (APRV-126, APRV-162).
 *
 * Carried by every structural view, not the command view alone: with no
 * canonical-JSON appendix underneath, this line is the reader's only route from
 * a rendering back to the bytes it was derived from.
 *
 * The store is content-addressed by this very hash and re-verified on every
 * read (`core/payload-store.ts`), so the line is an instruction, never a claim:
 * following it produces the bytes or produces a refusal, and never something
 * else wearing the same name.
 */
export function rawBytesLine(hash: string): string {
  return `raw bytes: .approval/payloads/${hash}.json — re-verified against this sha256 on every read`;
}

/** The command view: the command over its real lines, then `cwd`. */
function commandRegionText(view: CommandView, hash: string): string[] {
  const lines: string[] = [COMMAND_VIEW_HEADING, ESCAPE_LEGEND];

  const commandLines = view.command.split("\n");
  const count = commandLines.length;
  lines.push(`command (${String(count)} line${count === 1 ? "" : "s"}):`);
  lines.push(COMMAND_BEGIN);
  lines.push(...commandLines.map(markEscapes));
  lines.push(COMMAND_END);
  // On its own line, beneath the command, because it is the other half of what
  // the command does and a `cd` the reader never saw is the whole difference
  // between a repository and someone else's.
  lines.push(`cwd: ${view.cwd === null ? "(none declared)" : markEscapes(view.cwd)}`);
  lines.push(rawBytesLine(hash));
  return lines;
}

// ---------------------------------------------------------------------------
// The command breakdown (APRV-144)
// ---------------------------------------------------------------------------

/** What separates two segments of the breakdown. Exported: the tests pin it. */
export const BREAKDOWN_SEPARATOR = " · ";

/** Characters one segment of the breakdown may take before it folds. */
export const BREAKDOWN_SEGMENT_BUDGET = 40;

/** Segments the breakdown shows before it says how many it did not. */
export const BREAKDOWN_MAX_SEGMENTS = 8;

/**
 * The words of one segment worth showing: its arguments, minus the flags and
 * minus the words that are probably flag VALUES.
 *
 * The classifier does not know which flags take a value, and neither does this
 * (`RuleContext.positionals` has the same blind spot, on purpose). What it does
 * is drop the word after a bare SHORT flag, which is what turns
 * `git commit -m "APRV-…"` into `git commit` rather than into a segment whose
 * only visible argument is a commit message.
 *
 * Short and not long, deliberately. A short flag that takes a value almost
 * always takes it as the next word (`-m msg`, `-H header`, `-o file`); a long
 * one almost always carries it inline (`--message=…`) or takes none at all, so
 * the word after `--force-with-lease` is `origin` and dropping it would hide
 * the destination of a push. Both mistakes cost a word on a reading aid whose
 * raw bytes sit underneath it in full, and nothing reads this back — but the
 * long-flag case is the one that would have hidden something worth seeing.
 */
function salientArgs(args: readonly string[]): string[] {
  const kept: string[] = [];
  let afterValueFlag = false;
  for (const arg of args) {
    const flag = arg.startsWith("-") && arg !== "-";
    if (!flag && !afterValueFlag) kept.push(arg);
    afterValueFlag = flag && !arg.startsWith("--") && !arg.includes("=");
  }
  return kept;
}

/** One segment as `bin sub arg…`, collapsed to one line and folded at the budget. */
function breakdownSegment(bin: string, args: readonly string[]): string {
  const text = [bin, ...salientArgs(args)].join(" ").replace(/\s+/gu, " ").trim();
  return text.length <= BREAKDOWN_SEGMENT_BUDGET
    ? text
    : `${text.slice(0, BREAKDOWN_SEGMENT_BUDGET - 1)}…`;
}

/**
 * What a compound command does, segment by segment (APRV-144).
 *
 * `git add … · git commit · git push origin main:records-… · gh pr create`.
 *
 * The observed complaint (Carter, 2026-08-25) is that the claimed summary of a
 * shell action is `truncate(command, 160)`, which for a chained command is the
 * first clause and a path prefix: the approver reads where the command starts
 * and never what it ends by doing. This is the deterministic half of the
 * answer. It is derived from {@link commandSegmentWords} — the classifier's own
 * tokenizer, never a second one — so a channel showing it cannot describe a
 * command differently from the module that chose its class.
 *
 * `null` for a string the tokenizer refuses (the same input the classifier
 * answers `unparseable` for) and for one with no segment carrying a binary: an
 * aid that cannot be derived is absent, never guessed.
 */
export function commandBreakdown(command: string): string | null {
  const segments = commandSegmentWords(command);
  if (segments === null || segments.length === 0) return null;

  const shown = segments.slice(0, BREAKDOWN_MAX_SEGMENTS);
  const parts = shown.map((segment) => breakdownSegment(segment.bin, segment.args));
  const hidden = segments.length - shown.length;
  if (hidden > 0) parts.push(`… ${String(hidden)} more`);
  return parts.join(BREAKDOWN_SEPARATOR);
}

// ---------------------------------------------------------------------------
// The protected path (APRV-143)
// ---------------------------------------------------------------------------

/** The rule names a file-tool touch of a protected path reports (`cli/hook.ts`). */
const PROTECTED_RULE_NAMES: readonly string[] = [
  "protected-path",
  "protected-path-proposal",
  "protected-name-elsewhere",
];

/** The path that made an action `policy.edit`, and the rule that matched it. */
export interface ProtectedPathView {
  path: string;
  rule: string;
}

/**
 * Which protected path selected this payload's class, when one did (APRV-143).
 *
 * A prompt that says `class: policy.edit` and stops there tells the approver
 * that *some* rule fired and leaves them to find the file. Both gated shapes
 * can say which:
 *
 * - a shell payload is re-classified here, by the same
 *   {@link classifyCommand} the hook decided with, and the segment that took
 *   `policy.edit` carries the word it matched (`ClassifiedSegment.path`);
 * - a file-tool payload names its target in `file`, and
 *   {@link isProtectedPath} is re-run over it rather than trusted: the answer
 *   is recomputed from the bound bytes, so this stays a computed field. The
 *   payload's own `rule` is used as the label only when it is one of the three
 *   the hook writes, which is what keeps the worktree-proposal and
 *   protected-name-elsewhere tiers legible (APRV-124, APRV-161).
 *
 * `extra` is `policy.protected_paths`, passed exactly as every enforcement path
 * passes it; omitting it narrows the answer and never widens it.
 */
export function protectedPathView(
  value: unknown,
  extra: readonly ProtectedPathEntry[] = [],
): ProtectedPathView | null {
  const command = commandPayloadView(value);
  if (command !== null) {
    const classified = classifyCommand(command.command, extra);
    if (!classified.ok) return null;
    for (const segment of classified.segments) {
      if (segment.path !== undefined) return { path: segment.path, rule: segment.rule };
    }
    return null;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const file = record["file"];
  if (typeof file !== "string" || !isProtectedPath(file, extra)) return null;
  const rule = record["rule"];
  return {
    path: file,
    rule: typeof rule === "string" && PROTECTED_RULE_NAMES.includes(rule) ? rule : "protected-path",
  };
}

/** The email view: every field of the closed set, then the body in delimiters. */
function emailRegionText(fields: EmailViewField[], hash: string): string[] {
  const lines: string[] = [EMAIL_VIEW_HEADING];
  for (const key of FIELD_ORDER) {
    if (key === "body") continue;
    const field = fields.find((entry) => entry.label === key);
    lines.push(`${key}: ${field === undefined ? ABSENT : field.text}`);
  }
  // `body` is required for the shape to be recognised at all, so its absence
  // here is unreachable; it is rendered as an absence anyway rather than as an
  // empty block, because a delimiter pair around nothing reads as "the body is
  // empty" and that is a different claim.
  const body = fields.find((field) => field.label === "body");
  if (body === undefined) {
    lines.push(`body: ${ABSENT}`, rawBytesLine(hash));
    return lines;
  }
  const count = body.text === "" ? 0 : body.text.split("\n").length;
  lines.push(`body (${count} line${count === 1 ? "" : "s"}):`, BODY_BEGIN, body.text, BODY_END);
  lines.push(rawBytesLine(hash));
  return lines;
}

// ---------------------------------------------------------------------------
// The canonical renderer (APRV-119)
// ---------------------------------------------------------------------------

/**
 * The renderer's identity, printed inside every canonical block.
 *
 * Inside the text, and therefore inside {@link CanonicalRendering.display_hash}:
 * a version that rode alongside the hash rather than inside it would let two
 * renderer versions produce the same digest for two different readings, which is
 * the one thing the digest exists to make impossible. Any change to the bytes
 * this module emits — a new field, a reworded heading, a line that used to be
 * folded away — is a new version, and a reader comparing a stored
 * `display_hash` against a re-render can see which renderer wrote it. A record
 * written under an earlier version re-derives under the renderer its own hashed
 * text names, never under this one.
 *
 * `/2` (APRV-162): the structural views render whole and carry no canonical-JSON
 * appendix; `opaque` is unchanged, its view being that JSON.
 */
export const CANONICAL_RENDERER_VERSION = "approval.md/wysiwys/2";

/**
 * The `approval.requested` payload field carrying {@link
 * CanonicalRendering.display_hash} (APRV-119).
 *
 * Written by the gate at the write boundary, exactly as `ts` and `policy_sha256`
 * are, and for the same reason: the requesting party must not be able to name
 * the rendering it claims a human was shown. {@link RequestInput} carries no
 * field for it.
 */
export const DISPLAY_HASH_FIELD = "display_hash";

/** The delimiters of the canonical block. Exported because the tests pin them. */
export const CANONICAL_BEGIN = "--- canonical rendering begins ---";
export const CANONICAL_END = "--- canonical rendering ends ---";

/** The heading of the `opaque` kind: no structural view, the bytes whole. */
export const OPAQUE_VIEW_HEADING =
  "payload — no structural view applies to this shape; every byte of it is in the canonical JSON below, and every value is CLAIMED, authored by the requesting party";

/**
 * The kinds a payload can be rendered as.
 *
 * Closed, and decided by structure alone. `opaque` is not a failure: it is the
 * kind whose closed field set is "the whole canonical JSON", which is the
 * rendering every payload had before the structural views existed.
 */
export const CANONICAL_KINDS = ["command", "file-change", "email", "opaque"] as const;

export type CanonicalKind = (typeof CANONICAL_KINDS)[number];

/** One canonical rendering: what the human reads, and the digest of it. */
export interface CanonicalRendering {
  /** {@link CANONICAL_RENDERER_VERSION}, for a caller that wants it separately. */
  version: string;
  /** Which structural view was applied. */
  kind: CanonicalKind;
  /** The text, with real newlines. Escaping belongs to the channel. */
  text: string;
  /** SHA-256 (lowercase hex) over `text` as UTF-8. */
  display_hash: string;
}

/** The structural view for a payload, and the kind that selected it. */
function canonicalBody(payload: unknown, hash: string): { kind: CanonicalKind; lines: string[] } {
  const command = commandPayloadView(payload);
  if (command !== null) return { kind: "command", lines: commandRegionText(command, hash) };

  const change = changePayloadView(payload);
  if (change !== null) return { kind: "file-change", lines: changeRegionText(change, hash) };

  const fields = emailPayloadFields(payload);
  if (fields !== null) return { kind: "email", lines: emailRegionText(fields, hash) };

  // The `opaque` view IS the canonical JSON, and it is the only view that
  // carries it (APRV-162): under a structured kind the same bytes would be a
  // second reading of a payload the view already showed entire, and two
  // readings is one more than a human checks.
  return {
    kind: "opaque",
    lines: [OPAQUE_VIEW_HEADING, "", CANONICAL_JSON_HEADING, canonicalJson(payload)],
  };
}

/**
 * The `opaque` view: the payload, pretty-printed.
 *
 * Indented rather than RFC 8785 canonical, deliberately. The line above it
 * states the RFC 8785 digest, which is the value the approval binds to and the
 * value any second implementation can recompute; what this is for is a human
 * reading a shape no structural view knows, and a single 4KB line is not that.
 * The two never disagree, because both are derived from the same value in the
 * same call.
 */
function canonicalJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2) ?? String(payload);
}

/**
 * Render a payload the way every channel MUST present it (APRV-119).
 *
 * A pure function of `(payload, actionClass)`. Same arguments, byte-identical
 * `text` and `display_hash`, in this process or another, today or next year
 * under the same {@link CANONICAL_RENDERER_VERSION}.
 *
 * The block states its own renderer, class, kind and payload digest before it
 * shows anything, so a reader who is handed the text alone can tell what
 * produced it and what it binds to. Then the view for the kind, which is the
 * whole reading: it renders every byte of the payload or the payload is
 * `opaque` and the view is its JSON (APRV-162).
 *
 * Throws `JcsError` for a payload RFC 8785 cannot serialize (a cycle, a NaN).
 * That is {@link payloadHash}'s contract and it is the right one here too: a
 * payload that cannot be bound to must not acquire a plausible-looking rendering
 * of itself. Every caller in this repository renders material that has already
 * been hash-checked against the log's binding, so the throw is unreachable on
 * the paths a human ever sees.
 */
export function canonicalRender(payload: unknown, actionClass: string): CanonicalRendering {
  const hash = payloadHash(payload);
  const body = canonicalBody(payload, hash);
  const text = [
    CANONICAL_BEGIN,
    `renderer: ${CANONICAL_RENDERER_VERSION}`,
    `class: ${actionClass}`,
    `payload kind: ${body.kind}`,
    `payload sha256: ${hash}`,
    "",
    ...body.lines,
    CANONICAL_END,
  ].join("\n");

  return {
    version: CANONICAL_RENDERER_VERSION,
    kind: body.kind,
    text,
    display_hash: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

/**
 * The `display_hash` of a payload, or `null` when there is none to compute.
 *
 * The gate's entry point (`core/gate.ts`), where a payload that cannot be
 * canonicalized must not abort a request that has already passed every check
 * that matters. A missing `display_hash` costs a reader one cross-check; a
 * throw here would cost them the request.
 */
export function displayHashOf(payload: unknown, actionClass: string): string | null {
  try {
    return canonicalRender(payload, actionClass).display_hash;
  } catch {
    return null;
  }
}
