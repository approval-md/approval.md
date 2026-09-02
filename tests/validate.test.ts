/**
 * Harness tests for the write-boundary validator (APRV-2 AC #1-#4, #6, #7).
 *
 * The schema directory is injectable, so fail-closed paths (missing dir,
 * corrupt schema file, uncompilable schema) are exercised against throwaway
 * directories instead of the repo's real `schema/`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { DEFAULT_SCHEMA_DIR, listSchemaNames, validate } from "../src/core/validate.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-validate-"));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Write a schema-shaped file into a fresh subdirectory and return its path. */
function schemaDirWith(name: string, files: Record<string, string>): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, contents] of Object.entries(files)) {
    writeFileSync(join(dir, file), contents, "utf8");
  }
  return dir;
}

const GOOD_RECORD = { id: "rec_0001", ts: "2026-08-04T21:45:00Z" };

test("a well-formed document validates against the sample schema", () => {
  assert.deepEqual(validate("sample-record", GOOD_RECORD), { ok: true });
});

test("the sample schema is reachable by its $id as well as its file name", () => {
  assert.deepEqual(
    validate("https://approval.md/schema/sample-record.schema.json", GOOD_RECORD),
    { ok: true },
  );
});

test("listSchemaNames discovers the sample schema in the repo schema dir", () => {
  const names = listSchemaNames();
  assert.ok(
    names.includes("sample-record"),
    `expected sample-record among ${JSON.stringify(names)} (dir ${DEFAULT_SCHEMA_DIR})`,
  );
  assert.deepEqual(names, [...names].sort(), "schema discovery order must be stable");
});

test("an unknown schema id fails closed", () => {
  const result = validate("no-such-schema", GOOD_RECORD);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errors[0]?.keyword, "unknownSchema");
    assert.match(result.errors[0]?.message ?? "", /unknown schema id/);
  }
});

test("a missing schema directory fails closed", () => {
  const result = validate("sample-record", GOOD_RECORD, {
    schemaDir: join(scratch, "does-not-exist"),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errors[0]?.keyword, "schemaDir");
  }
});

test("a corrupt (unparseable) schema file fails closed", () => {
  const dir = schemaDirWith("corrupt", {
    "broken.schema.json": "{ this is not json",
  });
  const result = validate("broken", GOOD_RECORD, { schemaDir: dir });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errors[0]?.keyword, "schemaParse");
    assert.match(result.errors[0]?.message ?? "", /not valid JSON/);
  }
});

test("a non-object schema file fails closed", () => {
  const dir = schemaDirWith("non-object", {
    "listy.schema.json": "[1, 2, 3]",
  });
  const result = validate("listy", GOOD_RECORD, { schemaDir: dir });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errors[0]?.keyword, "schemaParse");
  }
});

test("a schema that cannot be compiled fails closed", () => {
  // `type: "nonsense"` is not a JSON Schema type: Ajv rejects it at compile
  // time, and the harness must surface that as a validation failure.
  const dir = schemaDirWith("uncompilable", {
    "bad.schema.json": JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://approval.md/schema/test/bad.schema.json",
      type: "nonsense",
    }),
  });
  const result = validate("bad", GOOD_RECORD, { schemaDir: dir });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errors[0]?.keyword, "schemaCompile");
  }
});

test("one corrupt sibling schema fails the whole load, never a partial pass", () => {
  const dir = schemaDirWith("sibling", {
    "ok.schema.json": JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://approval.md/schema/test/ok.schema.json",
      type: "object",
    }),
    "rotten.schema.json": "}{",
  });
  const result = validate("ok", GOOD_RECORD, { schemaDir: dir });
  assert.equal(result.ok, false);
});

test("an unknown extra top-level field is rejected (fail-closed config)", () => {
  const result = validate("sample-record", {
    ...GOOD_RECORD,
    unexpected: "surprise",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some((error) => error.keyword === "additionalProperties"),
      `expected an additionalProperties error, got ${JSON.stringify(result.errors)}`,
    );
  }
});

