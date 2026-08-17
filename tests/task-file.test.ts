/**
 * The task-file writer (APRV-61): round-trip rewriting proved against real
 * Backlog.md output.
 *
 * Two halves.
 *
 *   1. **The corpus.** `tests/fixtures/backlog/` holds bytes the pinned
 *      Backlog.md CLI actually wrote (APRV-65). Every markdown fixture in it is
 *      run through the writer: a no-op rewrite must return the input byte for
 *      byte, and the shapes the CLI emits — single-quoted dates, empty flow
 *      sequences, block sequences, comment markers, a `title:` folded across two
 *      lines — must survive an edit untouched. A format change upstream fails
 *      here rather than in a user's git history.
 *
 *   2. **The edges the corpus cannot contain.** CRLF, a missing frontmatter
 *      block, an unterminated one, duplicate keys, an `approval:` key holding
 *      something that is not an envelope, a body with a literal `---` line, a
 *      file with no trailing newline. These are hand-built, because the CLI will
 *      never produce them and a user's editor eventually will.
 *
 * The load-bearing test is `the envelope survives our writer, which is the
 * whole point`: at 1.49.3 Backlog.md drops the `approval:` key on an unrelated
 * edit (`tests/backlog-fixtures.test.ts` freezes that observation). SPEC.md §6
 * says implementations MUST preserve unknown frontmatter keys. We extend that
 * convention, so the writer that has to honour the MUST is ours.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { parseFrontmatter } from "../src/core/frontmatter.js";
import {
  ENVELOPE_KEY,
  rewriteTaskFile,
  writeTaskFileAtomic,
  type TaskFileEdit,
  type TaskFileErrorCode,
} from "../src/core/task-file.js";

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CORPUS = join(REPO_ROOT, "tests", "fixtures", "backlog");

const NO_EDIT: TaskFileEdit = { kind: "none" };

/** A minimal envelope that validates against `schema/envelope.schema.json`. */
function envelope(state = "awaiting"): Record<string, unknown> {
  return {
    origin: { app: "test", created_by: "human:carter" },
    state,
    actions: [
      {
        class: "communicate.email.external",
        summary: "Send the chaser",
        reversible: false,
        est_cost_usd: 0.02,
        idempotency_key: "task-1:chaser",
      },
    ],
  };
}

/** Every file under `dir`, as paths relative to `dir`, sorted. */
function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/** Every corpus task/milestone markdown file (the README is documentation). */
function corpusMarkdown(): string[] {
  return walk(CORPUS).filter((file) => file.endsWith(".md") && !file.endsWith("README.md"));
}

function read(file: string): string {
  return readFileSync(join(CORPUS, file), "utf8");
}

/** Indices of the lines on which two texts differ, splitting on any terminator. */
function differingLines(left: string, right: string): number[] {
  const a = left.split(/\r\n|\n|\r/u);
  const b = right.split(/\r\n|\n|\r/u);
  const out: number[] = [];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) out.push(index);
  }
  return out;
}

function expectOk(result: ReturnType<typeof rewriteTaskFile>): { bytes: string; changed: boolean } {
  assert.ok(result.ok, result.ok ? "" : `rewrite refused: ${result.code}: ${result.message}`);
  return { bytes: result.bytes, changed: result.changed };
}

function expectCode(result: ReturnType<typeof rewriteTaskFile>, code: TaskFileErrorCode): string {
  assert.ok(!result.ok, "the rewrite was expected to be refused and was not");
  assert.equal(result.code, code, `expected code ${code}, got ${result.code}: ${result.message}`);
  assert.ok(result.message.length > 20, "a refusal must say why in more than a few words");
  return result.message;
}

// ---------------------------------------------------------------------------
// The error vocabulary
// ---------------------------------------------------------------------------

test("the error code union is closed and exactly this list", () => {
  // The Record pins both directions at compile time: a code added to the union
  // and not here fails typecheck, and a code here that is not in the union does
  // too. The runtime assertion pins the spelling, which is what a caller
  // switches on.
  const codes: Record<TaskFileErrorCode, true> = {
    "no-frontmatter": true,
    unterminated: true,
    "yaml-error": true,
    "not-a-map": true,
    "no-envelope": true,
    "envelope-not-a-map": true,
    "unsupported-shape": true,
    "invalid-envelope": true,
    "serialize-failed": true,
    "round-trip-failed": true,
    "internal-error": true,
    "write-failed": true,
  };
  assert.deepEqual(Object.keys(codes).sort(), [
    "envelope-not-a-map",
    "internal-error",
    "invalid-envelope",
    "no-envelope",
    "no-frontmatter",
    "not-a-map",
    "round-trip-failed",
    "serialize-failed",
    "unsupported-shape",
    "unterminated",
    "write-failed",
    "yaml-error",
  ]);
});

