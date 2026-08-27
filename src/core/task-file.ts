/**
 * The task-file writer: round-trip rewriting that preserves everything it does
 * not own (SPEC.md §6, APRV-61).
 *
 * SPEC.md §6 is a MUST: "Implementations MUST preserve unknown frontmatter keys
 * when rewriting files." `core/frontmatter.ts` is the reader and is read-only in
 * the strongest sense; this module is its counterpart, and the only place in the
 * codebase that produces new task-file bytes.
 *
 * The bar is not "preserve the keys we can think of". Backlog.md 1.49.3 itself
 * fails this MUST — the `envelope-edit-before` / `envelope-edit-after` fixtures
 * record it dropping our whole `approval:` key on an unrelated `task edit` — and
 * we extend that convention rather than fork it, so the writer that has to be
 * trustworthy is ours.
 *
 * ## Why lines, not a YAML document
 *
 * The obvious implementation reserialises the frontmatter through the `yaml`
 * library's Document API. It preserves more than a naive `parse`/`stringify`
 * round trip, but it does not preserve *bytes*: quoting style, intra-line
 * spacing, comment placement, and blank-line runs are all reconstructed from the
 * library's own defaults. Every one of those is a spurious diff in a user's git
 * history, and a diff nobody can explain is how a board tool's metadata gets
 * quietly eaten.
 *
 * So this module treats the frontmatter as **lines with their terminators**, and
 * the parsed YAML only as an oracle:
 *
 *   - the hardened parser decides whether the block is *structurally* valid at
 *     all (and, being hardened, rejects duplicate keys, tags, and unbounded
 *     aliases before any of them can reach a rewrite);
 *   - a column-0 line scan finds the `approval:` key's line range;
 *   - only that range is rewritten, and for a state-only edit only the single
 *     `state:` line inside it;
 *   - every other line — every other key, its order, its quoting, its comments,
 *     the blank lines between them, both `---` delimiters, and the entire body
 *     after the closing delimiter — is re-emitted as the exact bytes that came
 *     in, terminator included.
 *
 * Byte-identity is therefore a property of the construction, not of a
 * comparison performed afterwards: untouched lines are never parsed and never
 * rebuilt. The corpus test (`tests/task-file.test.ts`) still asserts it against
 * every real Backlog.md fixture, because a construction argument that is not
 * checked is a construction argument that has already drifted.
 *
 * ## What "unknown key" means here
 *
 * Every frontmatter key except `approval:` is unknown to this writer, and that
 * is deliberate. `id`, `title`, `status`, `milestone`, `ordinal`,
 * `parent_task_id` and the rest belong to Backlog.md; a key some future board
 * tool invents belongs to it. This module has no allow-list of keys it tolerates
 * — it has one key it owns and rewrites, and it cannot express a change to
 * anything else. There is no edit in {@link TaskFileEdit} that removes a key,
 * reorders keys, or touches the body.
 *
 * ## This writer never touches the log
 *
 * A task file is a **projection** (SPEC.md §6.3): the daemon writes `state:`
 * into the file *after* the event is appended, never the reverse. Nothing here
 * opens `.approval/`, appends to `events.jsonl`, or computes a hash chain.
 * {@link rewriteTaskFile} is a pure function of (bytes, edit) with no clock, no
 * network, and no filesystem access at all; {@link writeTaskFileAtomic} writes
 * exactly the one path it is handed.
 *
 * Determinism: same input bytes and same edit, same output bytes, always. Never
 * throws — every failure is a structured result carrying one of the codes in
 * {@link TaskFileErrorCode}.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { stringify } from "yaml";

import { FRONTMATTER_DELIMITER, parseFrontmatter } from "./frontmatter.js";
import { parseHardenedYaml } from "./policy-load.js";
import { validate, type ValidateOptions, type ValidationMode } from "./validate.js";
// Type-only, so nothing in `core/` depends on `daemon/` at runtime. The
// vocabulary is spelled once, in `daemon/projection.ts`, and the runtime gate on
// it here is `envelope.schema.json` rather than the type: a caller reaching this
// module from untyped JSON still cannot write a state the schema rejects.
import type { EnvelopeState } from "../daemon/projection.js";

/** The frontmatter key this module owns. Everything else is preserved verbatim. */
export const ENVELOPE_KEY = "approval";

/** The schema id (`schema/envelope.schema.json`) the result is validated against. */
export const ENVELOPE_SCHEMA_ID = "envelope";

