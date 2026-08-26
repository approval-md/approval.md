/**
 * The envelope's own cap: `budget.max_cost_usd` (SPEC.md §6.2, item S2).
 *
 * > `budget` | MAY | Task-level caps, conjunctive with policy budgets.
 *
 * Until now the field validated and did nothing. It is enforced here at all
 * three of the moments policy budgets are enforced — intake (`gate.request`),
 * grant (`gate.decide`), and execution start (`execute.startExecution`) —
 * because a cap enforced at only one door is a cap a caller can route around by
 * choosing another.
 *
 * Two properties distinguish it from the policy budgets beside it:
 *
 * - **Commitment-based, same consumption rules.** `approval.granted` charges;
 *   `execution.started` charges only where no grant carries the same key, so a
 *   manual action granted and then started is charged once.
 * - **Lifetime, not windowed.** "maximum total spend across this task's
 *   actions" is not a rolling 24 hours: a task cap cannot be spent twice by
 *   waiting a day.
 *
 * `max_latency` remains unenforced by design — the spec note for it lands in
 * APRV-21, and this task does nothing with it.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  evaluateBudgetsWithTask,
  taskMaxCostUsd,
  TASK_MAX_COST_USD,
} from "../src/core/budgets.js";
import { startExecution } from "../src/core/execute.js";
import { decide, register, request, type GateRefusal } from "../src/core/gate.js";
import type { ExecuteRefusal } from "../src/core/execute.js";
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

const { root, cleanup } = scratchRoot("task-budget");
after(cleanup);

const BOUND = "e".repeat(64);

/** No policy budgets at all: whatever refuses below is the ENVELOPE's doing. */
const POLICY_UNLIMITED = [
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "24h"',
  "classes:",
  "  files.write.*:",
  "    autonomy: supervised",
  "  communicate.email.external:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

interface Action {
  key: string;
  cls: string;
  cost: number;
  reversible: boolean;
}

const MANUAL_A: Action = {
  key: "task-042:a",
  cls: "communicate.email.external",
  cost: 0.3,
  reversible: false,
};
const MANUAL_B: Action = {
  key: "task-042:b",
  cls: "communicate.email.external",
  cost: 0.3,
  reversible: false,
};
const SUPERVISED: Action = {
  key: "task-042:draft",
  cls: "files.write.local",
  cost: 0.3,
  reversible: true,
};

function envelope(cap: number | null): unknown {
  return {
    origin: { app: "example-capture", created_by: "human:carter" },
    state: "proposed",
    actions: [MANUAL_A, MANUAL_B, SUPERVISED].map((action) => ({
      class: action.cls,
      reversible: action.reversible,
      est_cost_usd: action.cost,
      idempotency_key: action.key,
      payload_hash: BOUND,
    })),
    ...(cap === null ? {} : { budget: { max_cost_usd: cap, max_latency: "6h" } }),
  };
}

function ready(cap: number | null): Scenario {
  const unit = newScenario(root, POLICY_UNLIMITED);
  attest(unit);
  const registered = register(
    unit.logPath,
    { task: "task-042", envelope: envelope(cap) },
    "agent:claude",
    { ...unit.options, clock: fixedClock(T0) },
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);
  return unit;
}

function requestAction(unit: Scenario, action: Action, minute: number) {
  return request(
    unit.logPath,
    {
      task: "task-042",
      actionKey: action.key,
      cls: action.cls,
      est_cost_usd: action.cost,
      reversible: action.reversible,
    },
    "agent:claude",
    { ...unit.options, clock: fixedClock(at(minute)) },
  );
}

function grant(unit: Scenario, action: Action, minute: number) {
  return decide(unit.logPath, action.key, "grant", "human:carter", {
    ...unit.options,
    clock: fixedClock(at(minute)),
  });
}

// ---------------------------------------------------------------------------
// Reading the cap
// ---------------------------------------------------------------------------

test("the cap is read from the LOG's registration, not from the task file", () => {
  const unit = ready(0.5);
  assert.equal(taskMaxCostUsd(records(unit), "task-042"), 0.5);
  assert.equal(taskMaxCostUsd(records(unit), "task-999"), null);

  // The whole `budget` block is copied, so the M4/M5 enforcement of
  // `max_latency` reads a log that already carries it.
  const registration = records(unit).find((record) => record.event === "task.registered");
  assert.deepEqual(payloadOf(registration!)["budget"], { max_cost_usd: 0.5, max_latency: "6h" });
});

test("a task with no budget block is unaffected", () => {
  const unit = ready(null);
  assert.equal(taskMaxCostUsd(records(unit), "task-042"), null);

  for (const action of [MANUAL_A, MANUAL_B]) {
    assert.equal(requestAction(unit, action, 1).ok, true);
  }
  assert.equal(grant(unit, MANUAL_A, 2).ok, true);
  assert.equal(grant(unit, MANUAL_B, 3).ok, true, "an uncapped task refused a grant");
  assertClean(unit);
});

// ---------------------------------------------------------------------------
// The three enforcement points
// ---------------------------------------------------------------------------

test("the cap refuses at INTAKE, appends budget.exceeded, and names a task verdict", () => {
  // Cap 0.5; A alone is 0.3, so A fits and B (0.3 more) does not.
  const unit = ready(0.5);
  assert.equal(requestAction(unit, MANUAL_A, 1).ok, true);
  assert.equal(grant(unit, MANUAL_A, 2).ok, true);

  const refusal = requestAction(unit, MANUAL_B, 3) as GateRefusal;
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, "budget-exceeded");
  assert.deepEqual(
    (refusal.verdicts ?? []).map((verdict) => [verdict.limit, verdict.scope, verdict.window]),
    [[TASK_MAX_COST_USD, "task", "task-total"]],
  );

  // A budget refusal is a fact an operator must be able to see afterwards.
  const last = records(unit)[records(unit).length - 1];
  assert.equal(last?.event, "budget.exceeded");
  assert.equal(payloadOf(last!)["stage"], "request");
  assertClean(unit);
});