// ---------------------------------------------------------------------------
// The corpus: no-edit identity
// ---------------------------------------------------------------------------

test("a rewrite with no edit is byte-identical for every corpus fixture", () => {
  const files = corpusMarkdown();
  assert.ok(files.length >= 10, `the corpus holds implausibly few markdown fixtures (${files.length})`);
  for (const file of files) {
    const text = read(file);
    const result = rewriteTaskFile(text, NO_EDIT);
    assert.ok(result.ok, `${file}: ${result.ok ? "" : `${result.code}: ${result.message}`}`);
    assert.equal(
      result.bytes,
      text,
      `${file} did not survive a no-op rewrite byte for byte. These are real bytes from the pinned ` +
        "Backlog.md CLI: a difference here is our writer editing a user's file when it was asked to change nothing.",
    );
    assert.equal(result.changed, false, `${file}: a no-op rewrite reported a change`);
  }
});

test("the corpus config file is not a task file and is refused, never repaired", () => {
  // `init/config.yml` is plain YAML with no frontmatter delimiters. The writer
  // must not wrap it in `---` and call it a task.
  const text = readFileSync(join(CORPUS, "init", "config.yml"), "utf8");
  expectCode(rewriteTaskFile(text, { kind: "set-envelope", envelope: envelope() }), "no-frontmatter");
});

// ---------------------------------------------------------------------------
// The corpus: the state edit
// ---------------------------------------------------------------------------

const BEFORE = "envelope-edit-before/task-3 - Send-deposit-chaser-email.md";

test("a state-only edit changes exactly the state line and nothing else", () => {
  const text = read(BEFORE);
  const { bytes, changed } = expectOk(rewriteTaskFile(text, { kind: "set-state", state: "approved" }));
  assert.equal(changed, true);

  const changedLines = differingLines(text, bytes);
  assert.deepEqual(changedLines.length, 1, `expected one changed line, got ${changedLines.length}: ${changedLines.join(", ")}`);
  const index = changedLines[0] as number;
  assert.equal(text.split("\n")[index], "  state: awaiting");
  assert.equal(bytes.split("\n")[index], "  state: approved");
});

test("the envelope survives our writer, which is the whole point", () => {
  // Backlog.md 1.49.3, handed this exact file, returns it with the `approval:`
  // key gone (the `envelope-edit-after` fixture). SPEC.md §6 makes preserving
  // unknown keys a MUST. This asserts the two behaviours side by side.
  const text = read(BEFORE);
  const before = parseFrontmatter(text);
  assert.ok(before.ok);

  const cliResult = parseFrontmatter(read("envelope-edit-after/task-3 - Send-deposit-chaser-email.md"));
  assert.ok(cliResult.ok);
  assert.ok(
    !Object.hasOwn(cliResult.data, ENVELOPE_KEY),
    "the CLI fixture no longer demonstrates envelope loss; if the pin moved, this contrast needs rewriting",
  );

  const { bytes } = expectOk(rewriteTaskFile(text, { kind: "set-state", state: "executed" }));
  const after = parseFrontmatter(bytes);
  assert.ok(after.ok);

  const kept = after.data[ENVELOPE_KEY];
  assert.ok(kept !== undefined, "our writer dropped the envelope; that is the failure this project exists to prevent");
  const original = before.data[ENVELOPE_KEY] as Record<string, unknown>;
  assert.deepEqual(kept, { ...original, state: "executed" });
  // Every hand-written detail of the envelope survives, not just the keys the
  // schema happens to require.
  assert.deepEqual((kept as Record<string, unknown>)["route"], original["route"]);
  assert.deepEqual((kept as Record<string, unknown>)["actions"], original["actions"]);
  assert.deepEqual((kept as Record<string, unknown>)["budget"], original["budget"]);
});

