/**
 * Fixture convention enforcement (APRV-2 AC #5).
 *
 * Every schema under `schema/*.schema.json` MUST ship fixtures at:
 *   schema/fixtures/<schema-name>/valid/*.json
 *   schema/fixtures/<schema-name>/invalid/*.json
 *
 * Valid fixtures must pass; invalid fixtures must fail with at least one
 * error. A schema with no fixture directory, zero valid fixtures, or zero
 * invalid fixtures fails this suite loudly — proving inputs are rejected is
 * as load-bearing as proving they pass.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_SCHEMA_DIR,
  listSchemaNames,
  validate,
} from "../src/core/validate.js";

const FIXTURE_ROOT = join(DEFAULT_SCHEMA_DIR, "fixtures");

function listJsonFixtures(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.endsWith(".json")).sort();
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

const schemaNames = listSchemaNames();

test("the schema directory contains at least one schema", () => {
  assert.ok(
    schemaNames.length > 0,
    `no *.schema.json files found in ${DEFAULT_SCHEMA_DIR}`,
  );
});

for (const name of schemaNames) {
  const validDir = join(FIXTURE_ROOT, name, "valid");
  const invalidDir = join(FIXTURE_ROOT, name, "invalid");
  const validFixtures = listJsonFixtures(validDir);
  const invalidFixtures = listJsonFixtures(invalidDir);

  test(`schema "${name}" ships valid fixtures`, () => {
    assert.ok(
      validFixtures.length > 0,
      `schema "${name}" has zero valid fixtures: add at least one JSON document to ${validDir}`,
    );
  });

  test(`schema "${name}" ships invalid fixtures`, () => {
    assert.ok(
      invalidFixtures.length > 0,
      `schema "${name}" has zero invalid fixtures: add at least one rejected JSON document to ${invalidDir}`,
    );
  });

  for (const fixture of validFixtures) {
    test(`schema "${name}": valid fixture ${fixture} passes`, () => {
      const result = validate(name, readJson(join(validDir, fixture)));
      assert.equal(
        result.ok,
        true,
        `expected ${fixture} to validate, got errors: ${
          result.ok ? "" : JSON.stringify(result.errors)
        }`,
      );
    });
  }

  for (const fixture of invalidFixtures) {
    test(`schema "${name}": invalid fixture ${fixture} is rejected`, () => {
      const result = validate(name, readJson(join(invalidDir, fixture)));
      assert.equal(
        result.ok,
        false,
        `expected ${fixture} to be rejected by schema "${name}", but it validated`,
      );
      if (!result.ok) {
        assert.ok(
          result.errors.length > 0,
          `rejection of ${fixture} carried no reason`,
        );
      }
    });
  }
}
