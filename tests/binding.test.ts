/**
 * Content binding end to end (amended SPEC.md §6.2, §10 — amendment A1).
 *
 * "An execution token is bound to the request, its `idempotency_key`, AND its
 * `payload_hash`. […] A grant therefore approves specific bytes. Changing the
 * payload after grant requires a new request."
 *
 * Four claims are tested here, each at the point that enforces it:
 *
 * 1. A manual action whose registration declares no `payload_hash` never
 *    reaches a human's queue — intake refuses `payload-hash-required` and
 *    appends nothing.
 * 2. Non-manual actions are unaffected: the amendment says MUST for `manual`,
 *    SHOULD otherwise, and the gate does not invent a stricter rule.
 * 3. The binding travels request → grant → start, copied and never recomputed.
 * 4. A spend against different bytes — or against none — is refused
 *    `payload-mismatch`, writes nothing, and leaves the token live. So is a
 *    spend against a grant that recorded no binding at all: a record the
 *    current gate could not have produced is not a licence, and accepting one
 *    would make the binding bypassable by log construction.
 *
 * Also here, because it is the other fail-closed hole APRV-20 pass two filled:
 * a grant on a request with no usable `class` is refused
 * `grant-classless-request` instead of being recorded with an empty one.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { appendEvent } from "../src/core/log.js";
import { decide, register, request, type GateRefusal } from "../src/core/gate.js";
import {
  consumeToken,
  mintToken,
  tokenHash,
  tokenStatus,
  type TokenRefusal,
} from "../src/core/token.js";
import {
  assertClean,
  at,
  attest,
  eventTypes,
  fixedClock,
  newScenario,
  payloadOf,
  records,
  scratchRoot,
  T0,
  type Scenario,
} from "./scenario.js";

const { root, cleanup } = scratchRoot("binding");
after(cleanup);

const BOUND = "a".repeat(64);
const OTHER = "b".repeat(64);

const MANUAL_KEY = "task-042:chaser";
const SUPERVISED_KEY = "task-042:draft";

/** An envelope whose manual action may or may not declare a binding. */
function envelope(bind: boolean): unknown {
  return {
    origin: { app: "example-capture", created_by: "human:carter" },
    state: "proposed",
    actions: [
      {
        class: "communicate.email.external",
        summary: "Send deposit chaser",
        reversible: false,
        est_cost_usd: "0.02",
        idempotency_key: MANUAL_KEY,
        ...(bind ? { payload_hash: BOUND } : {}),
      },
      {
        class: "files.write.local",
        summary: "Write the draft",
        reversible: true,
        est_cost_usd: "0.01",
        idempotency_key: SUPERVISED_KEY,
      },
    ],
  };
}

function ready(bind: boolean): Scenario {
  const unit = newScenario(root);
  attest(unit);
  const registered = register(
    unit.logPath,
    { task: "task-042", envelope: envelope(bind) },
    "agent:claude",
    { ...unit.options, clock: fixedClock(T0) },
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);
  return unit;
}

function requestManual(unit: Scenario, ts: string = at(1)) {
  return request(
    unit.logPath,
    {
      task: "task-042",
      actionKey: MANUAL_KEY,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
    },
    "agent:claude",
    { ...unit.options, clock: fixedClock(ts) },
  );
}

/** Request + grant the manual action, returning the raw token. */
function grantManual(unit: Scenario): string {
  assert.equal(requestManual(unit).ok, true);
  const granted = decide(unit.logPath, MANUAL_KEY, "grant", "human:carter", {
    ...unit.options,
    clock: fixedClock(at(2)),
  });
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);
  if (!granted.ok || granted.token === undefined) throw new Error("expected a token");
  return granted.token;
}

// ---------------------------------------------------------------------------
// 1 + 2: the MUST, and the limits of the MUST
// ---------------------------------------------------------------------------

test("a manual action with no declared payload_hash is refused at intake, log untouched", () => {
  const unit = ready(false);
  const refusal = requestManual(unit) as GateRefusal;

  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, "payload-hash-required");
  assert.match(refusal.message, /§6\.2/u);
  // Nothing appended: a request nobody can bind to must not reach the queue.
  assert.deepEqual(eventTypes(unit), ["policy.updated", "task.registered"]);
  assertClean(unit);
});