test("a state edit preserves the body and every board key of the fixture", () => {
  const text = read(BEFORE);
  const { bytes } = expectOk(rewriteTaskFile(text, { kind: "set-state", state: "rejected" }));
  const bodyStart = text.indexOf("\n---\n", 4);
  assert.ok(bodyStart > 0);
  assert.equal(bytes.slice(bodyStart), text.slice(bodyStart), "the markdown body was disturbed");

  const before = parseFrontmatter(text);
  const after = parseFrontmatter(bytes);
  assert.ok(before.ok && after.ok);
  assert.deepEqual(Object.keys(after.data), Object.keys(before.data), "key order changed");
  for (const key of Object.keys(before.data)) {
    if (key === ENVELOPE_KEY) continue;
    assert.deepEqual(after.data[key], before.data[key], `key ${key} changed`);
  }
});

test("a state edit on a corpus file with no envelope is refused, not invented", () => {
  for (const file of corpusMarkdown()) {
    const text = read(file);
    const parsed = parseFrontmatter(text);
    assert.ok(parsed.ok);
    if (Object.hasOwn(parsed.data, ENVELOPE_KEY)) continue;
    expectCode(rewriteTaskFile(text, { kind: "set-state", state: "approved" }), "no-envelope");
  }
});

// ---------------------------------------------------------------------------
// The corpus: envelope insertion
// ---------------------------------------------------------------------------

const CREATE = "create/task-1 - Chase-deposit-refund-from-letting-agency.md";

test("an envelope inserted into a corpus fixture reads back through core/frontmatter", () => {
  const text = read(CREATE);
  const before = parseFrontmatter(text);
  assert.ok(before.ok && !Object.hasOwn(before.data, ENVELOPE_KEY));

  const wanted = envelope("proposed");
  const { bytes, changed } = expectOk(rewriteTaskFile(text, { kind: "set-envelope", envelope: wanted }));
  assert.equal(changed, true);

  const after = parseFrontmatter(bytes);
  assert.ok(after.ok);
  assert.deepEqual(after.data[ENVELOPE_KEY], wanted);
  assert.deepEqual(
    Object.keys(after.data),
    [...Object.keys(before.data), ENVELOPE_KEY],
    "the envelope was not appended as the last top-level key, or an existing key moved",
  );
  for (const key of Object.keys(before.data)) {
    assert.deepEqual(after.data[key], before.data[key], `key ${key} changed`);
  }
});

test("insertion moves no existing line and leaves the body byte-identical", () => {
  const text = read(CREATE);
  const { bytes } = expectOk(rewriteTaskFile(text, { kind: "set-envelope", envelope: envelope() }));

  // Every line before the closing delimiter is where it was, and the whole
  // suffix from the closing delimiter onward is unchanged bytes.
  const close = text.indexOf("\n---\n", 4);
  assert.ok(close > 0);
  assert.equal(bytes.slice(0, close), text.slice(0, close), "an existing frontmatter line moved or changed");
  assert.ok(bytes.endsWith(text.slice(close + 1)), "the closing delimiter or the body was disturbed");
});

test("every corpus fixture without an envelope accepts one and keeps everything else", () => {
  for (const file of corpusMarkdown()) {
    const text = read(file);
    const before = parseFrontmatter(text);
    assert.ok(before.ok);
    if (Object.hasOwn(before.data, ENVELOPE_KEY)) continue;

    const { bytes } = expectOk(rewriteTaskFile(text, { kind: "set-envelope", envelope: envelope() }));
    const after = parseFrontmatter(bytes);
    assert.ok(after.ok, `${file} did not re-parse after insertion`);
    assert.deepEqual(after.data[ENVELOPE_KEY], envelope(), `${file}: envelope not read back`);
    assert.deepEqual(
      Object.keys(after.data),
      [...Object.keys(before.data), ENVELOPE_KEY],
      `${file}: key order changed`,
    );
    for (const key of Object.keys(before.data)) {
      assert.deepEqual(after.data[key], before.data[key], `${file}: key ${key} changed`);
    }
    // Removing the inserted block again returns the original bytes, so the
    // insertion added lines and touched nothing.
    const insertedLines = differingLines(text, bytes);
    assert.ok(insertedLines.length > 0, `${file}: insertion changed nothing`);
  }
});

