/**
 * The values reader (APRV-238) — SPEC.md §5.3.
 *
 * Markdown fixtures live in `schema/fixtures/values-md/`, deliberately outside
 * the APRV-2 fixture auto-discovery: `tests/fixtures.test.ts` enumerates
 * `listSchemaNames()` and reads only `*.json`, so a directory of markdown is
 * never picked up by it. `schema/fixtures/values/` holds the JSON fixtures for
 * `values.schema.json` itself; this directory holds whole APPROVAL.md files.
 *
 * Every fixture here carries the SAME policy block, byte for byte, and differs
 * only in its values block. That is what makes the deep-equality assertions
 * below mean something: the policy load is handed four files whose policy
 * halves are identical and whose values halves are absent, valid, malformed and
 * duplicated, and it must answer identically to all four.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadPolicy, loadPolicyText } from "../src/core/policy-load.js";
import { DEFAULT_SCHEMA_DIR } from "../src/core/validate.js";
import {
  VALUES_INFO_STRING,
  loadValues,
  loadValuesText,
  type ValuesLoadResult,
} from "../src/core/values.js";

const FIXTURES = join(DEFAULT_SCHEMA_DIR, "fixtures", "values-md");

const scratch = mkdtempSync(join(tmpdir(), "approval-md-values-"));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fixturePath(...segments: string[]): string {
  return join(FIXTURES, ...segments);
}

function loadFixture(...segments: string[]): ValuesLoadResult {
  return loadValues({ file: fixturePath(...segments) });
}

function expectPresent(
  result: ValuesLoadResult,
): Extract<ValuesLoadResult, { ok: true; present: true }> {
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.present, true, "expected a values block to be present");
  if (!result.present) throw new Error("unreachable");
  return result;
}

function expectFail(
  result: ValuesLoadResult,
  code: string,
): Extract<ValuesLoadResult, { ok: false }> {
  assert.equal(result.ok, false, "expected an unreadable-block result");
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.code, code, `message was: ${result.message}`);
  assert.ok(result.message.length > 0, "a failure must carry a reason");
  return result;
}

function tempFile(name: string, contents: string): string {
  const path = join(scratch, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

/** A whole APPROVAL.md: the canonical policy block plus whatever tail is given. */
function policyPlus(tail: string): string {
  return `${readFileSync(
    join(DEFAULT_SCHEMA_DIR, "fixtures", "policy-md", "valid", "canonical.md"),
    "utf8",
  )}\n${tail}`;
}

// ---------------------------------------------------------------------------
// The three states
// ---------------------------------------------------------------------------

test("a file with a values block loads it (SPEC.md §5.3)", () => {
  const result = expectPresent(loadFixture("valid", "with-values.md"));
  assert.equal(result.values.version, 1);
  assert.deepEqual(result.values.love, [
    "seeing the real change, not a description of it",
    "a runbook I can paste into a terminal",
  ]);
  assert.deepEqual(result.values.like, [
    "success reported first, caveats after",
    "small reviewable commits",
  ]);
  assert.deepEqual(result.values.dislike, [
    "prose where a command would do",
    "being asked to approve something I cannot see",
  ]);
  assert.deepEqual(result.values.wants, [
    "honest opinions on the work, including when you think a task is wrong",
    "a journal entry of about five points per milestone",
  ]);
  assert.match(result.values.responds ?? "", /within the hour on the phone/u);
  assert.equal(result.source.filename, "with-values.md");
});

test("a file with no values block is present:false, not a failure", () => {
  const result = loadFixture("valid", "absent.md");
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.present, false);
  assert.equal(result.source.filename, "absent.md");
  // The absence carries no `values` key at all: a caller cannot reach for one
  // and get an empty object it might then treat as "declared nothing".
  assert.deepEqual(Object.keys(result).sort(), ["ok", "present", "source"]);
});

test("a values block on a file that does not exist is file-missing", () => {
  const result = expectFail(loadValues({ file: join(scratch, "nowhere.md") }), "file-missing");
  assert.match(result.message, /could not be read/u);
});

