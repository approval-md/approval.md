/**
 * Event log record schema (APRV-5).
 *
 * `tests/fixtures.test.ts` already proves every fixture under
 * `schema/fixtures/event/` passes or fails as filed. This suite asserts the
 * rules that fixtures can only sample: that all seventeen v0.1 event types
 * (SPEC.md §8) are accepted, that each type's required fields are actually
 * required, and that the hash-scheme identifier `alg` fails closed.
 *
 * Seventeen, not sixteen: `payload.pruned` (APRV-38) is the first addition
 * after the draft set, and the last two tests here pin the two things that make
 * it safe to write — a `system:` actor and a payload naming the pruned bytes.
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
  "payload.pruned",
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
  // Not `task`/`action_key`: an orphaned payload (bytes with no recorded
  // binding) is prunable and has no task or action to name. `payload` is the
  // required one, because the event's whole content is which bytes went.
  "payload.pruned": ["payload"],
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

test("payload.pruned is system-authored and names the pruned bytes (SPEC.md §5.2)", () => {
  const record = fixture("payload.pruned");
  assert.equal(validate("event", record).ok, true);

  // Pruning is a retention rule executing on a schedule. A human or agent
  // pruner would be a party under oversight deleting the evidence its own
  // approval bound to, so the actor prefix is the control.
  for (const actor of ["human:carter", "agent:chaser"]) {
    assert.equal(
      validate("event", { ...record, actor }).ok,
      false,
      `payload.pruned accepted actor "${actor}"`,
    );
  }

  // The payload must name the removed bytes by their content address, and by
  // one that is a SHA-256: a truncated or upper-case digest names no file.
  for (const payload of [
    {},
    { reason: "payload_retention" },
    { payload_hash: "8ae4823e" },
    { payload_hash: "8AE4823E490219F719383730BAC75A35543AD790475300FB1A0113A2E2D1D834" },
  ]) {
    assert.equal(
      validate("event", { ...record, payload }).ok,
      false,
      `payload.pruned accepted payload ${JSON.stringify(payload)}`,
    );
  }
});

test("batch_delivery_id is a first-class decision payload field (SPEC.md §10.3)", () => {
  for (const event of ["approval.granted", "approval.rejected"]) {
    const record = fixture(event);
    const payload = (record["payload"] ?? {}) as Record<string, unknown>;
    assert.equal(
      validate("event", {
        ...record,
        payload: { ...payload, batch_delivery_id: "tg-batch-7" },
      }).ok,
      true,
      `${event} rejected a batch delivery id`,
    );
    // A batch id that identifies no batch would read to audit as a grouping
    // that never happened, so the shape is constrained where it is accepted.
    for (const value of ["", 7, null]) {
      assert.equal(
        validate("event", {
          ...record,
          payload: { ...payload, batch_delivery_id: value },
        }).ok,
        false,
        `${event} accepted batch_delivery_id ${JSON.stringify(value)}`,
      );
    }
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