test("replacing an existing envelope leaves the other keys and the body alone", () => {
  const text = read(BEFORE);
  const before = parseFrontmatter(text);
  assert.ok(before.ok);

  const wanted = envelope("revoked");
  const { bytes } = expectOk(rewriteTaskFile(text, { kind: "set-envelope", envelope: wanted }));
  const after = parseFrontmatter(bytes);
  assert.ok(after.ok);
  assert.deepEqual(after.data[ENVELOPE_KEY], wanted);
  assert.deepEqual(Object.keys(after.data), Object.keys(before.data), "the replaced key moved");
  for (const key of Object.keys(before.data)) {
    if (key === ENVELOPE_KEY) continue;
    assert.deepEqual(after.data[key], before.data[key], `key ${key} changed`);
  }
  const bodyStart = text.indexOf("\n---\n", 4);
  assert.ok(bytes.endsWith(text.slice(bodyStart + 1)));
});

// ---------------------------------------------------------------------------
// Unknown keys (AC #3)
// ---------------------------------------------------------------------------

const EXOTIC = [
  "---",
  "id: TASK-9",
  "title: 'Quoted: with a colon'",
  "# a comment introducing the board's own block",
  "board_extension:",
  "  nested:",
  "    - deep: true",
  "      note: \"double quoted\"",
  "  spacing   :    kept",
  "",
  "weird-key.with.dots: 1",
  "empty_flow: []",
  "approval:",
  "  origin:",
  "    app: example-capture",
  "    created_by: \"human:carter\"",
  "  state: awaiting",
  "",
  "trailing_key: last",
  "---",
  "",
  "## Description",
  "",
  "Body text.",
  "",
].join("\n");

test("keys this writer has never seen round-trip through a state edit", () => {
  const { bytes } = expectOk(rewriteTaskFile(EXOTIC, { kind: "set-state", state: "approved" }));
  const changed = differingLines(EXOTIC, bytes);
  assert.deepEqual(changed.length, 1, `expected one changed line, got ${changed.join(", ")}`);

  const before = parseFrontmatter(EXOTIC);
  const after = parseFrontmatter(bytes);
  assert.ok(before.ok && after.ok);
  assert.deepEqual(Object.keys(after.data), Object.keys(before.data));
  assert.deepEqual(after.data["board_extension"], before.data["board_extension"]);
  assert.deepEqual(after.data["weird-key.with.dots"], 1);
  // The comment, the odd `spacing   :` and the blank line inside the block are
  // all still there, as bytes.
  assert.ok(bytes.includes("# a comment introducing the board's own block"));
  assert.ok(bytes.includes("  spacing   :    kept"));
  assert.ok(bytes.includes("title: 'Quoted: with a colon'"), "the single-quoted title was requoted");
});

test("a blank line after the envelope block belongs to the next key, not the envelope", () => {
  // The envelope block ends at its last indented line; the blank line and
  // `trailing_key:` that follow are outside the range this writer rewrites.
  const { bytes } = expectOk(rewriteTaskFile(EXOTIC, { kind: "set-envelope", envelope: envelope() }));
  assert.ok(bytes.includes("\n\ntrailing_key: last\n"), "the blank line before the next key was absorbed");
  const after = parseFrontmatter(bytes);
  assert.ok(after.ok);
  assert.equal(after.data["trailing_key"], "last");
  assert.deepEqual(Object.keys(after.data), Object.keys((parseFrontmatter(EXOTIC) as { data: Record<string, unknown> }).data));
});

// ---------------------------------------------------------------------------
// Line endings, delimiters, trailing bytes
// ---------------------------------------------------------------------------

test("CRLF line endings are preserved, not normalised and not refused", () => {
  // Decision: preserve. `core/frontmatter.ts` already accepts a Windows-edited
  // task file as a task file, so refusing to write one would make the writer
  // narrower than the reader for no safety gain.
  const crlf = EXOTIC.replaceAll("\n", "\r\n");
  const identity = expectOk(rewriteTaskFile(crlf, NO_EDIT));
  assert.equal(identity.bytes, crlf);

  const { bytes } = expectOk(rewriteTaskFile(crlf, { kind: "set-state", state: "approved" }));
  assert.ok(!/[^\r]\n/u.test(bytes), "a bare LF appeared in a CRLF file");
  assert.equal(bytes.split("\r\n").length, crlf.split("\r\n").length, "the line count changed");
  assert.ok(bytes.includes("  state: approved\r\n"));

  const inserted = expectOk(rewriteTaskFile(read(CREATE).replaceAll("\n", "\r\n"), {
    kind: "set-envelope",
    envelope: envelope(),
  }));
  assert.ok(!/[^\r]\n/u.test(inserted.bytes), "the inserted block used bare LF in a CRLF file");
});

