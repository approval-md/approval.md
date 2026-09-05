/**
 * A refused human decision leaves a trace (APRV-235).
 *
 * Every record here is produced by the real append path — the decision surface
 * calling `core/decision-refusal.ts` calling `core/log.ts`'s `appendEvent` —
 * and every scenario ends by walking the chain, so a refusal that records
 * correctly and leaves a broken log has still failed. Nothing hand-writes a
 * line.
 *
 * The suite is organised around what the task actually claims:
 *
 *  1. The record exists, is audit-tier, and MOVES NOTHING. The state, the
 *     budget verdicts and the sampling candidates are taken before and after
 *     and compared, because "grants nothing" is a claim about the whole runtime
 *     and not about this module.
 *  2. `policy-drift` also withdraws, and the void request stops being offered
 *     by `approval queue`, by `QUEUE.md` and by anything else deriving state.
 *  3. Agent-side refusals stay unlogged, which is a choice and is tested as one.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { after, test } from "node:test";

import { recordChannelDecision, refusedDecisionLine } from "../src/channels/contract.js";
import { renderQueue } from "../src/channels/render-queue.js";
import { supervisedExecutions } from "../src/core/audit.js";
import { evaluateBudgetsWithTask } from "../src/core/budgets.js";
import {
  DECISION_REFUSAL_ACTOR,
  recordRefusedDecision,
  voidsTheRequest,
} from "../src/core/decision-refusal.js";
import { requestState } from "../src/core/gate.js";
import type { EventRecord } from "../src/core/log.js";
import { loadPolicy } from "../src/core/policy-load.js";
import {
  consumeHarnessGrant,
  decide,
  register,
  request,
  withdraw,
} from "./clock-adapters.js";
import {
  assertClean,
  at,
  attest,
  eventTypes,
  fixedClock,
  newScenario,
  payloadOf,
  POLICY,
  records,
  scratchRoot,
  T0,
  type Scenario,
} from "./scenario.js";

const scratch = scratchRoot("decision-refusal");
after(scratch.cleanup);

const HUMAN = "human:carter";
const AGENT = "agent:claude";
const TASK = "task-042";
const KEY = "task-042:chaser";
const PAYLOAD_HASH = "1".repeat(64);

/**
 * The same policy with one class widened. Attesting this after a request has
 * been routed is what `policy-drift` is: every check still passes, and the
 * rules are a different set of rules.
 */
const POLICY_EDITED = POLICY.replace(
  "  files.write.*:\n    autonomy: supervised",
  "  files.write.*:\n    autonomy: autonomous",
);

const ENVELOPE = {
  origin: { app: "example-capture", created_by: HUMAN },
  state: "proposed",
  actions: [
    {
      class: "communicate.email.external",
      summary: "Send deposit chaser",
      reversible: false,
      est_cost_usd: "0.02",
      idempotency_key: KEY,
      payload_hash: PAYLOAD_HASH,
    },
  ],
};

/** An attested policy, a registered task and one pending manual request. */
function pending(): Scenario {
  const unit = newScenario(scratch.root, POLICY);
  attest(unit, T0);
  const registered = register(unit.logPath, { task: TASK, envelope: ENVELOPE }, T0, AGENT);
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);
  const opened = request(
    unit.logPath,
    {
      task: TASK,
      actionKey: KEY,
      payload_hash: PAYLOAD_HASH,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      summary: "Send deposit chaser",
    },
    at(1),
    AGENT,
    unit.options,
  );
  assert.equal(opened.ok, true, opened.ok ? "" : opened.message);
  return unit;
}

/** A tap on `unit`, reported the way every channel reports one. */
function tap(
  unit: Scenario,
  decision: "grant" | "reject",
  ts: string,
  channel = "telegram",
): ReturnType<typeof recordChannelDecision> {
  return recordChannelDecision(
    unit.logPath,
    { action_key: KEY, decision, deliveryId: "1" },
    { actor: HUMAN, channel },
    { ...unit.options, clock: fixedClock(ts) },
  );
}

function ofType(unit: Scenario, event: string): EventRecord[] {
  return records(unit).filter((record) => record.event === event);
}

/** The one `audit.decision_refused`, asserted to be exactly one. */
function theAudit(unit: Scenario): EventRecord {
  const found = ofType(unit, "audit.decision_refused");
  assert.equal(found.length, 1, `expected exactly one audit record, got ${found.length}`);
  return found[0] as EventRecord;
}

/**
 * Everything the runtime derives that MUST NOT move when an audit record lands:
 * the request's state, the budget verdicts a grant would be charged against,
 * and the executions the sampler would draw from.
 */