test("the cap refuses at GRANT, even when intake passed before the queue moved", () => {
  const unit = ready(0.5);
  // Both requested while the task had spent nothing: intake admits both.
  assert.equal(requestAction(unit, MANUAL_A, 1).ok, true);
  assert.equal(requestAction(unit, MANUAL_B, 1).ok, true);

  assert.equal(grant(unit, MANUAL_A, 2).ok, true);
  const refusal = grant(unit, MANUAL_B, 3) as GateRefusal;
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, "budget-exceeded");
  assert.deepEqual((refusal.verdicts ?? []).map((verdict) => verdict.limit), [TASK_MAX_COST_USD]);

  const last = records(unit)[records(unit).length - 1];
  assert.equal(last?.event, "budget.exceeded");
  assert.equal(payloadOf(last!)["stage"], "grant");
  assertClean(unit);
});

test("the cap refuses at EXECUTION START for an action that never passes a grant", () => {
  const unit = ready(0.5);
  assert.equal(requestAction(unit, MANUAL_A, 1).ok, true);
  assert.equal(grant(unit, MANUAL_A, 2).ok, true);

  // Supervised: no approval events exist, so execution.started IS the
  // authorization — and the task cap binds there or nowhere.
  const refusal = startExecution(
    unit.logPath,
    SUPERVISED.key,
    { ...unit.options, presentedPayloadHash: BOUND, clock: fixedClock(at(3)) },
    "agent:claude",
  ) as ExecuteRefusal;
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, "budget-exceeded");
  assert.deepEqual((refusal.verdicts ?? []).map((verdict) => verdict.limit), [TASK_MAX_COST_USD]);
  assert.equal(eventTypes(unit).includes("execution.started"), false);
  assertClean(unit);
});

// ---------------------------------------------------------------------------
// Summing, and not double-counting
// ---------------------------------------------------------------------------

test("a multi-action task sums, and a granted-then-started action is charged once", () => {
  // Cap 0.8 against three $0.30 actions: two fit, the third does not.
  const unit = ready(0.8);
  assert.equal(requestAction(unit, MANUAL_A, 1).ok, true);
  const granted = grant(unit, MANUAL_A, 2);
  assert.equal(granted.ok, true);
  if (!granted.ok || granted.token === undefined) throw new Error("expected a token");

  const probe = { class: MANUAL_A.cls, est_cost_usd: 0 };
  const afterGrant = evaluateBudgetsWithTask(
    records(unit),
    { classLimits: null, classPattern: null, globalBudgets: null },
    probe,
    at(3),
    "task-042",
  );
  assert.equal(afterGrant.verdicts[0]?.consumed, 0.3);

  // Spend the token: the manual action's start must NOT charge the task again.
  assert.equal(
    startExecution(
      unit.logPath,
      MANUAL_A.key,
      {
        ...unit.options,
        token: granted.token,
        presentedPayloadHash: BOUND,
        clock: fixedClock(at(3)),
      },
      "agent:claude",
    ).ok,
    true,
  );
  const afterStart = evaluateBudgetsWithTask(
    records(unit),
    { classLimits: null, classPattern: null, globalBudgets: null },
    probe,
    at(4),
    "task-042",
  );
  assert.equal(afterStart.verdicts[0]?.consumed, 0.3, "the manual action was charged twice");

  // A second action still fits (0.6 of 0.8); the third takes it to 0.9.
  assert.equal(requestAction(unit, MANUAL_B, 4).ok, true);
  assert.equal(grant(unit, MANUAL_B, 5).ok, true);
  const third = startExecution(
    unit.logPath,
    SUPERVISED.key,
    { ...unit.options, presentedPayloadHash: BOUND, clock: fixedClock(at(6)) },
    "agent:claude",
  ) as ExecuteRefusal;
  assert.equal(third.ok, false);
  assert.equal(third.code, "budget-exceeded");
  assertClean(unit);
});

test("the cap is a LIFETIME total: waiting a day does not restore it", () => {
  const unit = ready(0.5);
  assert.equal(requestAction(unit, MANUAL_A, 1).ok, true);
  assert.equal(grant(unit, MANUAL_A, 2).ok, true);

  // A full rolling window later — every policy budget would have reset.
  const tomorrow = 60 * 25;
  const refusal = requestAction(unit, MANUAL_B, tomorrow) as GateRefusal;
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, "budget-exceeded");
  assert.deepEqual((refusal.verdicts ?? []).map((verdict) => verdict.limit), [TASK_MAX_COST_USD]);
  assertClean(unit);
});

test("the task verdict is conjunctive with the policy verdicts and reported last", () => {
  const unit = ready(0.5);
  const verdicts = evaluateBudgetsWithTask(
    records(unit),
    {
      classLimits: { per_action_usd: 10 },
      classPattern: "communicate.email.external",
      globalBudgets: { global: { daily_usd: 10 } },
    },
    { class: MANUAL_A.cls, est_cost_usd: 0.3 },
    at(1),
    "task-042",
  );
  assert.deepEqual(
    verdicts.verdicts.map((verdict) => [verdict.scope, verdict.limit]),
    [
      ["class", "per_action_usd"],
      ["global", "global.daily_usd"],
      ["task", TASK_MAX_COST_USD],
    ],
  );
  assert.equal(verdicts.pass, true);
});