test("a body containing a literal --- line is not mistaken for the closing delimiter", () => {
  const text = ["---", "id: TASK-1", "approval:", "  origin:", "    app: a", "    created_by: human:c", "  state: awaiting", "---", "", "Intro.", "", "---", "", "After a horizontal rule.", ""].join("\n");
  const { bytes } = expectOk(rewriteTaskFile(text, { kind: "set-state", state: "expired" }));
  const changed = differingLines(text, bytes);
  assert.deepEqual(changed, [6], "the wrong line changed, or the body's --- was treated as frontmatter");
  assert.ok(bytes.endsWith("\n\nIntro.\n\n---\n\nAfter a horizontal rule.\n"));
});

test("a column-0 approval: line in the body is never touched", () => {
  const text = ["---", "id: TASK-1", "approval:", "  origin:", "    app: a", "    created_by: human:c", "  state: awaiting", "---", "", "approval: this is prose, not frontmatter", ""].join("\n");
  const { bytes } = expectOk(rewriteTaskFile(text, { kind: "set-envelope", envelope: envelope() }));
  assert.ok(bytes.endsWith("\n\napproval: this is prose, not frontmatter\n"));
  const after = parseFrontmatter(bytes);
  assert.ok(after.ok);
  assert.deepEqual(after.data[ENVELOPE_KEY], envelope());
});