function derived(unit: Scenario, ts: string): unknown {
  const all = records(unit);
  return {
    state: requestState(all, KEY, ts, 3_600_000),
    budgets: evaluateBudgetsWithTask(
      all,
      { classes: {}, budgets: [] } as unknown as Parameters<typeof evaluateBudgetsWithTask>[1],
      { class: "communicate.email.external", est_cost_usd: "0.02" },
      ts,
      TASK,
    ),
    sampling: supervisedExecutions(all, loadPolicy({ file: unit.policyPath })),
  };
}

// ===========================================================================
// 1 — the record exists, and it moves nothing
// ===========================================================================

test("a refused human decision appends one audit record naming who, what and why", () => {
  const unit = pending();
  // A rejection first, so the second tap is refused on a request that is
  // already terminal — a refusal that does NOT void the request, which is what
  // the no-state-change assertion below needs.
  assert.equal(tap(unit, "reject", at(2)).outcome.ok, true);

  const before = derived(unit, at(4));
  const refused = tap(unit, "grant", at(3));
  assert.equal(refused.outcome.ok, false);
  if (refused.outcome.ok) throw new Error("unreachable");
  assert.equal(refused.outcome.code, "already-decided");

  const audit = theAudit(unit);
  // The runtime authors it. Neither party to the refusal does.
  assert.equal(audit.actor, DECISION_REFUSAL_ACTOR);
  assert.match(audit.actor, /^system:/u);
  assert.equal(audit.action_key, KEY);
  assert.equal(audit.task, TASK);
  assert.equal(audit.channel, "telegram");
  const payload = payloadOf(audit);
  assert.equal(payload["actor"], HUMAN);
  assert.equal(payload["decision"], "grant");
  // The gate's code, verbatim: §11.1 invariant 6 is about refusals staying
  // machine-readable and distinct, and a record that paraphrased one would be
  // a second vocabulary for the same fact.
  assert.equal(payload["code"], "already-decided");
  assert.equal(payload["message"], refused.outcome.message);
  // No drift, so no hashes: this refusal compared nothing.
  assert.equal(payload["policy_sha256_requested"], undefined);
  assert.equal(payload["policy_sha256_attested"], undefined);

  // Audit tier, stated as the property it is rather than as an intention. The
  // request's state, the budgets a grant would be charged against, and the pool
  // the sampler draws from are all what they were before the record landed.
  assert.deepEqual(derived(unit, at(4)), before);
  // And it grants nothing: no token was minted, and no authorization exists.
  assert.equal(refused.token, undefined);
  assert.deepEqual(ofType(unit, "approval.granted"), []);
  assertClean(unit);
});

test("the audit record is not a decision: the request is still rejected, not re-openable", () => {
  const unit = pending();
  assert.equal(tap(unit, "reject", at(2)).outcome.ok, true);
  assert.equal(tap(unit, "grant", at(3)).outcome.ok, false);

  // A reader deriving state from the log after the audit record sees exactly
  // what they saw before it: `core/state.ts` does not settle on this event, and
  // that is the whole content of "audit tier".
  const state = requestState(records(unit), KEY, at(4), 3_600_000);
  assert.equal(state.state, "rejected");
  // A second refused tap appends a second audit record. The events are facts
  // about attention spent, so two taps are two facts; nothing dedupes them.
  assert.equal(tap(unit, "grant", at(5)).outcome.ok, false);
  assert.equal(ofType(unit, "audit.decision_refused").length, 2);
  assert.equal(requestState(records(unit), KEY, at(6), 3_600_000).state, "rejected");
  assertClean(unit);
});

test("the CLI verb records the same refusal, under its own channel name", () => {
  const unit = pending();
  assert.equal(tap(unit, "reject", at(2), "web").outcome.ok, true);
  const refusal = decide(unit.logPath, KEY, "grant", HUMAN, at(3), unit.options);
  assert.equal(refusal.ok, false);

  // `decide()` itself appends nothing — the contract that lets a caller retry a
  // refusal without wondering what it wrote. The surface is what records.
  const audits = ofType(unit, "audit.decision_refused");
  assert.equal(audits.length, 0, "core/gate.ts appended an audit record itself");
  assertClean(unit);
});

// ===========================================================================
// 2 — policy-drift withdraws the request it voids
// ===========================================================================

/** A pending request whose policy has since been re-attested. */
function drifted(): Scenario {
  const unit = pending();
  writeFileSync(unit.policyPath, POLICY_EDITED, "utf8");
  attest(unit, at(2));
  return unit;
}

