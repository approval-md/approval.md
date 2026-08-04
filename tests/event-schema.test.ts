/**
 * Event log record schema (APRV-5).
 *
 * `tests/fixtures.test.ts` already proves every fixture under
 * `schema/fixtures/event/` passes or fails as filed. This suite asserts the
 * rules that fixtures can only sample: that all sixteen v0.1 event types
 * (SPEC.md §8) are accepted, that each type's required fields are actually
 * required, and that the hash-scheme identifier `alg` fails closed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_SCHEMA_DIR, validate } from "../src/core/validate.js";

const VALID_DIR = join(DEFAULT_SCHEMA_DIR, "fixtures", "event", "valid");

const EVENT_TYPES = [
  "task.registered",
  "route.proposed",
  "route.accepted",
  "approval.requested",
  "approval.granted",
  "approval.rejected",
  "approval.expired",
  "approval.revoked",
  "execution.started",
  "execution.completed",
  "execution.failed",
  "budget.exceeded",
  "policy.updated",
  "envelope.drift",
  "audit.sampled",
  "audit.reviewed",
] as const;

/** Fields each event type requires beyond the base record shape. */
const EXTRA_REQUIRED: Record<string, readonly string[]> = {
  "task.registered": ["task"],
  "route.proposed": ["task"],
  "route.accepted": ["task"],
  "approval.requested": ["task", "action_key"],
  "approval.granted": ["task", "action_key"],
  "approval.rejected": ["task", "action_key"],
  "approval.expired": ["task", "action_key"],
  "approval.revoked": ["task", "action_key"],
  "execution.started": ["task", "action_key"],
  "execution.completed": ["task", "action_key"],
  "execution.failed": ["task", "action_key"],
  "budget.exceeded": ["task"],
  "policy.updated": [],
  "envelope.drift": ["task"],
  "audit.sampled": [],
  "audit.reviewed": [],
};

function fixture(event: string): Record<string, unknown> {
  const file = join(VALID_DIR, `${event.replace(/\./g, "-")}.json`);
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function without(
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const copy = { ...record };
  delete copy[field];
  return copy;
}

test("every v0.1 event type has an accepted fixture", () => {
  for (const event of EVENT_TYPES) {
    const result = validate("event", fixture(event));
    assert.equal(
      result.ok,
      true,
      `${event} fixture rejected: ${result.ok ? "" : JSON.stringify(result.errors)}`,
    );
  }
});

test("per-type required fields are enforced", () => {
  for (const event of EVENT_TYPES) {
    for (const field of EXTRA_REQUIRED[event] ?? []) {
      const result = validate("event", without(fixture(event), field));
      assert.equal(
        result.ok,
        false,
        `${event} validated without required field "${field}"`,
      );
    }
  }
});

test("optional base fields stay optional where no rule requires them", () => {
  for (const event of EVENT_TYPES) {
    const required = new Set(EXTRA_REQUIRED[event] ?? []);
    for (const field of ["task", "action_key", "channel", "payload"]) {
      if (required.has(field)) continue;
      const record = fixture(event);
      if (!(field in record)) continue;
      const result = validate("event", without(record, field));
      assert.equal(
        result.ok,
        true,
        `${event} should tolerate a missing "${field}"`,
      );
    }
  }
});

test("approval decisions must come from a human actor (SPEC.md §10.1)", () => {
  for (const event of ["approval.granted", "approval.rejected"]) {
    for (const actor of ["agent:chaser", "system:daemon"]) {
      const result = validate("event", { ...fixture(event), actor });
      assert.equal(
        result.ok,
        false,
        `${event} accepted a non-human actor "${actor}"`,
      );
    }
  }
});

test("non-decision events accept agent and system actors", () => {
  for (const actor of ["human:carter", "agent:chaser", "system:daemon"]) {
    const result = validate("event", { ...fixture("approval.expired"), actor });
    assert.equal(
      result.ok,
      true,
      `approval.expired rejected actor "${actor}": ${
        result.ok ? "" : JSON.stringify(result.errors)
      }`,
    );
  }
});

test("alg fails closed when missing or unrecognized (SPEC.md §8)", () => {
  const record = fixture("approval.granted");
  assert.equal(validate("event", without(record, "alg")).ok, false);
  for (const alg of ["sha1/jcs", "sha256", "SHA256/JCS", ""]) {
    assert.equal(
      validate("event", { ...record, alg }).ok,
      false,
      `unrecognized alg "${alg}" was accepted`,
    );
  }
});

test("prev accepts a 64-hex link or null, and nothing else", () => {
  const record = fixture("approval.granted");
  assert.equal(validate("event", { ...record, prev: null }).ok, true);
  for (const prev of ["b3c9", "", "B3C9".repeat(16), 0]) {
    assert.equal(
      validate("event", { ...record, prev }).ok,
      false,
      `prev ${JSON.stringify(prev)} was accepted`,
    );
  }
});
