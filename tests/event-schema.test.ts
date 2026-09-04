/**
 * Event log record schema (APRV-5).
 *
 * `tests/fixtures.test.ts` already proves every fixture under
 * `schema/fixtures/event/` passes or fails as filed. This suite asserts the
 * rules that fixtures can only sample: that every v0.1 event type (SPEC.md §8)
 * is accepted, that each type's required fields are actually required, and that
 * the hash-scheme identifier `alg` fails closed.
 *
 * More than the draft sixteen: `payload.pruned` (APRV-38) is the first addition,
 * and the two tests at the end pin the two things that make it safe to write — a
 * `system:` actor and a payload naming the pruned bytes. `execution.indeterminate`
 * and `execution.reconciled` (APRV-120) are two more, and the rules that make
 * THEM safe to write are pinned here too: a closed `reason` rather than an
 * exception's text, and a `human:` reconciler.
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
  "execution.indeterminate",
  "execution.reconciled",
  "budget.exceeded",
  "policy.updated",
  "policy.proposed",
  "policy.declined",
  "envelope.drift",
  "audit.sampled",
  "audit.reviewed",
  "reconciliation.required",
  "reconciliation.satisfied",
  "payload.pruned",
  "gate.opened",
  "gate.closed",
  "gate.bypassed",
  "audit.decision_refused",
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
  // APRV-120: both carry a payload the schema constrains, so `payload` is
  // required as well as the task and the key — an indeterminate outcome that
  // does not say where the unknowing began, or a reconciliation that does not
  // say what was established, is a record nobody can act on.
  "execution.indeterminate": ["task", "action_key", "payload"],
  "execution.reconciled": ["task", "action_key", "payload"],
  "budget.exceeded": ["task"],
  "policy.updated": [],
  // APRV-109. A prompt with no payload is a prompt with no hash, no diff and no
  // advisory, which is the failure this event exists to prevent; an answer with
  // no payload names neither the bytes nor the prompt it answers.
  "policy.proposed": ["payload"],
  "policy.declined": ["payload"],
  "envelope.drift": ["task"],
  "audit.sampled": [],
  "audit.reviewed": [],
  // APRV-127. The obligation must name the action it concerns, in the record
  // AND in the payload: a reconciliation nobody can attach to an action is one
  // nobody can discharge. The satisfaction names the obligation by seq instead,
  // which lives in the payload alone.
  "reconciliation.required": ["action_key", "payload"],
  "reconciliation.satisfied": ["payload"],
  // Not `task`/`action_key`: an orphaned payload (bytes with no recorded
  // binding) is prunable and has no task or action to name. `payload` is the
  // required one, because the event's whole content is which bytes went.
  "payload.pruned": ["payload"],
  // APRV-214. The window's whole state is these records, so each one must carry
  // the payload that states it: an opening with no duration or reason, a close
  // naming no opening, or a bypass naming no window is a record nobody can
  // derive the window from.
  "gate.opened": ["payload"],
  "gate.closed": ["payload"],
  "gate.bypassed": ["payload"],
  // APRV-235. The action decided, the surface that collected the gesture, and
  // the payload naming who decided and what the gate said. `channel` is
  // required here though it is optional in the base shape: a refused decision a
  // reader cannot attribute to a surface is one they cannot go and reproduce.
  "audit.decision_refused": ["action_key", "channel", "payload"],
};

/**
 * The fixture for an event type, by the filename convention the fixtures use:
 * one file per type, with the separators spelled as dashes. Underscores join
 * the dots since APRV-235, because `audit.decision_refused` is the first
 * enumerated type that carries one and `audit-decision_refused.json` would be
 * a filename nobody would guess.
 */