/**
 * Why a rewrite was refused. Closed union, pinned by `tests/task-file.test.ts`:
 * a caller distinguishing "this file has no envelope yet" from "this file is
 * corrupt" must be able to do so mechanically.
 */
export type TaskFileErrorCode =
  /** The file does not begin with a `---` line: no frontmatter to rewrite. */
  | "no-frontmatter"
  /** An opening `---` with no closing `---` before end of file. */
  | "unterminated"
  /** The frontmatter is not parseable under the hardened YAML settings. */
  | "yaml-error"
  /** The frontmatter parsed, but not to a mapping. */
  | "not-a-map"
  /** A state edit was asked for and the file carries no `approval:` key. */
  | "no-envelope"
  /** An `approval:` key exists and its value is not a mapping. */
  | "envelope-not-a-map"
  /** The `approval:` block is not block-style mapping this writer can line-edit. */
  | "unsupported-shape"
  /** The envelope the edit would produce fails `envelope.schema.json`. */
  | "invalid-envelope"
  /** The envelope could not be serialised to YAML. */
  | "serialize-failed"
  /** Self-check: the rewritten bytes did not re-read as the intended document. */
  | "round-trip-failed"
  /** An unexpected throw, converted rather than propagated. */
  | "internal-error"
  /** {@link writeTaskFileAtomic} only: the bytes did not reach the disk. */
  | "write-failed";

/** Outcome of {@link rewriteTaskFile}. */
export type RewriteResult =
  | { ok: true; bytes: string; changed: boolean }
  | { ok: false; code: TaskFileErrorCode; message: string };

/**
 * The changes this writer can express. Deliberately tiny, and deliberately
 * additive: there is no edit that removes the envelope, removes any other key,
 * reorders keys, or reaches the body.
 *
 * - `none` — rewrite nothing. The output is the input, byte for byte, once the
 *   frontmatter has been confirmed structurally sound. Used to prove the reader
 *   and the writer agree on a file before anything is changed.
 * - `set-state` — replace the value on the envelope's direct `state:` line
 *   (SPEC.md §6.3). Exactly one line of the file changes.
 * - `set-envelope` — write the whole `approval:` subtree, inserting the key when
 *   the file has none.
 */
export type TaskFileEdit =
  | { kind: "none" }
  | { kind: "set-state"; state: EnvelopeState }
  | { kind: "set-envelope"; envelope: Record<string, unknown> };

/** Options accepted by {@link rewriteTaskFile}. */
export interface RewriteOptions {
  /** Schema directory, forwarded to {@link validate}. Injectable for tests. */
  schemaDir?: string;
}