test("discovery follows the policy filename precedence", () => {
  const dir = mkdtempSync(join(scratch, "discovery-"));
  writeFileSync(
    join(dir, "APPROVALS.md"),
    policyPlus("```yaml approval-values\nversion: 1\nlike: [from-approvals-md]\n```\n"),
    "utf8",
  );
  const fallback = expectPresent(loadValues({ dir }));
  assert.equal(fallback.source.filename, "APPROVALS.md");
  assert.deepEqual(fallback.values.like, ["from-approvals-md"]);

  writeFileSync(
    join(dir, "APPROVAL.md"),
    policyPlus("```yaml approval-values\nversion: 1\nlike: [from-approval-md]\n```\n"),
    "utf8",
  );
  const preferred = expectPresent(loadValues({ dir }));
  assert.equal(preferred.source.filename, "APPROVAL.md");
  assert.deepEqual(preferred.values.like, ["from-approval-md"]);
});

test("an empty directory is file-missing and names both filenames", () => {
  const dir = mkdtempSync(join(scratch, "empty-"));
  const result = expectFail(loadValues({ dir }), "file-missing");
  assert.match(result.message, /APPROVAL\.md, APPROVALS\.md/u);
});

// ---------------------------------------------------------------------------
// Every failure code
// ---------------------------------------------------------------------------

test("two values blocks fail multiple-blocks", () => {
  const result = expectFail(loadFixture("invalid", "two-blocks.md"), "multiple-blocks");
  assert.match(result.message, /found 2/u);
  assert.equal(result.source?.filename, "two-blocks.md");
});

test("an unterminated values fence fails unterminated-fence", () => {
  const result = expectFail(loadFixture("invalid", "unterminated.md"), "unterminated-fence");
  assert.match(result.message, /no closing fence/u);
});

test("a values block that is not YAML fails yaml-error", () => {
  expectFail(loadFixture("invalid", "yaml-error.md"), "yaml-error");
});

test("a values block the schema refuses fails schema-invalid, with errors", () => {
  const result = expectFail(loadFixture("invalid", "schema-invalid.md"), "schema-invalid");
  assert.ok((result.errors ?? []).length > 0, "a schema failure must carry its errors");
});

test("loadValues never throws for any fixture", () => {
  for (const name of ["two-blocks.md", "unterminated.md", "yaml-error.md", "schema-invalid.md"]) {
    assert.doesNotThrow(() => loadFixture("invalid", name), `${name} threw`);
  }
  for (const name of ["with-values.md", "absent.md"]) {
    assert.doesNotThrow(() => loadFixture("valid", name), `${name} threw`);
  }
});

// ---------------------------------------------------------------------------
// The hardened YAML stance is the policy loader's, because it is one parser
// ---------------------------------------------------------------------------

test("the values block is parsed under the same hardened YAML rules as the policy", () => {
  // An explicit tag. Tag-driven coercion must never reach the schema validator.
  expectFail(
    loadValuesText("tagged.md", "```yaml approval-values\nversion: !!int 1\n```\n"),
    "yaml-error",
  );

  // A duplicate mapping key is a parse error, not last-one-wins.
  expectFail(
    loadValuesText(
      "duplicate.md",
      "```yaml approval-values\nversion: 1\nlike: [a]\nlike: [b]\n```\n",
    ),
    "yaml-error",
  );

  // YAML 1.2 core, so 1.1-isms are not honoured: `no` is the string "no" and
  // never the boolean `false`. Which dialect a reader happens to ship must not
  // decide what a human's sentence says.
  const yaml11 = expectPresent(
    loadValuesText("yaml11.md", "```yaml approval-values\nversion: 1\nresponds: no\n```\n"),
  );
  assert.equal(yaml11.values.responds, "no");

  // And a real boolean stays a boolean, which the closed schema refuses rather
  // than coercing into a list entry.
  expectFail(
    loadValuesText("bool.md", "```yaml approval-values\nversion: 1\nlove: [true]\n```\n"),
    "schema-invalid",
  );

  // An alias bomb is bounded rather than expanded.
  const bomb = [
    "```yaml approval-values",
    "version: 1",
    "a: &a [x, x, x, x, x, x, x, x, x]",
    "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]",
    "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]",
    "d: [*c, *c, *c, *c, *c, *c, *c, *c, *c]",
    "```",
    "",
  ].join("\n");
  expectFail(loadValuesText("bomb.md", bomb), "yaml-error");
});