function fixture(event: string): Record<string, unknown> {
  const file = join(VALID_DIR, `${event.replace(/[._]/gu, "-")}.json`);
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

test("audit review must come from a human actor (SPEC.md §5.2)", () => {
  const record = fixture("audit.reviewed");
  assert.equal(validate("event", record).ok, true);

  // The runtime already refuses a non-human reviewer (`approval audit review`
  // is human-only), and the schema says so too: a sampled action reviewed by
  // `system:` or `agent:` is the party under oversight clearing its own sample.
  for (const actor of ["agent:chaser", "system:auditor"]) {
    assert.equal(
      validate("event", { ...record, actor }).ok,
      false,
      `audit.reviewed accepted a non-human actor "${actor}"`,
    );
  }
});

test("the open window is opened and closed by a human alone (APRV-214)", () => {
  for (const event of ["gate.opened", "gate.closed"]) {
    const record = fixture(event);
    assert.equal(validate("event", record).ok, true);
    // The ceremony is human-only in `core/gate-window.ts` AND here. This is the
    // one act that suspends the policy, so an agent able to author the record
    // could authorize its own next command.
    for (const actor of ["agent:claude-code", "system:daemon"]) {
      assert.equal(
        validate("event", { ...record, actor }).ok,
        false,
        `${event} accepted a non-human actor "${actor}"`,
      );
    }
  }
});

test("a bypassed call records who ran it, human or agent (APRV-214)", () => {
  const record = fixture("gate.bypassed");
  for (const actor of ["agent:claude-code", "human:carter"]) {
    assert.equal(
      validate("event", { ...record, actor }).ok,
      true,
      `gate.bypassed rejected actor "${actor}"`,
    );
  }
  // The record is a statement about a tool call, never one the runtime makes on
  // its own: there is no `system:` bypass because nothing but a harness call
  // reaches this path.
  assert.equal(validate("event", { ...record, actor: "system:daemon" }).ok, false);
});

test("a refused decision is authored by the runtime, never by either party to it (APRV-235)", () => {
  const record = fixture("audit.decision_refused");
  assert.equal(validate("event", record).ok, true);
  // The record states that the gate refused a human's decision. An approver
  // able to author it would be writing the account of their own refusal, and an
  // agent able to author it would be writing an account of a refusal it was not
  // party to.
  for (const actor of ["human:carter", "agent:claude-code"]) {
    assert.equal(
      validate("event", { ...record, actor }).ok,
      false,
      `audit.decision_refused accepted actor "${actor}"`,
    );
  }
  // The subject of the observation is the other way round: the decision it
  // records is human-only, so the payload's actor must be one.
  const payload = record["payload"] as Record<string, unknown>;
  for (const actor of ["agent:claude-code", "system:gate"]) {
    assert.equal(
      validate("event", { ...record, payload: { ...payload, actor } }).ok,
      false,
      `audit.decision_refused accepted a decider "${actor}"`,
    );
  }
  // Three verbs, and only the three the gate reserves to human hands.
  assert.equal(
    validate("event", { ...record, payload: { ...payload, decision: "withdraw" } }).ok,
    false,
  );
});

test("policy-drift is the runtime's withdrawal reason and only the runtime's (APRV-235)", () => {
  const record = fixture("approval.withdrawn.policy-drift");
  assert.equal(validate("event", record).ok, true);
  const payload = record["payload"] as Record<string, unknown>;
  // A requester that could spell `policy-drift` would be dressing its own
  // cancellation as the gate's verdict about the policy.
  for (const actor of ["agent:claude-code", "human:carter"]) {
    assert.equal(
      validate("event", { ...record, actor }).ok,
      false,
      `a ${actor} withdrawal claimed the runtime's reason`,
    );
  }
  // And the converse: the runtime withdraws for drift or not at all. The
  // pre-APRV-235 ban on a `system:` withdrawal for a requester's reason stands.
  for (const reason of ["timeout", "cancelled", "superseded"]) {
    assert.equal(
      validate("event", { ...record, payload: { ...payload, reason } }).ok,
      false,
      `the runtime withdrew a request for the requester's reason "${reason}"`,
    );
  }
});

test("gate.opened refuses a scope it was not given (APRV-214)", () => {
  const record = fixture("gate.opened");
  const payload = record["payload"] as Record<string, unknown>;
  assert.equal(
    validate("event", { ...record, payload: { ...payload, scope: "everything" } }).ok,
    false,
    "an opener may not invent a scope",
  );
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

test("display_hash is optional on approval.requested, and shaped where present (APRV-119)", () => {
  const record = fixture("approval.requested");
  const payload = (record["payload"] ?? {}) as Record<string, unknown>;

  // Additive: a record written before WYSIWYS existed still validates, which is
  // what an append-only log requires of every field this project ever adds.
  assert.equal(validate("event", record).ok, true, "the fixture carries no display_hash and failed");

  const digest = "a".repeat(64);
  assert.equal(
    validate("event", { ...record, payload: { ...payload, display_hash: digest } }).ok,
    true,
    "approval.requested rejected a well-formed display hash",
  );

  // Shape is constrained where it IS present: a truncated or upper-case digest
  // is one an auditor re-rendering the payload could not compare against.
  for (const value of ["", "a".repeat(63), "A".repeat(64), 7, null]) {
    assert.equal(
      validate("event", { ...record, payload: { ...payload, display_hash: value } }).ok,
      false,
      `approval.requested accepted display_hash ${JSON.stringify(value)}`,
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

// ---------------------------------------------------------------------------
// APRV-120: the two rules that make an indeterminate outcome safe to write
// ---------------------------------------------------------------------------

test("execution.indeterminate takes a closed reason and never an exception's text", () => {
  const record = fixture("execution.indeterminate");
  assert.equal(validate("event", record).ok, true);
  // The whole point of the closed set: an open `reason` is where an exception
  // message, and the credential quoted inside it, would arrive in the log.
  for (const reason of ["act-failed", "connect ETIMEDOUT smtp.example.com:587", "", null, 3]) {
    assert.equal(
      validate("event", { ...record, payload: { reason } }).ok,
      false,
      `execution.indeterminate accepted reason ${JSON.stringify(reason)}`,
    );
  }
});

test("execution.indeterminate never carries a number for exit_code", () => {
  const record = fixture("execution.indeterminate");
  for (const exitCode of [0, 1, 137]) {
    assert.equal(
      validate("event", { ...record, payload: { reason: "act-threw", exit_code: exitCode } }).ok,
      false,
      `execution.indeterminate accepted exit_code ${exitCode}; nobody watched a process exit`,
    );
  }
  // Absent is fine; present-and-null is the explicit form.
  assert.equal(validate("event", { ...record, payload: { reason: "act-threw" } }).ok, true);
});

test("execution.reconciled is human-only and says which resolution it recorded", () => {
  const record = fixture("execution.reconciled");
  assert.equal(validate("event", record).ok, true);
  const payload = record["payload"] as Record<string, unknown>;

  for (const actor of ["agent:chaser", "system:daemon"]) {
    assert.equal(
      validate("event", { ...record, actor }).ok,
      false,
      `execution.reconciled accepted a non-human reconciler "${actor}"`,
    );
  }
  assert.equal(
    validate("event", { ...record, payload: { ...payload, resolution: "not-executed" } }).ok,
    true,
  );
  for (const resolution of ["unknown", "maybe", "", null]) {
    assert.equal(
      validate("event", { ...record, payload: { ...payload, resolution } }).ok,
      false,
      `execution.reconciled accepted resolution ${JSON.stringify(resolution)}`,
    );
  }
  // An unexplained resolution cannot be told apart from a guess.
  assert.equal(validate("event", { ...record, payload: { ...payload, note: "" } }).ok, false);
});

// ---------------------------------------------------------------------------
// The attestation ceremony (APRV-109)
// ---------------------------------------------------------------------------

test("policy.proposed is asked by a principal, never by the runtime", () => {
  const record = fixture("policy.proposed");
  assert.equal(validate("event", record).ok, true);

  // A person may propose an amendment and so may an agent. `system:` may not:
  // the runtime has no policy edit of its own to ask about, and a
  // runtime-originated proposal would be the gate writing its own rules.
  for (const actor of ["human:carter", "agent:claude-code"]) {
    assert.equal(
      validate("event", { ...record, actor }).ok,
      true,
      `policy.proposed rejected a principal actor "${actor}"`,
    );
  }
  for (const actor of ["system:daemon", "carter"]) {
    assert.equal(
      validate("event", { ...record, actor }).ok,
      false,
      `policy.proposed accepted actor "${actor}"`,
    );
  }
});

test("a proposal that shows only a hash is refused at the write boundary", () => {
  const record = fixture("policy.proposed");
  const payload = record["payload"] as Record<string, unknown>;

  // The three COMPUTED fields are each required. A prompt missing the diff asks
  // a human to sign for sixty-four characters; one missing the advisory hides
  // that the policy fails closed to all-manual; one missing the hash names no
  // bytes at all.
  for (const field of ["sha256", "diff", "load", "policy_path"]) {
    const copy = { ...payload };
    delete copy[field];
    assert.equal(
      validate("event", { ...record, payload: copy }).ok,
      false,
      `policy.proposed validated without payload.${field}`,
    );
  }

  // And the diff itself must say whether it is available and what it renders as.
  for (const field of ["available", "lines", "headline"]) {
    const diff = { ...(payload["diff"] as Record<string, unknown>) };
    delete diff[field];
    assert.equal(
      validate("event", { ...record, payload: { ...payload, diff } }).ok,
      false,
      `policy.proposed validated without payload.diff.${field}`,
    );
  }

  for (const sha256 of ["", "not-a-hash", "A".repeat(64), "a".repeat(63)]) {
    assert.equal(
      validate("event", { ...record, payload: { ...payload, sha256 } }).ok,
      false,
      `policy.proposed accepted sha256 ${JSON.stringify(sha256)}`,
    );
  }
});

test("policy.declined is human-only and names the prompt it answers", () => {
  const record = fixture("policy.declined");
  assert.equal(validate("event", record).ok, true);
  const payload = record["payload"] as Record<string, unknown>;

  // Answering an attestation prompt is the human act the ceremony exists to
  // collect. An agent-authored refusal would be the party under oversight
  // closing its own question.
  for (const actor of ["agent:claude-code", "system:daemon"]) {
    assert.equal(
      validate("event", { ...record, actor }).ok,
      false,
      `policy.declined accepted a non-human actor "${actor}"`,
    );
  }

  for (const field of ["sha256", "proposed_seq"]) {
    const copy = { ...payload };
    delete copy[field];
    assert.equal(
      validate("event", { ...record, payload: copy }).ok,
      false,
      `policy.declined validated without payload.${field}`,
    );
  }
  for (const seq of [0, -1, 1.5, "41"]) {
    assert.equal(
      validate("event", { ...record, payload: { ...payload, proposed_seq: seq } }).ok,
      false,
      `policy.declined accepted proposed_seq ${JSON.stringify(seq)}`,
    );
  }
});

test("an attestation may name the prompt it answers, and need not", () => {
  const record = fixture("policy.updated");
  const payload = record["payload"] as Record<string, unknown>;

  // `approval policy attest` at a terminal answers no prompt and carries none.
  assert.equal(validate("event", record).ok, true);
  assert.equal(
    validate("event", { ...record, payload: { ...payload, proposed_seq: 41 } }).ok,
    true,
  );
  for (const seq of [0, -3, "41"]) {
    assert.equal(
      validate("event", { ...record, payload: { ...payload, proposed_seq: seq } }).ok,
      false,
      `policy.updated accepted proposed_seq ${JSON.stringify(seq)}`,
    );
  }
});