test("supervised actions are unaffected: MUST for manual, SHOULD otherwise", () => {
  const unit = ready(false);
  const result = request(
    unit.logPath,
    { task: "task-042", actionKey: SUPERVISED_KEY, cls: "files.write.local", reversible: true },
    "agent:claude",
    { ...unit.options, clock: fixedClock(at(1)) },
  );
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) return;
  assert.equal(result.autonomy, "supervised");
  assert.equal(result.proceed, true);
  assert.equal(result.record, null);
  assertClean(unit);
});

test("the log's declaration wins over a caller-supplied hash", () => {
  // An agent that could name its own binding at request time could have a human
  // approve one payload and a token spend another. The registration governs.
  const unit = ready(true);
  const result = request(
    unit.logPath,
    {
      task: "task-042",
      actionKey: MANUAL_KEY,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      payload_hash: OTHER,
    },
    "agent:claude",
    { ...unit.options, clock: fixedClock(at(1)) },
  );
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok || result.record === null) return;
  assert.equal(payloadOf(result.record)["payload_hash"], BOUND);
  assertClean(unit);
});

// ---------------------------------------------------------------------------
// 3: the binding travels
// ---------------------------------------------------------------------------

test("the binding is copied request → grant → execution.started, never recomputed", () => {
  const unit = ready(true);
  const token = grantManual(unit);

  const logged = records(unit);
  const requested = logged.find((record) => record.event === "approval.requested");
  const granted = logged.find((record) => record.event === "approval.granted");
  assert.equal(payloadOf(requested!)["payload_hash"], BOUND);
  assert.equal(payloadOf(granted!)["payload_hash"], BOUND);

  // …and the status read reports what the grant bound to, for a channel to show.
  const status = tokenStatus(logged, MANUAL_KEY, at(3), null);
  assert.equal(status.ok, true);
  assert.equal(status.ok && status.payloadHash, BOUND);

  const consumed = consumeToken(unit.logPath, MANUAL_KEY, token, "agent:claude", {
    policyFile: unit.policyPath,
    presentedPayloadHash: BOUND,
    clock: fixedClock(at(3)),
  });
  assert.equal(consumed.ok, true, consumed.ok ? "" : consumed.message);
  if (!consumed.ok) return;
  assert.equal(payloadOf(consumed.record)["payload_hash"], BOUND);
  assertClean(unit);
});

// ---------------------------------------------------------------------------
// 4: the refusal
// ---------------------------------------------------------------------------

test("spending against different bytes is payload-mismatch; nothing is written", () => {
  const unit = ready(true);
  const token = grantManual(unit);
  const before = eventTypes(unit);

  const refusal = consumeToken(unit.logPath, MANUAL_KEY, token, "agent:claude", {
    policyFile: unit.policyPath,
    presentedPayloadHash: OTHER,
    clock: fixedClock(at(3)),
  }) as TokenRefusal;

  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, "payload-mismatch");
  assert.match(refusal.message, /not the one approved/u);
  assert.deepEqual(eventTypes(unit), before, "a mismatch appended something");

  // The token is NOT spent: the repair is a new request for the new payload,
  // not a hunt for a lost token.
  const good = consumeToken(unit.logPath, MANUAL_KEY, token, "agent:claude", {
    policyFile: unit.policyPath,
    presentedPayloadHash: BOUND,
    clock: fixedClock(at(4)),
  });
  assert.equal(good.ok, true, good.ok ? "" : good.message);
  assertClean(unit);
});

test("presenting no hash at all against a bound grant is a mismatch too", () => {
  const unit = ready(true);
  const token = grantManual(unit);
  const before = eventTypes(unit);

  const refusal = consumeToken(unit.logPath, MANUAL_KEY, token, "agent:claude", {
    policyFile: unit.policyPath,
    clock: fixedClock(at(3)),
  }) as TokenRefusal;

  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, "payload-mismatch");
  assert.match(refusal.message, /presented none/u);
  assert.deepEqual(eventTypes(unit), before);
  assertClean(unit);
});