function failure(code: TaskFileErrorCode, message: string): { ok: false; code: TaskFileErrorCode; message: string } {
  return { ok: false, code, message };
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ---------------------------------------------------------------------------
// Lines that remember how they ended
// ---------------------------------------------------------------------------

/**
 * One source line and the bytes that terminated it (`"\n"`, `"\r\n"`, `"\r"`,
 * or `""` for a final line with no terminator).
 *
 * Carrying the terminator per line is what makes the CRLF decision free: a
 * Windows-edited task file is still a task file (`core/frontmatter.ts` says so
 * and accepts it), so this writer **preserves** line endings rather than
 * refusing them or normalising them. Untouched lines keep their own bytes;
 * rewritten and inserted lines inherit the terminator of the line they replace
 * or follow. A file with mixed endings therefore keeps its mixture exactly, and
 * a file with none stays that way — no rule to get wrong, because nothing is
 * ever re-derived.
 */
interface SourceLine {
  text: string;
  term: string;
}

/** Split into {@link SourceLine}s such that concatenating them restores `input`. */
function splitLines(input: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const pattern = /\r\n|\n|\r/gu;
  let start = 0;
  let match = pattern.exec(input);
  while (match !== null) {
    lines.push({ text: input.slice(start, match.index), term: match[0] });
    start = pattern.lastIndex;
    match = pattern.exec(input);
  }
  lines.push({ text: input.slice(start), term: "" });
  return lines;
}

function joinLines(lines: readonly SourceLine[]): string {
  let out = "";
  for (const line of lines) out += line.text + line.term;
  return out;
}

// ---------------------------------------------------------------------------
// Locating the frontmatter and the envelope block
// ---------------------------------------------------------------------------

interface Located {
  lines: SourceLine[];
  /** Index of the closing `---` line. */
  close: number;
  /** Parsed frontmatter mapping (hardened). */
  data: Record<string, unknown>;
  /** Index of the column-0 `approval:` line, or -1. */
  envelopeStart: number;
  /** Index of the last line belonging to the envelope block (== start if one line). */
  envelopeEnd: number;
}

/** A column-0 `approval:` key line. Nested keys are indented and never match. */
const ENVELOPE_KEY_LINE = /^approval[ \t]*:/u;

/**
 * Find the frontmatter, parse it under the hardened settings, and locate the
 * `approval:` block's line range.
 *
 * The delimiter rules are the reader's, character for character: the file must
 * begin with a line that is exactly `---`, and the block ends at the *first*
 * following line that is exactly `---`. A `---` inside the markdown body is
 * therefore never mistaken for the closing delimiter — it lies after the close
 * and is part of the suffix this writer copies verbatim.
 */
function locate(text: string): Located | { ok: false; code: TaskFileErrorCode; message: string } {
  const lines = splitLines(text);
  const first = lines[0];
  if (first === undefined || first.text !== FRONTMATTER_DELIMITER) {
    return failure(
      "no-frontmatter",
      `the file does not begin with a ${FRONTMATTER_DELIMITER} line, so it carries no frontmatter to rewrite. This writer never invents a frontmatter block: adding one would change a file whose shape it does not understand (SPEC.md §6 requires tolerating tasks with no envelope, not manufacturing one).`,
    );
  }

  let close = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.text === FRONTMATTER_DELIMITER) {
      close = index;
      break;
    }
  }
  if (close === -1) {
    return failure(
      "unterminated",
      `frontmatter opened with ${FRONTMATTER_DELIMITER} but no closing ${FRONTMATTER_DELIMITER} line was found; a truncated frontmatter block is indistinguishable from a complete one and is refused`,
    );
  }

  const source = lines
    .slice(1, close)
    .map((line) => line.text)
    .join("\n");
  const parsed = parseHardenedYaml(source, {
    subject: "frontmatter YAML",
    tagContext: "a task envelope",
  });
  if (!parsed.ok) return failure("yaml-error", parsed.message);

  const value = parsed.value;
  let data: Record<string, unknown>;
  if (value === null || value === undefined) {
    data = {};
  } else if (typeof value !== "object" || Array.isArray(value)) {
    return failure(
      "not-a-map",
      `frontmatter must be a YAML mapping, got ${Array.isArray(value) ? "a sequence" : typeof value}`,
    );
  } else {
    data = value as Record<string, unknown>;
  }

  let envelopeStart = -1;
  for (let index = 1; index < close; index += 1) {
    if (ENVELOPE_KEY_LINE.test(lines[index]?.text ?? "")) {
      envelopeStart = index;
      break;
    }
  }
  // A second column-0 `approval:` would be a duplicate key, which the hardened
  // parser already refused above, so the first match is the only match.

  let envelopeEnd = envelopeStart;
  if (envelopeStart !== -1) {
    for (let index = envelopeStart + 1; index < close; index += 1) {
      const line = lines[index]?.text ?? "";
      // Blank lines neither extend the block nor end it: a run of blanks before
      // the next top-level key belongs to that key, not to the envelope.
      if (line.trim() === "") continue;
      // Anything at column 0 starts a new top-level construct (a key, or a
      // comment introducing one). Indented lines are the envelope's own.
      if (!/^[ \t]/u.test(line)) break;
      envelopeEnd = index;
    }
  }

  return { lines, close, data, envelopeStart, envelopeEnd };
}

// ---------------------------------------------------------------------------
// Serialising an envelope
// ---------------------------------------------------------------------------

/**
 * Render `{ approval: envelope }` as block YAML lines.
 *
 * `lineWidth: 0` disables folding, so a long summary stays on one line and the
 * output does not depend on the length of neighbouring keys.
 * `aliasDuplicateObjects: false` keeps the serialiser from emitting `&anchor` /
 * `*alias` when the same object appears twice in the envelope: aliases are a
 * thing the hardened parser bounds and distrusts on the way in, so this writer
 * does not produce them on the way out.
 */
