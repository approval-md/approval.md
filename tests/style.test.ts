/**
 * The presentation layer (APRV-91 #6/#11, APRV-93 #1).
 *
 * Two properties carry the whole design, and both are asserted here rather than
 * left to the verbs:
 *
 *   1. THE ENABLE MATRIX. Colour appears only under a terminal, and `--json`
 *      vetoes it absolutely. Everything downstream trusts this, so it is tested
 *      as a truth table rather than sampled.
 *   2. LOSSLESS DEGRADATION. The plain rendering is the coloured rendering with
 *      the escapes removed — never a different layout, never different words.
 *      That is what makes the piped bytes (which every other test pins) a
 *      faithful account of what the operator sees.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  makeStyle,
  relPath,
  resetStyle,
  shortHash,
  style,
  type Glyph,
  type Role,
} from "../src/cli/style.js";

/** Every escape sequence this module can emit. */
// oxlint-disable-next-line no-control-regex -- detecting ANSI IS the point
const ESCAPES = /\u001b\[[0-9;]*m/gu;

const strip = (text: string): string => text.replace(ESCAPES, "");
// oxlint-disable-next-line no-control-regex -- detecting ANSI IS the point
const hasEscape = (text: string): boolean => /\u001b/u.test(text);

/** A style with colour forced on, as the tests for coloured output want it. */
const coloured = makeStyle({ tty: true, env: { LANG: "en_US.UTF-8" } });
/** The same style with colour off: what a pipe gets. */
const plain = makeStyle({ tty: false, env: { LANG: "en_US.UTF-8" } });

const ROLES: Role[] = ["brand", "ok", "warn", "fail", "key", "value", "muted", "rule", "secret"];
const GLYPH_NAMES: Glyph[] = ["ok", "fail", "skip", "point", "bar", "rule"];

// ---------------------------------------------------------------------------
// 1. The enable matrix
// ---------------------------------------------------------------------------

test("colour is enabled only by the documented combination", () => {
  const cases: Array<[string, Parameters<typeof makeStyle>[0], boolean]> = [
    ["a bare TTY", { tty: true, env: {} }, true],
    ["a pipe", { tty: false, env: {} }, false],
    ["NO_COLOR on a TTY", { tty: true, env: { NO_COLOR: "1" } }, false],
    // The NO_COLOR convention: present AND non-empty. An empty value is not a
    // request for monochrome, it is an unset variable spelled badly.
    ["NO_COLOR empty on a TTY", { tty: true, env: { NO_COLOR: "" } }, true],
    ["TERM=dumb on a TTY", { tty: true, env: { TERM: "dumb" } }, false],
    ["--no-color on a TTY", { tty: true, env: {}, noColor: true }, false],
    ["FORCE_COLOR in a pipe", { tty: false, env: { FORCE_COLOR: "1" } }, true],
    ["FORCE_COLOR beats NO_COLOR", { tty: false, env: { FORCE_COLOR: "1", NO_COLOR: "1" } }, true],
    ["FORCE_COLOR beats TERM=dumb", { tty: false, env: { FORCE_COLOR: "1", TERM: "dumb" } }, true],
    // --no-color is the operator's explicit word and outranks the escape hatch.
    ["--no-color beats FORCE_COLOR", { tty: true, env: { FORCE_COLOR: "1" }, noColor: true }, false],
  ];
  for (const [label, input, expected] of cases) {
    assert.equal(makeStyle(input).enabled, expected, `${label} should be ${expected}`);
  }
});

test("--json vetoes colour under every environment", () => {
  // The frozen shapes are the reason this is a separate test: there must be no
  // combination of flags and variables that puts a byte of ANSI in a JSON
  // stream, so the veto is asserted against the whole matrix, not one case.
  for (const env of [
    {},
    { FORCE_COLOR: "1" },
    { FORCE_COLOR: "1", TERM: "xterm-256color" },
    { TERM: "xterm-256color" },
  ]) {
    for (const tty of [true, false]) {
      const s = makeStyle({ tty, env, json: true });
      assert.equal(s.enabled, false, `json + ${JSON.stringify(env)} + tty=${tty} emitted colour`);
      assert.equal(hasEscape(s.fail("nope")), false);
    }
  }
});

test("the process-wide style is decided once", () => {
  resetStyle();
  const first = style({ tty: true, env: { FORCE_COLOR: "1" } });
  assert.equal(first.enabled, true);
  // A later caller asking for something else gets the first answer, which is
  // the point: one invocation renders one way from start to finish.
  assert.equal(style({ tty: false, env: { NO_COLOR: "1" } }), first);
  resetStyle();
  assert.notEqual(style({ tty: false, env: {} }), first);
  resetStyle();
});

// ---------------------------------------------------------------------------
// 2. Painting, and what is never painted
// ---------------------------------------------------------------------------

test("every role is a no-op when colour is off", () => {
  for (const role of ROLES) {
    assert.equal(plain.paint(role, "sample"), "sample", `${role} painted in a pipe`);
  }
});

test("every role but value emits an escape when colour is on", () => {
  for (const role of ROLES) {
    const painted = coloured.paint(role, "sample");
    assert.equal(strip(painted), "sample", `${role} altered the text it wrapped`);
    if (role === "value") {
      assert.equal(painted, "sample", "the value role must never dress its text");
    } else {
      assert.ok(hasEscape(painted), `${role} emitted no escape on a TTY`);
      assert.ok(painted.endsWith(`${"\u001b"}[0m`), `${role} left the terminal in its colour`);
    }
  }
});

test("a value is never coloured, on any style", () => {
  // Rule 3 of the design: a hash, a token or a command must survive a
  // triple-click as clean bytes. `value()` is the call site's way of saying so.
  const token = "729a25b06567ccc0aed356f3423e39bf12b6252056b7890acde455603010fb11";
  assert.equal(coloured.value(token), token);
  assert.equal(plain.value(token), token);
});

test("painting empty text emits nothing", () => {
  // Otherwise a table's empty cell becomes four invisible bytes that widen no
  // column but do defeat a `=== ""` check downstream.
  for (const role of ROLES) assert.equal(coloured.paint(role, ""), "");
});

// ---------------------------------------------------------------------------
// 3. Glyphs
// ---------------------------------------------------------------------------

test("glyphs keep their UTF-8 spelling unless the locale says otherwise", () => {
  assert.equal(coloured.ascii, false);
  assert.equal(strip(coloured.glyph("ok")), "✓");
  assert.equal(strip(coloured.glyph("fail")), "✗");
  assert.equal(strip(coloured.glyph("skip")), "–");

  // An UNSET locale is treated as capable, which is what keeps the glyph column
  // byte-stable for the rest of the suite and for `env -i`.
  assert.equal(makeStyle({ tty: false, env: {} }).rawGlyph("ok"), "✓");
});

test("glyphs degrade to ASCII when asked or when the locale is not UTF-8", () => {
  for (const env of [{ APPROVAL_ASCII: "1" }, { LANG: "C" }, { LC_ALL: "POSIX", LANG: "en_US.UTF-8" }]) {
    const s = makeStyle({ tty: false, env });
    assert.equal(s.ascii, true, `${JSON.stringify(env)} should be ASCII`);
    assert.equal(s.rawGlyph("ok"), "[ok]");
    assert.equal(s.rawGlyph("fail"), "[x]");
    assert.equal(s.rawGlyph("skip"), "[-]");
  }
});

test("every glyph has both spellings and a colour that carries no meaning alone", () => {
  const ascii = makeStyle({ tty: true, env: { APPROVAL_ASCII: "1" } });
  for (const name of GLYPH_NAMES) {
    assert.ok(coloured.rawGlyph(name).length > 0, `${name} has no UTF-8 spelling`);
    assert.ok(ascii.rawGlyph(name).length > 0, `${name} has no ASCII spelling`);
    // The glyph itself is the redundant carrier: strip the colour and the
    // distinction survives.
    assert.equal(strip(coloured.glyph(name)), coloured.rawGlyph(name));
  }
});

// ---------------------------------------------------------------------------
// 4. Headings, rules and tables
// ---------------------------------------------------------------------------

test("a heading is the bare word in a pipe", () => {
  assert.equal(plain.heading("Changes"), "Changes");
  assert.equal(strip(coloured.heading("Changes")), "Changes");
  assert.ok(hasEscape(coloured.heading("Changes")));
});

test("a rule is one repeated glyph and nothing else", () => {
  assert.equal(plain.rule(5), "─────");
  assert.equal(makeStyle({ tty: false, env: { APPROVAL_ASCII: "1" } }).rule(5), "-----");
  assert.equal(strip(coloured.rule(5)), "─────");
});

test("a table aligns on the undressed width, so colour cannot skew it", () => {
  const rows = [
    { left: "policy", right: "APPROVAL.md" },
    { left: "attestation", right: "current" },
    { left: "x", right: "y" },
  ];
  const flat = plain.table(rows);
  assert.equal(
    flat,
    ["policy       APPROVAL.md", "attestation  current", "x            y"].join("\n"),
  );
  // The identical layout must come back out of the coloured render: if padding
  // were computed after painting, every column would be off by the escape
  // length and the table would only line up in a pipe.
  assert.equal(strip(coloured.table(rows)), flat);
});

test("a glyph column is aligned and the detail column follows it", () => {
  const rows = [
    { left: "build", right: "fresh", glyph: "ok" as const },
    { left: "identity", right: "not declared", glyph: "fail" as const, fix: undefined },
  ];
  assert.equal(
    plain.table(rows),
    ["✓ build     fresh", "✗ identity  not declared"].join("\n"),
  );
  // ASCII spellings are wider, and the column widens with them rather than
  // ragging the labels.
  assert.equal(
    makeStyle({ tty: false, env: { APPROVAL_ASCII: "1" } }).table(rows),
    ["[ok] build     fresh", "[x]  identity  not declared"].join("\n"),
  );
});

test("under-rows hang beneath their row", () => {
  const rendered = plain.table(
    [{ left: "identity", right: "not declared", glyph: "fail", under: ["fix: approval setup identity"] }],
    {},
  );
  assert.equal(
    rendered,
    ["✗ identity  not declared", "    fix: approval setup identity"].join("\n"),
  );
});

test("a row with no right cell prints no trailing whitespace", () => {
  // Trailing spaces are invisible in review and very visible in a diff of a
  // pinned transcript, so the table trims every line it emits.
  const rendered = plain.table([{ left: "alone" }, { left: "pair", right: "value" }]);
  for (const line of rendered.split("\n")) assert.equal(line, line.trimEnd());
});

test("plainLeft keeps a copyable left cell undressed", () => {
  const rendered = coloured.table([{ left: "a1b2c3d4e5f6", right: "the digest", plainLeft: true }]);
  assert.equal(hasEscape(rendered), false, "a plainLeft row painted the value anyway");
});

// ---------------------------------------------------------------------------
// 5. Short hashes and relative paths
// ---------------------------------------------------------------------------

test("a digest is shortened to twelve characters for a human", () => {
  const digest = "729a25b06567ccc0aed356f3423e39bf12b6252056b7890acde455603010fb11";
  assert.equal(shortHash(digest), "729a25b06567");
  assert.equal(shortHash(digest).length, 12);
  assert.equal(shortHash(digest.toUpperCase()), digest.toUpperCase().slice(0, 12));
});

test("anything that is not a digest passes through untouched", () => {
  // Applied to a field that may be absent, already short, or a sentence, this
  // has to be the identity rather than a truncation.
  for (const value of ["", "-", "none", "task-042:chaser", "abc123", "z".repeat(64)]) {
    assert.equal(shortHash(value), value);
  }
});

test("a path inside the working directory is printed the way it would be typed", () => {
  assert.equal(relPath("/repo/APPROVAL.md", "/repo"), "APPROVAL.md");
  assert.equal(relPath("/repo/.approval/log/events.jsonl", "/repo"), ".approval/log/events.jsonl");
  assert.equal(relPath("/repo/", "/repo"), "");
  assert.equal(relPath("/repo", "/repo"), ".");
  // A trailing slash on the cwd must not eat the first character of the result.
  assert.equal(relPath("/repo/APPROVAL.md", "/repo/"), "APPROVAL.md");
});

test("a path outside the working directory stays absolute", () => {
  // `../../../etc/approval/APPROVAL.md` would be shorter and worse: the point
  // of the relative form is recognition, and a path outside the tree is only
  // recognisable in full.
  assert.equal(relPath("/etc/approval/APPROVAL.md", "/repo"), "/etc/approval/APPROVAL.md");
  assert.equal(relPath("/repo-other/APPROVAL.md", "/repo"), "/repo-other/APPROVAL.md");
  assert.equal(relPath("/repo/x", ""), "/repo/x");
});