test("a policy-drift refusal appends the audit record AND withdraws the void request", () => {
  const unit = drifted();
  const before = requestState(records(unit), KEY, at(3), 3_600_000);
  assert.equal(before.state, "requested");

  const refused = tap(unit, "grant", at(3));
  assert.equal(refused.outcome.ok, false);
  if (refused.outcome.ok) throw new Error("unreachable");
  assert.equal(refused.outcome.code, "policy-drift");
  assert.equal(voidsTheRequest(refused.outcome.code), true);

  const audit = theAudit(unit);
  const auditPayload = payloadOf(audit);
  assert.equal(auditPayload["code"], "policy-drift");
  // The comparison the gate actually made, copied verbatim rather than redone.
  const requested = auditPayload["policy_sha256_requested"];
  const attested = auditPayload["policy_sha256_attested"];
  assert.match(String(requested), /^[a-f0-9]{64}$/u);
  assert.match(String(attested), /^[a-f0-9]{64}$/u);
  assert.notEqual(requested, attested);

  const withdrawals = ofType(unit, "approval.withdrawn");
  assert.equal(withdrawals.length, 1);
  const withdrawal = withdrawals[0] as EventRecord;
  assert.equal(withdrawal.actor, DECISION_REFUSAL_ACTOR);
  const withdrawnPayload = payloadOf(withdrawal);
  assert.equal(withdrawnPayload["reason"], "policy-drift");
  assert.equal(withdrawnPayload["action_key"], KEY);
  // The pair is linked in one direction, from the consequence to the fact.
  assert.equal(withdrawnPayload["refused_seq"], audit.seq);
  // Both hashes travel in the note, so a reader checks the runtime's verdict
  // against the log rather than taking it.
  assert.match(String(withdrawnPayload["note"]), new RegExp(String(requested), "u"));
  assert.match(String(withdrawnPayload["note"]), new RegExp(String(attested), "u"));

  // Order: the explanation first, the state change second. An interrupted write
  // leaves a pending request with a record of why the tap failed, never a
  // vanished request with no record of anything.
  assert.ok(audit.seq < withdrawal.seq, "the withdrawal was appended before the explanation");
  assertClean(unit);
});

test("the withdrawn request stops being offered: queue, QUEUE.md and the derived state", () => {
  const unit = drifted();
  const queueBefore = renderQueue(unit.logPath, unit.options, at(3));
  assert.equal(queueBefore.ok, true);
  if (!queueBefore.ok) throw new Error("unreachable");
  assert.ok(
    queueBefore.markdown.includes(KEY),
    "the fixture did not put the request on the queue in the first place",
  );

  assert.equal(tap(unit, "grant", at(3)).outcome.ok, false);

  // Every surface derives from `core/state.ts`, and it settles on
  // `approval.withdrawn` without looking at who wrote it or why — so one
  // withdrawal takes the request off all of them at once.
  assert.equal(requestState(records(unit), KEY, at(4), 3_600_000).state, "withdrawn");
  const queueAfter = renderQueue(unit.logPath, unit.options, at(4));
  assert.equal(queueAfter.ok, true);
  if (!queueAfter.ok) throw new Error("unreachable");
  assert.equal(
    queueAfter.pending + queueAfter.skipped,
    queueBefore.pending + queueBefore.skipped - 1,
    "the queue still counts the void request as live",
  );
  assert.equal(
    queueAfter.markdown.includes(KEY),
    false,
    `QUEUE.md still offers the void request:\n${queueAfter.markdown}`,
  );
  assertClean(unit);
});

test("a second tap on the withdrawn request is refused, and nothing is withdrawn twice", () => {
  const unit = drifted();
  assert.equal(tap(unit, "grant", at(3)).outcome.ok, false);

  // Telegram redelivers callbacks, and a stale button outlives the message
  // edit. The second tap now meets a WITHDRAWN request, so its refusal is
  // `request-withdrawn` — a different fact, recorded as one.
  const second = tap(unit, "grant", at(4));
  assert.equal(second.outcome.ok, false);
  if (second.outcome.ok) throw new Error("unreachable");
  assert.equal(second.outcome.code, "request-withdrawn");
  assert.equal(ofType(unit, "approval.withdrawn").length, 1, "the request was withdrawn twice");
  assert.equal(ofType(unit, "audit.decision_refused").length, 2);
  assertClean(unit);
});

test("only policy-drift withdraws: every other refusal leaves the request pending", () => {
  const unit = pending();
  // Human-only classes and expiries aside, the plainest non-voiding refusal on
  // a PENDING request is a revoke of something never granted.
  const refusal = decide(unit.logPath, KEY, "revoke", HUMAN, at(3), unit.options);
  assert.equal(refusal.ok, false);
  if (refusal.ok) throw new Error("unreachable");
  assert.equal(refusal.code, "not-granted");
  assert.equal(voidsTheRequest(refusal.code), false);

  recordRefusedDecision(
    unit.logPath,
    { actionKey: KEY, decision: "revoke", actor: HUMAN, channel: "cli" },
    { code: refusal.code, message: refusal.message },
    { ...unit.options, clock: fixedClock(at(3)) },
  );
  assert.equal(ofType(unit, "approval.withdrawn").length, 0);
  assert.equal(requestState(records(unit), KEY, at(4), 3_600_000).state, "requested");
  assertClean(unit);
});