test("a grant that recorded NO binding cannot be spent at all — not even with a hash", () => {
  // A pre-A1 log, or one written by something other than this gate: the current
  // `request` refuses `payload-hash-required` for every manual action, so a
  // grant with no `payload_hash` could only have reached the log another way.
  // Treating it as "unbound and therefore free" would make content binding
  // bypassable by log construction, which is the one attack the binding exists
  // to stop. The grant is permanently unspendable; revoke and re-request.
  const unit = ready(true);
  const token = mintToken();

  const requested = appendEvent(unit.logPath, {
    ts: at(1),
    event: "approval.requested",
    actor: "agent:mallory",
    task: "task-042",
    action_key: "task-042:legacy",
    payload: { class: "communicate.email.external", est_cost_usd: "0.02" },
  });
  assert.equal(requested.ok, true);
  const granted = appendEvent(unit.logPath, {
    ts: at(2),
    event: "approval.granted",
    actor: "human:carter",
    task: "task-042",
    action_key: "task-042:legacy",
    payload: {
      class: "communicate.email.external",
      est_cost_usd: "0.02",
      token_sha256: tokenHash(token),
    },
  });
  assert.equal(granted.ok, true);

  // The token itself is genuine — this is not a token-mismatch case.
  const status = tokenStatus(records(unit), "task-042:legacy", at(3), null);
  assert.equal(status.ok, true);
  assert.equal(status.ok && status.payloadHash, null);

  const before = eventTypes(unit);
  for (const presented of [undefined, BOUND]) {
    const refusal = consumeToken(unit.logPath, "task-042:legacy", token, "agent:mallory", {
      policyFile: unit.policyPath,
      ...(presented === undefined ? {} : { presentedPayloadHash: presented }),
      clock: fixedClock(at(3)),
    }) as TokenRefusal;
    assert.equal(refusal.ok, false);
    assert.equal(refusal.code, "payload-mismatch");
    assert.match(refusal.message, /predates content binding/u);
    assert.match(refusal.message, /revoke it and request the action again/u);
  }
  assert.deepEqual(eventTypes(unit), before, "an unbound grant was spent");
  assertClean(unit);
});

test("payload-mismatch is distinct from token-mismatch: different facts, different repairs", () => {
  const unit = ready(true);
  grantManual(unit);
  const wrong = consumeToken(unit.logPath, MANUAL_KEY, "f".repeat(64), "agent:claude", {
    policyFile: unit.policyPath,
    presentedPayloadHash: BOUND,
    clock: fixedClock(at(3)),
  }) as TokenRefusal;
  assert.equal(wrong.code, "token-mismatch", "the wrong bearer is not a payload problem");
  assertClean(unit);
});

// ---------------------------------------------------------------------------
// grant-classless-request
// ---------------------------------------------------------------------------

test("a grant on a request with no usable class is refused, not recorded with an empty one", () => {
  const unit = ready(true);

  // A request written by something other than this gate: valid at the write
  // boundary (the event schema does not constrain payload shape at v0.1) and
  // missing the one field a grant is scoped by.
  const appended = appendEvent(unit.logPath, {
    ts: at(1),
    event: "approval.requested",
    actor: "agent:mallory",
    task: "task-042",
    action_key: "task-042:classless",
    payload: { est_cost_usd: "0", payload_hash: BOUND },
  });
  assert.equal(appended.ok, true);

  const before = eventTypes(unit);
  const refusal = decide(unit.logPath, "task-042:classless", "grant", "human:carter", {
    ...unit.options,
    clock: fixedClock(at(2)),
  }) as GateRefusal;

  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, "grant-classless-request");
  assert.match(refusal.message, /no usable payload\.class/u);
  assert.deepEqual(eventTypes(unit), before, "a classless grant reached the log");
  assertClean(unit);
});

test("reject and revoke need no class: withdrawing authority is not scoped by one", () => {
  const unit = ready(true);
  const appended = appendEvent(unit.logPath, {
    ts: at(1),
    event: "approval.requested",
    actor: "agent:mallory",
    task: "task-042",
    action_key: "task-042:classless",
    payload: { est_cost_usd: "0" },
  });
  assert.equal(appended.ok, true);

  const rejected = decide(unit.logPath, "task-042:classless", "reject", "human:carter", {
    ...unit.options,
    clock: fixedClock(at(2)),
  });
  assert.equal(rejected.ok, true, rejected.ok ? "" : rejected.message);
  assertClean(unit);
});