function serialiseEnvelope(
  envelope: Record<string, unknown>,
  term: string,
): { ok: true; lines: SourceLine[] } | { ok: false; code: TaskFileErrorCode; message: string } {
  let rendered: string;
  try {
    rendered = stringify(
      { [ENVELOPE_KEY]: envelope },
      { indent: 2, lineWidth: 0, aliasDuplicateObjects: false },
    );
  } catch (cause) {
    return failure("serialize-failed", `the envelope could not be serialised to YAML: ${detail(cause)}`);
  }
  const texts = rendered.split("\n");
  // `stringify` terminates its last line; drop the empty tail it leaves behind.
  if (texts[texts.length - 1] === "") texts.pop();
  if (texts.length === 0) {
    return failure("serialize-failed", "the envelope serialised to nothing, which cannot be spliced into frontmatter");
  }
  return { ok: true, lines: texts.map((text) => ({ text, term })) };
}

// ---------------------------------------------------------------------------
// The state line
// ---------------------------------------------------------------------------

/**
 * A direct child `state:` line: leading indent, the key, and an optional
 * trailing comment. The value is captured so it can be replaced without
 * disturbing the indent, the spacing around the colon, or the comment.
 */
const STATE_LINE = /^([ \t]+state[ \t]*:[ \t]*)([^#]*?)([ \t]*#.*)?$/u;

/** The indent string of the envelope block's direct children, or null. */
function childIndent(lines: readonly SourceLine[], start: number, end: number): string | null {
  for (let index = start + 1; index <= end; index += 1) {
    const text = lines[index]?.text ?? "";
    if (text.trim() === "") continue;
    return /^[ \t]*/u.exec(text)?.[0] ?? "";
  }
  return null;
}

// ---------------------------------------------------------------------------
// rewriteTaskFile
// ---------------------------------------------------------------------------

/**
 * Rewrite a task file's `approval:` subtree, preserving everything else byte for
 * byte.
 *
 * Returns the new bytes, plus `changed` so a caller can skip a pointless write.
 * On any refusal the input is untouched and nothing has been written anywhere:
 * this function does not touch the filesystem at all.
 *
 * Insertion position (`set-envelope` on a file with no `approval:` key): the key
 * is appended as the **last** top-level key, immediately before the closing
 * delimiter. The corpus is the reason this needed a decision rather than a
 * default. Backlog.md does not append its own new keys — in `milestone-assign/`
 * the CLI put `milestone:` between `labels:` and `dependencies:`, because it
 * rewrites frontmatter from its own model in its own canonical order — and at
 * 1.49.3 it does not preserve unknown keys at all, so no position we pick
 * survives its next edit. Given that no position is safe from the CLI, the
 * choice is made on the diff: last keeps a multi-line block out of the middle of
 * the board's short scalar keys, so inserting it moves no existing line, and it
 * matches where the hand-written `envelope-edit-before` fixture put the envelope.
 */
export function rewriteTaskFile(
  text: string,
  edit: TaskFileEdit,
  options: RewriteOptions = {},
): RewriteResult {
  try {
    return rewriteInner(text, edit, options);
  } catch (cause) {
    // A rewrite must never throw into a caller mid-write. Anything unforeseen
    // becomes a refusal, and a refusal leaves the file alone.
    return failure("internal-error", `the rewrite failed unexpectedly and produced nothing: ${detail(cause)}`);
  }
}

function rewriteInner(text: string, edit: TaskFileEdit, options: RewriteOptions): RewriteResult {
  const located = locate(text);
  if ("ok" in located) return located;
  const { lines, close, data, envelopeStart, envelopeEnd } = located;

  if (edit.kind === "none") {
    // Nothing is reserialised, so there is nothing that could differ. The parse
    // above still ran: a caller asking for a no-op rewrite is asking whether
    // this file is one the writer could edit, and a corrupt one is not.
    return { ok: true, bytes: text, changed: false };
  }

  const existing = Object.hasOwn(data, ENVELOPE_KEY) ? data[ENVELOPE_KEY] : undefined;
  const hasEnvelopeKey = envelopeStart !== -1;
  if (hasEnvelopeKey && !isPlainObject(existing)) {
    return failure(
      "envelope-not-a-map",
      `the \`${ENVELOPE_KEY}:\` key holds ${describe(existing)}, not a mapping. This writer will not overwrite a key whose contents it cannot recognise as an envelope (SPEC.md §6.1); a human resolves that, deliberately, before the runtime writes over it.`,
    );
  }

  // What the envelope will be once the edit lands. Validated before any bytes
  // are produced, so an invalid edit never reaches the splice.
  let intended: Record<string, unknown>;
  if (edit.kind === "set-envelope") {
    intended = edit.envelope;
  } else {
    if (!hasEnvelopeKey) {
      return failure(
        "no-envelope",
        `a state edit needs an existing envelope and this file has no \`${ENVELOPE_KEY}:\` key. SPEC.md §6 requires tolerating tasks with no envelope; such a task simply cannot request side-effecting execution, and its state is not a thing to set.`,
      );
    }
    intended = { ...(existing as Record<string, unknown>), state: edit.state };
  }

  // `set-state` rewrites one field of an envelope an earlier write boundary
  // already accepted, so the fields it preserves validate at the read boundary:
  // refusing the pre-APRV-121 monetary form here would leave a historical file
  // in permanent, unrepairable drift (APRV-148). `set-envelope` authors the
  // whole claim and stays strict.
  const mode: ValidationMode = edit.kind === "set-state" ? "historical" : "write";
  const schemaCheck = validate(
    ENVELOPE_SCHEMA_ID,
    intended,
    options.schemaDir === undefined
      ? ({ mode } satisfies ValidateOptions)
      : ({ schemaDir: options.schemaDir, mode } satisfies ValidateOptions),
  );
  if (!schemaCheck.ok) {
    return failure(
      "invalid-envelope",
      `the envelope this edit would write does not validate against ${ENVELOPE_SCHEMA_ID}.schema.json: ${schemaCheck.errors
        .map((error) => `${error.path === "" ? "<root>" : error.path} ${error.message}`)
        .join("; ")}`,
    );
  }

  const out = [...lines];

  if (edit.kind === "set-state") {
    const inline = inlineValueOf(lines[envelopeStart]?.text ?? "");
    if (inline !== "") {
      return failure(
        "unsupported-shape",
        `the \`${ENVELOPE_KEY}:\` key carries its value inline (${JSON.stringify(inline)}) rather than as an indented block. A state-only edit rewrites exactly one line, which a flow-style envelope does not have; rewrite the whole subtree with a set-envelope edit instead.`,
      );
    }
    const indent = childIndent(lines, envelopeStart, envelopeEnd);
    if (indent === null) {
      return failure(
        "unsupported-shape",
        `the \`${ENVELOPE_KEY}:\` key has no indented block beneath it, so there is no \`state:\` line to edit`,
      );
    }

    let stateIndex = -1;
    let match: RegExpExecArray | null = null;
    for (let index = envelopeStart + 1; index <= envelopeEnd; index += 1) {
      const line = lines[index]?.text ?? "";
      const candidate = STATE_LINE.exec(line);
      if (candidate === null) continue;
      if (candidate[1]?.startsWith(indent) !== true) continue;
      // A direct child, not a `state:` nested deeper inside the envelope.
      if ((/^[ \t]*/u.exec(line)?.[0] ?? "") !== indent) continue;
      stateIndex = index;
      match = candidate;
      break;
    }
    if (stateIndex === -1 || match === null) {
      return failure(
        "unsupported-shape",
        `the envelope has no direct \`state:\` line in block style. The parsed envelope does carry a state (it validated), so the value is expressed in a form this line editor does not rewrite (flow mapping, anchor, or block scalar); use a set-envelope edit.`,
      );
    }
    const value = (match[2] ?? "").trim();
    if (value === "" || /^[|>&*]/u.test(value)) {
      return failure(
        "unsupported-shape",
        `the envelope's \`state:\` value is not a plain scalar on its own line (${JSON.stringify(value)}); use a set-envelope edit`,
      );
    }

    const previous = lines[stateIndex] as SourceLine;
    // The prefix (indent, key, spacing) and any trailing comment are re-emitted
    // verbatim: only the value's bytes change, and only on this line.
    out[stateIndex] = { text: `${match[1] ?? ""}${edit.state}${match[3] ?? ""}`, term: previous.term };
  } else if (hasEnvelopeKey) {
    const term = (lines[envelopeStart] as SourceLine).term;
    const serialised = serialiseEnvelope(intended, term);
    if (!serialised.ok) return serialised;
    out.splice(envelopeStart, envelopeEnd - envelopeStart + 1, ...serialised.lines);
  } else {
    // Insert as the last top-level key, immediately before the closing `---`.
    // The terminator comes from the last frontmatter line, which always exists
    // and always has one (a line before the close is a line something follows).
    const term = (lines[close - 1] as SourceLine).term;
    const serialised = serialiseEnvelope(intended, term);
    if (!serialised.ok) return serialised;
    out.splice(close, 0, ...serialised.lines);
  }

  const bytes = joinLines(out);

  const verified = verify(text, bytes, close, lines, data, intended);
  if (verified !== null) return verified;

  return { ok: true, bytes, changed: bytes !== text };
}

/** Text after the `approval:` colon, minus a trailing comment. `""` when block-style. */
function inlineValueOf(line: string): string {
  const colon = line.indexOf(":");
  if (colon === -1) return "";
  const after = line.slice(colon + 1).trim();
  if (after.startsWith("#")) return "";
  return after;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a sequence";
  return `a ${typeof value}`;
}

/**
 * Self-check on the produced bytes. Returns null when they are sound.
 *
 * Byte preservation is a property of the construction — untouched lines are
 * copied, never rebuilt — but the construction rests on a line scan for the
 * envelope's range, and a line scan is exactly the kind of thing that is subtly
 * wrong on a shape nobody tried. So the output is read back through the ordinary
 * reader and checked three ways: the markdown body must be the same trailing
 * bytes, every non-`approval` key must survive with the same value *and the same
 * position*, and the envelope must be the one the edit intended. A failure here
 * is a bug in this module, and it fails closed: the caller gets a refusal rather
 * than bytes nobody verified.
 */
function verify(
  input: string,
  output: string,
  close: number,
  lines: readonly SourceLine[],
  before: Record<string, unknown>,
  intended: Record<string, unknown>,
): { ok: false; code: TaskFileErrorCode; message: string } | null {
  const suffix = joinLines(lines.slice(close));
  if (!output.endsWith(suffix) || !input.endsWith(suffix)) {
    return failure(
      "round-trip-failed",
      "the rewritten file does not end in the same bytes as the original: the closing delimiter or the markdown body was disturbed",
    );
  }

  const reread = parseFrontmatter(output);
  if (!reread.ok) {
    return failure(
      "round-trip-failed",
      `the rewritten frontmatter no longer parses (${reread.code}: ${reread.message}); nothing was written`,
    );
  }

  const keysBefore = Object.keys(before).filter((key) => key !== ENVELOPE_KEY);
  const keysAfter = Object.keys(reread.data).filter((key) => key !== ENVELOPE_KEY);
  if (!isDeepStrictEqual(keysBefore, keysAfter)) {
    return failure(
      "round-trip-failed",
      `the rewrite changed the frontmatter's other keys or their order (${keysBefore.join(", ")} became ${keysAfter.join(", ")}); nothing was written`,
    );
  }
  for (const key of keysBefore) {
    if (!isDeepStrictEqual(before[key], reread.data[key])) {
      return failure(
        "round-trip-failed",
        `the rewrite changed the value of the unrelated frontmatter key \`${key}\`; nothing was written`,
      );
    }
  }

  if (!isDeepStrictEqual(reread.data[ENVELOPE_KEY], intended)) {
    return failure(
      "round-trip-failed",
      `the rewritten \`${ENVELOPE_KEY}:\` subtree does not read back as the envelope the edit asked for; nothing was written`,
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// writeTaskFileAtomic
// ---------------------------------------------------------------------------

/** Outcome of {@link writeTaskFileAtomic}. */
export type WriteTaskFileResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; code: TaskFileErrorCode; message: string };

/** Distinguishes concurrent writers' temp files within one process. */
let tempCounter = 0;

/**
 * Write task-file bytes atomically: temp file in the destination directory, then
 * rename.
 *
 * The same idiom as `core/payload-store.ts` and `channels/render-queue.ts`, for
 * the same reason: a reader — a board tool, an editor, the next agent — sees
 * either the previous complete file or the new one, never a half-written task.
 * The temp name is the only non-deterministic thing here and it never reaches
 * the file's contents; it is removed on every failure path, so a failed write
 * leaves no debris beside the task.
 *
 * Writes this one path and nothing else. It does not open the log.
 */
export function writeTaskFileAtomic(path: string, bytes: string): WriteTaskFileResult {
  const directory = dirname(path);
  tempCounter += 1;
  const temp = join(directory, `.${basename(path)}.tmp-${String(process.pid)}-${String(tempCounter)}`);
  try {
    mkdirSync(directory, { recursive: true });
    const handle = openSync(temp, "wx");
    try {
      writeSync(handle, bytes, 0, "utf8");
    } finally {
      closeSync(handle);
    }
    renameSync(temp, path);
  } catch (cause) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
    return failure("write-failed", `task file ${path} could not be written: ${detail(cause)}. Nothing was written and the log was not touched.`);
  }
  return { ok: true, path, bytes: Buffer.byteLength(bytes, "utf8") };
}