test("the block is found by its info string, not by looking like yaml", () => {
  // A fenced block with the wrong info string is not a values block, and prose
  // that merely reads like one is not a block at all.
  const notABlock = [
    "```yaml",
    "version: 1",
    "like: [wrong info string]",
    "```",
    "",
    "version: 1 — this line is prose and is ignored.",
    "",
  ].join("\n");
  const result = loadValuesText("prose.md", notABlock);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.present, false);

  // Whitespace in the info string is normalised, so this IS the block.
  const spaced = expectPresent(
    loadValuesText("spaced.md", "```  yaml   approval-values  \nversion: 1\n```\n"),
  );
  assert.equal(spaced.values.version, 1);

  // …and the constant is the string the fixtures and the guard test use.
  assert.equal(VALUES_INFO_STRING, "yaml approval-values");
});

// ---------------------------------------------------------------------------
// The policy is unmoved by any of it (SPEC.md §11.1 invariant 10)
// ---------------------------------------------------------------------------

/** The four whole-file variants: same policy block, four different values halves. */
const VARIANTS: readonly { readonly label: string; readonly path: string }[] = [
  { label: "absent", path: fixturePath("valid", "absent.md") },
  { label: "valid", path: fixturePath("valid", "with-values.md") },
  { label: "malformed", path: fixturePath("invalid", "yaml-error.md") },
  { label: "duplicated", path: fixturePath("invalid", "two-blocks.md") },
];

test("loadPolicyText is deep-equal across all four values-block variants", () => {
  // One path for all four, so `source.path` is identical and the comparison is
  // over the whole result rather than over a subset somebody chose.
  const results = VARIANTS.map((variant) => ({
    label: variant.label,
    result: loadPolicyText("APPROVAL.md", readFileSync(variant.path, "utf8")),
  }));
  const baseline = results[0];
  assert.ok(baseline !== undefined);
  for (const entry of results.slice(1)) {
    assert.deepEqual(
      entry.result,
      baseline.result,
      `the policy load differs between the "${baseline.label}" and "${entry.label}" values blocks. A values block is guidance; it may not move the policy by any route (SPEC.md §11.1 invariant 10).`,
    );
  }
  // A guard on the guard: the shared baseline has to be a policy that LOADED,
  // or four identical fail-closed results would pass this trivially.
  assert.equal(baseline.result.ok, true);
});

test("loadPolicy is deep-equal across the variants, modulo the path it read", () => {
  const dir = mkdtempSync(join(scratch, "policy-equal-"));
  const seen: unknown[] = [];
  for (const variant of VARIANTS) {
    writeFileSync(join(dir, "APPROVAL.md"), readFileSync(variant.path, "utf8"), "utf8");
    seen.push(loadPolicy({ dir }));
  }
  for (const entry of seen.slice(1)) {
    assert.deepEqual(entry, seen[0], "the policy load moved with the values block");
  }
});

test("a values failure is not a policy failure, and the reverse", () => {
  // A file whose values block is broken and whose policy block is fine.
  const brokenValues = tempFile(
    "broken-values.md",
    readFileSync(fixturePath("invalid", "yaml-error.md"), "utf8"),
  );
  assert.equal(loadPolicy({ file: brokenValues }).ok, true);
  expectFail(loadValues({ file: brokenValues }), "yaml-error");

  // …and the mirror: a policy block that fails to load, beside a values block
  // that reads perfectly. The values reader answers on its own terms.
  const brokenPolicy = tempFile(
    "broken-policy.md",
    "```yaml approval-policy\nversion: [not, a, string]\n```\n\n```yaml approval-values\nversion: 1\nlike: [still readable]\n```\n",
  );
  assert.equal(loadPolicy({ file: brokenPolicy }).ok, false);
  const values = expectPresent(loadValues({ file: brokenPolicy }));
  assert.deepEqual(values.values.like, ["still readable"]);
});

test("loadValuesText and loadValues agree on the same bytes", () => {
  for (const variant of VARIANTS) {
    const text = readFileSync(variant.path, "utf8");
    assert.deepEqual(
      loadValuesText(variant.path, text),
      loadValues({ file: variant.path }),
      `${variant.label}: the bytes-in form must answer exactly as the discovery form does`,
    );
  }
});