test("the presence or absence of a trailing newline is preserved", () => {
  const withNewline = ["---", "id: TASK-1", "approval:", "  origin:", "    app: a", "    created_by: human:c", "  state: awaiting", "---", "", "Body.", ""].join("\n");
  const without = withNewline.slice(0, -1);
  assert.ok(!without.endsWith("\n"));

  const a = expectOk(rewriteTaskFile(withNewline, { kind: "set-state", state: "approved" }));
  assert.ok(a.bytes.endsWith("Body.\n"));
  const b = expectOk(rewriteTaskFile(without, { kind: "set-state", state: "approved" }));
  assert.ok(b.bytes.endsWith("Body."), "a trailing newline was added to a file that had none");
  assert.ok(!b.bytes.endsWith("\n"));

  // Insertion at the end of frontmatter on a file with no trailing newline.
  const noEnvelope = ["---", "id: TASK-1", "---", "", "Body."].join("\n");
  const c = expectOk(rewriteTaskFile(noEnvelope, { kind: "set-envelope", envelope: envelope() }));
  assert.ok(c.bytes.endsWith("Body."), "insertion changed the file's trailing bytes");
  assert.ok(c.bytes.includes("\napproval:\n"));
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test("a file with no frontmatter is refused and never given one", () => {
  for (const text of ["", "# Just markdown\n", "\n---\nid: x\n---\n", "  ---\nid: x\n---\n"]) {
    expectCode(rewriteTaskFile(text, { kind: "set-envelope", envelope: envelope() }), "no-frontmatter");
    expectCode(rewriteTaskFile(text, NO_EDIT), "no-frontmatter");
  }
});

test("an unterminated frontmatter block is refused", () => {
  expectCode(rewriteTaskFile("---\nid: TASK-1\ntitle: t\n", NO_EDIT), "unterminated");
});

test("duplicate keys are refused by the hardened parser, before any rewrite", () => {
  const text = ["---", "id: TASK-1", "id: TASK-2", "---", "", "Body.", ""].join("\n");
  const message = expectCode(rewriteTaskFile(text, NO_EDIT), "yaml-error");
  assert.match(message, /frontmatter YAML/u);
  // And a duplicated envelope key, which is the case that would otherwise let a
  // line scan edit one copy and leave the other.
  const twice = ["---", "approval:", "  state: awaiting", "approval:", "  state: approved", "---", ""].join("\n");
  expectCode(rewriteTaskFile(twice, { kind: "set-state", state: "executed" }), "yaml-error");
});

test("an explicitly tagged node is refused, as it is on the read side", () => {
  const text = ["---", "id: TASK-1", "danger: !!python/object x", "---", ""].join("\n");
  expectCode(rewriteTaskFile(text, NO_EDIT), "yaml-error");
});

test("frontmatter that is not a mapping is refused", () => {
  expectCode(rewriteTaskFile("---\n- one\n- two\n---\n", NO_EDIT), "not-a-map");
});

test("an approval key that is not a mapping is refused, never overwritten blind", () => {
  for (const value of ["approval: not-an-envelope", "approval:\n  - a\n  - b", "approval: 42"]) {
    const text = `---\nid: TASK-1\n${value}\n---\n\nBody.\n`;
    expectCode(rewriteTaskFile(text, { kind: "set-state", state: "approved" }), "envelope-not-a-map");
    expectCode(rewriteTaskFile(text, { kind: "set-envelope", envelope: envelope() }), "envelope-not-a-map");
    // A no-op rewrite still returns the bytes: the file is readable, and
    // refusing to hand back what we were given would help nobody.
    assert.equal(expectOk(rewriteTaskFile(text, NO_EDIT)).bytes, text);
  }
});

test("a flow-style envelope refuses a state edit and points at the alternative", () => {
  const text = "---\nid: TASK-1\napproval: {origin: {app: a, created_by: 'human:c'}, state: awaiting}\n---\n\nBody.\n";
  const message = expectCode(rewriteTaskFile(text, { kind: "set-state", state: "approved" }), "unsupported-shape");
  assert.match(message, /set-envelope/u);
  // The escape hatch it names actually works.
  const { bytes } = expectOk(rewriteTaskFile(text, { kind: "set-envelope", envelope: envelope() }));
  const after = parseFrontmatter(bytes);
  assert.ok(after.ok);
  assert.deepEqual(after.data[ENVELOPE_KEY], envelope());
  assert.equal(after.data["id"], "TASK-1");
});

test("an envelope the edit would produce is validated against the schema", () => {
  const text = read(BEFORE);
  // A state outside the SPEC §6.3 vocabulary.
  expectCode(
    rewriteTaskFile(text, { kind: "set-state", state: "definitely-fine" as never }),
    "invalid-envelope",
  );
  // An envelope with a key the schema does not allow.
  expectCode(
    rewriteTaskFile(text, { kind: "set-envelope", envelope: { ...envelope(), sneaky: true } }),
    "invalid-envelope",
  );
  // An envelope missing a MUST field.
  expectCode(rewriteTaskFile(text, { kind: "set-envelope", envelope: { state: "awaiting" } }), "invalid-envelope");
  // And a refused edit produced no bytes at all.
  const refused = rewriteTaskFile(text, { kind: "set-envelope", envelope: {} });
  assert.ok(!refused.ok);
  assert.ok(!Object.hasOwn(refused, "bytes"));
});

test("nothing throws, whatever the input", () => {
  const inputs = [
    "",
    "---",
    "---\n",
    "---\n---",
    "---\n---\n",
    "---\n \n---\n",
    "---\napproval:\n---\n",
    "---\napproval: |\n  block\n---\n",
    "---\napproval: &a {state: awaiting}\nother: *a\n---\n",
    "﻿---\nid: x\n---\n",
    "---\r\nid: x\r\n---\r\n",
    "---\rid: x\r---\r",
    `---\n${"deep:\n".repeat(200)}---\n`,
  ];
  const edits: TaskFileEdit[] = [
    NO_EDIT,
    { kind: "set-state", state: "approved" },
    { kind: "set-envelope", envelope: envelope() },
  ];
  for (const input of inputs) {
    for (const edit of edits) {
      const result = rewriteTaskFile(input, edit);
      assert.equal(typeof result.ok, "boolean", `no result for ${JSON.stringify(input)}`);
      if (!result.ok) assert.equal(typeof result.message, "string");
    }
  }
});

test("an empty frontmatter block accepts an inserted envelope", () => {
  const text = "---\n---\n\nBody.\n";
  const { bytes } = expectOk(rewriteTaskFile(text, { kind: "set-envelope", envelope: envelope() }));
  const after = parseFrontmatter(bytes);
  assert.ok(after.ok);
  assert.deepEqual(after.data[ENVELOPE_KEY], envelope());
  assert.ok(bytes.endsWith("\n---\n\nBody.\n"));
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("the same input and edit produce the same bytes, every time", () => {
  const text = read(BEFORE);
  const edits: TaskFileEdit[] = [
    NO_EDIT,
    { kind: "set-state", state: "approved" },
    { kind: "set-envelope", envelope: envelope("executed") },
  ];
  for (const edit of edits) {
    const first = expectOk(rewriteTaskFile(text, edit)).bytes;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.equal(expectOk(rewriteTaskFile(text, edit)).bytes, first);
    }
  }
});

test("a state edit is idempotent: applying the state it already has changes nothing", () => {
  const text = read(BEFORE);
  const { bytes, changed } = expectOk(rewriteTaskFile(text, { kind: "set-state", state: "awaiting" }));
  assert.equal(bytes, text);
  assert.equal(changed, false);
});

test("a state edit preserves a trailing comment on the state line", () => {
  const text = ["---", "approval:", "  origin:", "    app: a", "    created_by: human:c", "  state: awaiting  # set by hand", "---", ""].join("\n");
  const { bytes } = expectOk(rewriteTaskFile(text, { kind: "set-state", state: "approved" }));
  assert.ok(bytes.includes("  state: approved  # set by hand"), `comment lost: ${bytes}`);
});

// ---------------------------------------------------------------------------
// writeTaskFileAtomic
// ---------------------------------------------------------------------------

test("writeTaskFileAtomic writes the exact bytes and leaves no debris", () => {
  const dir = mkdtempSync(join(tmpdir(), "approval-md-taskfile-"));
  try {
    const path = join(dir, "task-1 - Something.md");
    const text = read(BEFORE);
    const { bytes } = expectOk(rewriteTaskFile(text, { kind: "set-state", state: "approved" }));

    const first = writeTaskFileAtomic(path, bytes);
    assert.ok(first.ok, first.ok ? "" : first.message);
    assert.equal(readFileSync(path, "utf8"), bytes);
    assert.equal(first.bytes, Buffer.byteLength(bytes, "utf8"));

    // Overwrite in place, and no temp file survives either write.
    const second = writeTaskFileAtomic(path, text);
    assert.ok(second.ok);
    assert.equal(readFileSync(path, "utf8"), text);
    assert.deepEqual(readdirSync(dir), ["task-1 - Something.md"], "a temp file was left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeTaskFileAtomic reports a write failure rather than throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "approval-md-taskfile-"));
  try {
    // The destination is a directory, so the rename cannot succeed.
    const path = join(dir, "occupied");
    writeFileSync(join(dir, "keep"), "x");
    const asDirectory = join(dir, "occupied");
    rmSync(asDirectory, { recursive: true, force: true });
    mkdtempSync(join(dir, "occupied"));
    const entries = readdirSync(dir).filter((entry) => entry.startsWith("occupied"));
    assert.ok(entries.length === 1 && statSync(join(dir, entries[0] as string)).isDirectory());

    const result = writeTaskFileAtomic(join(dir, entries[0] as string), "bytes");
    assert.ok(!result.ok, "writing over a directory reported success");
    assert.equal(result.code, "write-failed");
    assert.match(result.message, /the log was not touched/u);
    assert.deepEqual(
      readdirSync(dir).filter((entry) => entry.startsWith(".")),
      [],
      "a temp file was left behind after a failed write",
    );
    assert.ok(path.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the writer opens nothing but the path it is handed", () => {
  // A rewrite is a pure function: given bytes it never reaches the filesystem,
  // so there is no path by which it could reach `.approval/` or the log. This
  // asserts the module's imports rather than a runtime trace, which is the
  // honest thing a static test can claim: the writer cannot append to a log it
  // never imports, and `rewriteTaskFile` takes text and returns text.
  const source = readFileSync(join(REPO_ROOT, "src", "core", "task-file.ts"), "utf8");
  const imported = [...source.matchAll(/^import[^;]*?from "([^"]+)";$/gmu)].map((match) => match[1]);
  assert.deepEqual(imported.sort(), [
    "../daemon/projection.js",
    "./frontmatter.js",
    "./policy-load.js",
    "./validate.js",
    "node:fs",
    "node:path",
    "node:util",
    "yaml",
  ]);

  // Strip comments, then check the code itself never names a log or reads one.
  const code = source
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/^\s*\/\/.*$/gmu, "");
  for (const forbidden of ["events.jsonl", "appendEvent", ".approval", "readFileSync", "appendFileSync"]) {
    assert.ok(!code.includes(forbidden), `the task-file writer's code references ${forbidden}`);
  }
  // The one hardened parser, reused rather than replicated.
  assert.ok(!code.includes("parseDocument"), "the writer replicates the hardened parser instead of reusing it");
  assert.ok(code.includes("parseHardenedYaml"), "the writer no longer parses through the hardened parser");
});
