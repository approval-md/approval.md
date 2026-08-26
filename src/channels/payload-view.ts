/**
 * A readable rendering of a payload a channel recognises (APRV-100).
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
 * - The canonical JSON follows underneath, unchanged, so the exact bytes remain
 *   on screen and every existing check that the region contains them still
 *   holds. The reading aid is above; the evidence is below.
 * - Every other shape keeps today's rendering byte for byte.
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
 * 5. **A fold is announced.** The diff view is a reading aid over a payload
 *    whose canonical JSON sits underneath it in full, so a very long change may
 *    be folded in the aid — but only with an explicit
 *    `… N more lines (hash covers all bytes)` marker on the line where it
 *    happened. Silent shortening is the failure this whole module exists to
 *    remove, and it does not become acceptable because it is convenient.
 *
 * The output is plain text with real newlines. Escaping belongs to the channel:
 * `telegram.ts` and `web.ts` each pass this through their own `escapeHtml` and
 * their own `<pre>`, so the injection surface is exactly what it was before.
 */

import { classifyCommand, isProtectedPath } from "../core/command-class.js";
import type { PayloadRendering } from "./contract.js";

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

/**
 * Lines per side of the diff before the view folds.
 *
 * Generous on purpose: a fold costs the reader a scroll to the canonical JSON
 * underneath, so it should happen only where the alternative is a phone screen
 * nobody reads at all.
 */
export const DIFF_LINE_BUDGET = 120;

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
 * The one way this module is allowed to stop showing lines.
 *
 * Exported and shared by every view here (APRV-126), because a second wording
 * of "there is more" is a second thing a reader has to learn to notice, and the
 * whole point of the marker is that it cannot be mistaken for the end.
 */
export function foldMarker(hidden: number): string {
  return `… ${String(hidden)} more lines (hash covers all bytes)`;
}

/** `lines`, cut to `budget` with {@link foldMarker} on the line where it happened. */
function fold(lines: string[], budget: number): string[] {
  if (lines.length <= budget) return lines;
  return [...lines.slice(0, budget), foldMarker(lines.length - budget)];
}

/** `text` as prefixed diff lines, folded — audibly — past the budget. */
function diffLines(text: string, marker: "-" | "+"): string[] {
  return fold(
    text.split("\n").map((line) => `${marker}${line}`),
    DIFF_LINE_BUDGET,
  );
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

/** The diff view: labels, then one block per side, `-` removed, `+` added. */
function changeRegionText(view: ChangeView): string[] {
  const lines: string[] = [EDIT_VIEW_HEADING];
  for (const field of view.labels) lines.push(`${field.label}: ${field.text}`);
  // The tier qualifier, rendered for BOTH tiers. Printing it only for a
  // proposal would make "live" the silent default, and the silent default is
  // the one that reaches the real file.
  const rule = view.labels.find((field) => field.label === "rule");
  if (rule !== undefined && rule.text.startsWith("protected-path")) {
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

/** Lines of command before the view folds. Same budget, same marker, as a diff. */
export const COMMAND_LINE_BUDGET = DIFF_LINE_BUDGET;

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
 * Where the exact bytes live, and how to get them back (APRV-126).
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
  lines.push(...fold(commandLines.map(markEscapes), COMMAND_LINE_BUDGET));
  lines.push(COMMAND_END);
  // On its own line, beneath the command, because it is the other half of what
  // the command does and a `cd` the reader never saw is the whole difference
  // between a repository and someone else's.
  lines.push(`cwd: ${view.cwd === null ? "(none declared)" : markEscapes(view.cwd)}`);
  lines.push(rawBytesLine(hash));
  return lines;
}

// ---------------------------------------------------------------------------
// The protected path (APRV-143)
// ---------------------------------------------------------------------------

/** The rule names a file-tool touch of a protected path reports (`cli/hook.ts`). */
const PROTECTED_RULE_NAMES: readonly string[] = ["protected-path", "protected-path-proposal"];

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
 *   payload's own `rule` is used as the label only when it is one of the two
 *   the hook writes, which is what keeps the worktree-proposal tier legible.
 *
 * `extra` is `policy.protected_paths`, passed exactly as every enforcement path
 * passes it; omitting it narrows the answer and never widens it.
 */
export function protectedPathView(
  value: unknown,
  extra: readonly string[] = [],
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

/**
 * The text a channel puts inside its payload region.
 *
 * For a recognised, whole payload: the field-by-field view, then the canonical
 * JSON underneath. For anything else — an unrecognised shape, or a rendering
 * the tagging layer already truncated, where `value` holds more than `text`
 * admits to showing — exactly what a channel rendered before this module
 * existed.
 */
export function payloadRegionText(rendering: PayloadRendering): string {
  if (rendering.truncated) return rendering.text;

  const command = commandPayloadView(rendering.value);
  if (command !== null) {
    return [
      ...commandRegionText(command, rendering.hash),
      "",
      CANONICAL_JSON_HEADING,
      rendering.text,
    ].join("\n");
  }

  const change = changePayloadView(rendering.value);
  if (change !== null) {
    return [...changeRegionText(change), "", CANONICAL_JSON_HEADING, rendering.text].join("\n");
  }

  const fields = emailPayloadFields(rendering.value);
  if (fields === null) return rendering.text;

  const lines: string[] = [EMAIL_VIEW_HEADING];
  for (const field of fields) {
    if (field.label === "body") continue;
    lines.push(`${field.label}: ${field.text}`);
  }
  const body = fields.find((field) => field.label === "body");
  if (body !== undefined) {
    const count = body.text === "" ? 0 : body.text.split("\n").length;
    lines.push(`body (${count} line${count === 1 ? "" : "s"}):`, BODY_BEGIN, body.text, BODY_END);
  }
  lines.push("", CANONICAL_JSON_HEADING, rendering.text);
  return lines.join("\n");
}