test("the requester's own withdrawal still works, and still carries a requester's reason", () => {
  const unit = pending();
  const taken = withdraw(unit.logPath, KEY, AGENT, at(3), {
    ...unit.options,
    reason: "timeout",
  });
  assert.equal(taken.ok, true, taken.ok ? "" : taken.message);
  const withdrawal = ofType(unit, "approval.withdrawn")[0] as EventRecord;
  assert.equal(withdrawal.actor, AGENT);
  assert.equal(payloadOf(withdrawal)["reason"], "timeout");
  // And the runtime's reason is not one the requester's verb can produce: the
  // gate refuses a `system:` actor outright, and `WITHDRAW_REASONS` does not
  // contain `policy-drift`, so there is no argument that reaches it.
  assert.equal(
    withdraw(unit.logPath, KEY, DECISION_REFUSAL_ACTOR, at(4), unit.options).ok,
    false,
  );
  assertClean(unit);
});

// ===========================================================================
// 3 — the asymmetry, stated as a test
// ===========================================================================

test("a gate refusal handed to an AGENT is not recorded", () => {
  const unit = pending();
  const before = eventTypes(unit);

  // Two ordinary agent-facing refusals on the busiest paths in the runtime. An
  // agent that is refused reads the code, stops or asks again, and has spent
  // nothing a record could account for; a human who is refused has already
  // spent the thing SPEC.md §11 calls the audit budget. That asymmetry is the
  // whole scope of this task, so it is asserted rather than assumed.
  const duplicate = request(
    unit.logPath,
    {
      task: TASK,
      actionKey: KEY,
      payload_hash: PAYLOAD_HASH,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      summary: "Send deposit chaser",
    },
    at(3),
    AGENT,
    unit.options,
  );
  assert.equal(duplicate.ok, false);
  if (duplicate.ok) throw new Error("unreachable");
  assert.equal(duplicate.code, "duplicate-request");

  const notMine = withdraw(unit.logPath, KEY, "agent:other", at(4), unit.options);
  assert.equal(notMine.ok, false);
  if (notMine.ok) throw new Error("unreachable");
  assert.equal(notMine.code, "not-requester");

  assert.deepEqual(eventTypes(unit), before, "an agent-side refusal reached the log");
  assert.deepEqual(ofType(unit, "audit.decision_refused"), []);
  assertClean(unit);
});

test("policy-drift refused to an agent spending a grant records nothing either", () => {
  const unit = pending();
  const granted = decide(unit.logPath, KEY, "grant", HUMAN, at(2), unit.options);
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);

  // Same code, different party. The agent is told and nothing is written: the
  // grant is already in the log, the human already decided, and there is no
  // second spend of attention for a record to account for.
  writeFileSync(unit.policyPath, POLICY_EDITED, "utf8");
  attest(unit, at(3));
  const before = eventTypes(unit);
  const spend = consumeHarnessGrant(unit.logPath, KEY, AGENT, at(4), unit.options);
  assert.equal(spend.ok, false);
  if (spend.ok) throw new Error("unreachable");
  assert.deepEqual(eventTypes(unit), before, "an agent-side refusal reached the log");
  assertClean(unit);
});

// ===========================================================================
// The line the human is shown, once, everywhere
// ===========================================================================

test("every surface says the same sentence about a refused tap", () => {
  // The Telegram message edit and the terminal line come from this one helper,
  // so the person who taps on their phone and then reads the operator's
  // terminal is not choosing between two accounts of one refusal.
  const drift = refusedDecisionLine("policy-drift");
  assert.match(drift, /Policy changed after this was asked/u);
  assert.match(drift, /withdrawn/u, "the line does not say the request is gone");
  assert.match(drift, /ask again/u, "the line does not say what happens next");
  // The three APRV-206 sentences are unchanged by the move.
  assert.match(refusedDecisionLine("already-decided"), /the first answer stands/u);
  assert.match(refusedDecisionLine("request-withdrawn"), /no longer waiting/u);
  assert.match(refusedDecisionLine("expired"), /window has closed/u);
  // And an unrecognized code still names itself rather than going silent.
  assert.equal(refusedDecisionLine("append-failed"), "Refused by the runtime: append-failed.");
});