test("a syntactically invalid date-time is rejected (formats are enforced)", () => {
  const result = validate("sample-record", {
    id: "rec_0001",
    ts: "not-a-timestamp",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some(
        (error) => error.keyword === "format" && error.path === "/ts",
      ),
      `expected a format error at /ts, got ${JSON.stringify(result.errors)}`,
    );
  }
});

test("a missing required field is rejected with a machine-readable reason", () => {
  const result = validate("sample-record", { ts: "2026-08-04T21:45:00Z" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((error) => error.keyword === "required"));
  }
});

test("allErrors reports every failure, not just the first", () => {
  const result = validate("sample-record", { id: 7, ts: "nope", extra: true });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.length >= 3,
      `expected at least 3 errors, got ${JSON.stringify(result.errors)}`,
    );
  }
});

test("validation is deterministic: repeated calls are deeply equal", () => {
  const document = { id: 7, ts: "nope", extra: true };
  const first = validate("sample-record", document);
  const second = validate("sample-record", document);
  const third = validate("sample-record", document);
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);

  const passOne = validate("sample-record", GOOD_RECORD);
  const passTwo = validate("sample-record", GOOD_RECORD);
  assert.deepEqual(passOne, passTwo);
});

test("validation does not mutate the document under validation", () => {
  const document = { id: "rec_0001", ts: "2026-08-04T21:45:00Z" };
  const snapshot = JSON.stringify(document);
  validate("sample-record", document);
  assert.equal(JSON.stringify(document), snapshot);
});

// ---------------------------------------------------------------------------
// The compiled-validator reuse (APRV-206)
// ---------------------------------------------------------------------------

/**
 * The rule the reuse must not break: a result is a pure function of (schema
 * files on disk, document). The Ajv compile is skipped only when the bytes just
 * read hash to the digest it was compiled from, so a schema edited between two
 * calls is honoured by the second — which is what these cases assert, in both
 * directions and for a sibling `$ref` target as well as the target itself.
 */
const STRICT_SCHEMA = JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://approval.md/schema/test/mutable.schema.json",
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string" } },
});

const LOOSE_SCHEMA = JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://approval.md/schema/test/mutable.schema.json",
  type: "object",
  additionalProperties: true,
  required: ["id"],
  properties: { id: { type: "string" } },
});

test("a schema edited between two calls is honoured by the second (APRV-206)", () => {
  const dir = schemaDirWith("mutable", { "mutable.schema.json": STRICT_SCHEMA });
  const document = { id: "one", extra: true };

  const strict = validate("mutable", document, { schemaDir: dir });
  assert.equal(strict.ok, false, "the strict schema admitted an extra property");

  // Same path, same schema id, different bytes. A cache keyed on anything but
  // the bytes — a path, an mtime, a call count — would answer with the compile
  // above and call this document invalid.
  writeFileSync(join(dir, "mutable.schema.json"), LOOSE_SCHEMA, "utf8");
  assert.deepEqual(validate("mutable", document, { schemaDir: dir }), { ok: true });

  // And back again: the reuse is not a one-way ratchet either.
  writeFileSync(join(dir, "mutable.schema.json"), STRICT_SCHEMA, "utf8");
  assert.equal(validate("mutable", document, { schemaDir: dir }).ok, false);
});

test("a sibling schema appearing or vanishing re-compiles too (APRV-206)", () => {
  // The digest covers the whole directory's bytes, not just the target's: a
  // `$ref` target arriving or leaving changes what the same schema means.
  const dir = schemaDirWith("siblings", {
    "host.schema.json": JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://approval.md/schema/test/host.schema.json",
      type: "object",
      required: ["inner"],
      properties: { inner: { $ref: "https://approval.md/schema/test/inner.schema.json" } },
    }),
    "inner.schema.json": JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://approval.md/schema/test/inner.schema.json",
      type: "string",
    }),
  });

  assert.deepEqual(validate("host", { inner: "yes" }, { schemaDir: dir }), { ok: true });

  rmSync(join(dir, "inner.schema.json"));
  const orphaned = validate("host", { inner: "yes" }, { schemaDir: dir });
  assert.equal(orphaned.ok, false, "a missing $ref target must fail closed, not reuse a compile");
});
