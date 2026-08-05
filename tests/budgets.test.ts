/**
 * Budget evaluation tests (APRV-14).
 *
 * Every record consumed by the evaluator here is built through the real
 * `appendEvent` path — schema-validated, hash-chained, written to a scratch
 * log — so the evaluator is never fed a hand-assembled object literal the write
 * boundary would have rejected. Nothing in this file mutates a log; records are
 * collected from the append results in order.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  evaluateBudgets,
  WINDOW_MS,
  type BudgetScope,
  type BudgetVerdict,
} from "../src/core/budgets.js";
import { appendEvent, type EventInput, type EventRecord } from "../src/core/log.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-budgets-"));
let scratchCounter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Append a sequence of events to a fresh log and return the real records. */
function log(...inputs: EventInput[]): EventRecord[] {
  scratchCounter += 1;
  const path = join(scratch, `log-${String(scratchCounter)}`, "events.jsonl");
  const records: EventRecord[] = [];
  for (const input of inputs) {
    const result = appendEvent(path, input);
    assert.equal(result.ok, true, `append failed: ${result.ok ? "" : result.error.message}`);
    if (result.ok) records.push(result.record);
  }
  return records;
}

const EVAL_TS = "2026-08-05T12:00:00Z";

/** ISO timestamp `ms` milliseconds before {@link EVAL_TS}. */
function before(ms: number): string {
  return new Date(Date.parse(EVAL_TS) - ms).toISOString();
}

let keyCounter = 0;

/** A human grant of `actionClass` costing `cost`, at `ts`. */
function grant(actionClass: string, cost: number | null, ts: string, key?: string): EventInput {
  keyCounter += 1;
  const payload: Record<string, unknown> = { class: actionClass };
  if (cost !== null) payload["est_cost_usd"] = cost;
  return {
    ts,
    event: "approval.granted",
    actor: "human:carter",
    task: "task-042",
    action_key: key ?? `task-042:action-${String(keyCounter)}`,
    payload,
  };
}

/** An agent start of `actionClass` costing `cost`, at `ts`. */
function started(actionClass: string, cost: number | null, ts: string, key?: string): EventInput {
  keyCounter += 1;
  const payload: Record<string, unknown> = { class: actionClass };
  if (cost !== null) payload["est_cost_usd"] = cost;
  return {
    ts,
    event: "execution.started",
    actor: "agent:runner",
    task: "task-042",
    action_key: key ?? `task-042:action-${String(keyCounter)}`,
    payload,
  };
}

/** An event type that must never consume budget. */
function nonConsuming(
  event: "approval.rejected" | "approval.expired" | "execution.completed" | "execution.failed",
  actionClass: string,
  cost: number,
  ts: string,
): EventInput {
  keyCounter += 1;
  return {
    ts,
    event,
    actor: event === "approval.rejected" ? "human:carter" : "system:runtime",
    task: "task-042",
    action_key: `task-042:action-${String(keyCounter)}`,
    payload: { class: actionClass, est_cost_usd: cost },
  };
}

/** A scope with class limits under `financial.*` and no global budgets. */
function classScope(limits: Record<string, number>, pattern = "financial.*"): BudgetScope {
  return { classLimits: limits, classPattern: pattern, globalBudgets: null };
}

/** A scope with global budgets only. */
function globalScope(budgets: NonNullable<BudgetScope["globalBudgets"]>): BudgetScope {
  return { classLimits: null, classPattern: null, globalBudgets: budgets };
}

function verdictFor(verdicts: BudgetVerdict[], limit: string): BudgetVerdict {
  const found = verdicts.find((entry) => entry.limit === limit);
  assert.ok(found !== undefined, `no verdict for ${limit}`);
  return found;
}

// --- per_action_usd ------------------------------------------------------

test("per_action_usd passes at or under the limit and is a per-action window", () => {
  const result = evaluateBudgets(
    [],
    classScope({ per_action_usd: 25 }),
    { class: "financial.spend", est_cost_usd: 25 },
    EVAL_TS,
  );
  assert.equal(result.pass, true);
  const entry = verdictFor(result.verdicts, "per_action_usd");
  assert.equal(entry.window, "per-action");
  assert.equal(entry.scope, "class");
  assert.equal(entry.consumed, 0);
  assert.equal(entry.requested, 25);
  assert.equal(entry.remaining, 0);
});

test("per_action_usd fails over the limit and reports negative headroom", () => {
  const result = evaluateBudgets(
    [],
    classScope({ per_action_usd: 25 }),
    { class: "financial.spend", est_cost_usd: 25.01 },
    EVAL_TS,
  );
  assert.equal(result.pass, false);
  assert.equal(verdictFor(result.verdicts, "per_action_usd").remaining, -0.01);
});

test("per_action_usd with no declared est_cost_usd requests 0 and passes", () => {
  const result = evaluateBudgets(
    [],
    classScope({ per_action_usd: 25 }),
    { class: "financial.spend" },
    EVAL_TS,
  );
  assert.equal(result.pass, true);
  assert.equal(verdictFor(result.verdicts, "per_action_usd").requested, 0);
});

// --- daily_usd -----------------------------------------------------------

test("daily_usd sums consumed authorizations in the window", () => {
  const records = log(
    grant("financial.spend", 10, before(6 * 60 * 60 * 1000)),
    grant("financial.spend", 15.5, before(3 * 60 * 60 * 1000)),
  );
  const result = evaluateBudgets(
    records,
    classScope({ daily_usd: 100 }),
    { class: "financial.spend", est_cost_usd: 20 },
    EVAL_TS,
  );
  const entry = verdictFor(result.verdicts, "daily_usd");
  assert.equal(entry.window, "rolling-24h");
  assert.equal(entry.consumed, 25.5);
  assert.equal(entry.requested, 20);
  assert.equal(entry.remaining, 54.5);
  assert.equal(result.pass, true);
});

test("daily_usd admits the action that lands exactly on the limit and refuses the next cent", () => {
  const records = log(grant("financial.spend", 90, before(60 * 60 * 1000)));
  const exact = evaluateBudgets(
    records,
    classScope({ daily_usd: 100 }),
    { class: "financial.spend", est_cost_usd: 10 },
    EVAL_TS,
  );
  assert.equal(exact.pass, true);
  assert.equal(verdictFor(exact.verdicts, "daily_usd").remaining, 0);

  const over = evaluateBudgets(
    records,
    classScope({ daily_usd: 100 }),
    { class: "financial.spend", est_cost_usd: 10.01 },
    EVAL_TS,
  );
  assert.equal(over.pass, false);
  assert.equal(verdictFor(over.verdicts, "daily_usd").remaining, -0.01);
});

test("a consuming event with no est_cost_usd adds 0 USD but still counts as one action", () => {
  const records = log(grant("financial.spend", null, before(60 * 60 * 1000)));
  const usd = evaluateBudgets(
    records,
    classScope({ daily_usd: 100 }),
    { class: "financial.spend", est_cost_usd: 1 },
    EVAL_TS,
  );
  assert.equal(verdictFor(usd.verdicts, "daily_usd").consumed, 0);

  const actions = evaluateBudgets(
    records,
    classScope({ daily_actions: 5 }),
    { class: "financial.spend" },
    EVAL_TS,
  );
  assert.equal(verdictFor(actions.verdicts, "daily_actions").consumed, 1);
});

// --- daily_actions -------------------------------------------------------

test("daily_actions counts authorizations and charges the pending action as one", () => {
  const records = log(
    grant("financial.spend", 1, before(5 * 60 * 60 * 1000)),
    started("financial.spend", 1, before(4 * 60 * 60 * 1000)),
    grant("financial.spend", 1, before(3 * 60 * 60 * 1000)),
  );
  const result = evaluateBudgets(
    records,
    globalScope({ global: { daily_actions: 200 } }),
    { class: "financial.spend" },
    EVAL_TS,
  );
  const entry = verdictFor(result.verdicts, "global.daily_actions");
  assert.equal(entry.scope, "global");
  assert.equal(entry.consumed, 3);
  assert.equal(entry.requested, 1);
  assert.equal(entry.remaining, 196);
});

test("N grants inside the window with zero completions trip daily_actions at N", () => {
  // Five authorized-but-never-completed actions must exhaust a limit of five.
  // Metering completion instead of authorization would leave the budget at
  // zero consumed and admit an unbounded queue of hung executions.
  const inputs = [0, 1, 2, 3, 4].map((index) =>
    grant("financial.spend", 1, before((10 - index) * 60 * 60 * 1000)),
  );
  const records = log(...inputs);

  const fifth = evaluateBudgets(
    records.slice(0, 4),
    globalScope({ global: { daily_actions: 5 } }),
    { class: "financial.spend" },
    EVAL_TS,
  );
  assert.equal(fifth.pass, true, "the fifth action fills the budget exactly");
  assert.equal(verdictFor(fifth.verdicts, "global.daily_actions").remaining, 0);

  const sixth = evaluateBudgets(
    records,
    globalScope({ global: { daily_actions: 5 } }),
    { class: "financial.spend" },
    EVAL_TS,
  );
  assert.equal(sixth.pass, false, "the sixth action is refused");
  const entry = verdictFor(sixth.verdicts, "global.daily_actions");
  assert.equal(entry.consumed, 5);
  assert.equal(entry.requested, 1);
  assert.equal(entry.remaining, -1);
});

// --- what does not consume ----------------------------------------------

test("rejected and expired approvals consume nothing", () => {
  const records = log(
    nonConsuming("approval.rejected", "financial.spend", 40, before(60 * 60 * 1000)),
    nonConsuming("approval.expired", "financial.spend", 40, before(30 * 60 * 1000)),
  );
  const result = evaluateBudgets(
    records,
    globalScope({ global: { daily_usd: 100, daily_actions: 2 } }),
    { class: "financial.spend", est_cost_usd: 10 },
    EVAL_TS,
  );
  assert.equal(result.pass, true);
  assert.equal(verdictFor(result.verdicts, "global.daily_usd").consumed, 0);
  assert.equal(verdictFor(result.verdicts, "global.daily_actions").consumed, 0);
});

test("a window full of completions with no authorizations consumes nothing", () => {
  const records = log(
    nonConsuming("execution.completed", "financial.spend", 50, before(5 * 60 * 60 * 1000)),
    nonConsuming("execution.completed", "financial.spend", 50, before(4 * 60 * 60 * 1000)),
    nonConsuming("execution.failed", "financial.spend", 50, before(3 * 60 * 60 * 1000)),
  );
  const result = evaluateBudgets(
    records,
    globalScope({ global: { daily_usd: 100, daily_actions: 1 } }),
    { class: "financial.spend", est_cost_usd: 99 },
    EVAL_TS,
  );
  assert.equal(result.pass, true);
  assert.equal(verdictFor(result.verdicts, "global.daily_usd").consumed, 0);
  assert.equal(verdictFor(result.verdicts, "global.daily_actions").consumed, 0);
});

// --- window edges --------------------------------------------------------

test("an event exactly 24h before the evaluation instant has aged out", () => {
  const records = log(grant("financial.spend", 40, before(WINDOW_MS)));
  const result = evaluateBudgets(
    records,
    globalScope({ global: { daily_usd: 100 } }),
    { class: "financial.spend", est_cost_usd: 1 },
    EVAL_TS,
  );
  assert.equal(verdictFor(result.verdicts, "global.daily_usd").consumed, 0);
});

test("an event one millisecond inside the lower bound counts", () => {
  const records = log(grant("financial.spend", 40, before(WINDOW_MS - 1)));
  const result = evaluateBudgets(
    records,
    globalScope({ global: { daily_usd: 100 } }),
    { class: "financial.spend", est_cost_usd: 1 },
    EVAL_TS,
  );
  assert.equal(verdictFor(result.verdicts, "global.daily_usd").consumed, 40);
});

test("an event stamped at the evaluation instant counts", () => {
  const records = log(grant("financial.spend", 40, EVAL_TS));
  const result = evaluateBudgets(
    records,
    globalScope({ global: { daily_usd: 100 } }),
    { class: "financial.spend", est_cost_usd: 1 },
    EVAL_TS,
  );
  assert.equal(verdictFor(result.verdicts, "global.daily_usd").consumed, 40);
});

test("an event after the evaluation instant does not count", () => {
  const records = log(grant("financial.spend", 40, before(-1000)));
  const result = evaluateBudgets(
    records,
    globalScope({ global: { daily_usd: 100 } }),
    { class: "financial.spend", est_cost_usd: 1 },
    EVAL_TS,
  );
  assert.equal(verdictFor(result.verdicts, "global.daily_usd").consumed, 0);
});

test("a burst straddling midnight all counts at 01:30, which a calendar day would have reset", () => {
  const records = log(
    grant("financial.spend", 30, "2026-08-04T23:00:00Z"),
    grant("financial.spend", 30, "2026-08-04T23:45:00Z"),
    grant("financial.spend", 30, "2026-08-05T00:15:00Z"),
    grant("financial.spend", 30, "2026-08-05T01:00:00Z"),
  );
  const result = evaluateBudgets(
    records,
    globalScope({ global: { daily_usd: 100 } }),
    { class: "financial.spend", est_cost_usd: 1 },
    "2026-08-05T01:30:00Z",
  );
  assert.equal(verdictFor(result.verdicts, "global.daily_usd").consumed, 120);
  assert.equal(result.pass, false, "the rolling window sees all four; a calendar day would see two");
});

// --- double-count guard --------------------------------------------------

test("a manual action granted and then started is charged once", () => {
  const key = "task-042:chaser:2026-08-05";
  const records = log(
    grant("financial.spend", 40, before(2 * 60 * 60 * 1000), key),
    started("financial.spend", 40, before(60 * 60 * 1000), key),
  );
  const result = evaluateBudgets(
    records,
    globalScope({ global: { daily_usd: 100, daily_actions: 10 } }),
    { class: "financial.spend", est_cost_usd: 1 },
    EVAL_TS,
  );
  assert.equal(verdictFor(result.verdicts, "global.daily_usd").consumed, 40);
  assert.equal(verdictFor(result.verdicts, "global.daily_actions").consumed, 1);
});

test("a supervised start with no matching grant is its own authorization", () => {
  const records = log(
    grant("financial.spend", 40, before(2 * 60 * 60 * 1000), "task-042:a"),
    started("financial.spend", 40, before(60 * 60 * 1000), "task-042:b"),
  );
  const result = evaluateBudgets(
    records,
    globalScope({ global: { daily_usd: 200, daily_actions: 10 } }),
    { class: "financial.spend", est_cost_usd: 1 },
    EVAL_TS,
  );
  assert.equal(verdictFor(result.verdicts, "global.daily_usd").consumed, 80);
  assert.equal(verdictFor(result.verdicts, "global.daily_actions").consumed, 2);
});

// --- class-pattern scoping ----------------------------------------------

test("a financial.* class limit consumes financial.spend but not communicate.email.external", () => {
  const records = log(
    grant("financial.spend", 40, before(3 * 60 * 60 * 1000)),
    grant("communicate.email.external", 40, before(2 * 60 * 60 * 1000)),
    grant("financial.transfer", 5, before(60 * 60 * 1000)),
  );
  const result = evaluateBudgets(
    records,
    classScope({ daily_usd: 100 }),
    { class: "financial.spend", est_cost_usd: 1 },
    EVAL_TS,
  );
  // 40 + 5 from the two financial.* authorizations; the email is another rule's.
  assert.equal(verdictFor(result.verdicts, "daily_usd").consumed, 45);
});

test("global budgets charge every authorization regardless of class", () => {
  const records = log(
    grant("financial.spend", 40, before(3 * 60 * 60 * 1000)),
    grant("communicate.email.external", 40, before(2 * 60 * 60 * 1000)),
  );
  const result = evaluateBudgets(
    records,
    globalScope({ global: { daily_usd: 100 } }),
    { class: "financial.spend", est_cost_usd: 1 },
    EVAL_TS,
  );
  assert.equal(verdictFor(result.verdicts, "global.daily_usd").consumed, 80);
});

test("an authorization with no payload.class is invisible to class limits but not to global ones", () => {
  const records = log({
    ts: before(60 * 60 * 1000),
    event: "approval.granted",
    actor: "human:carter",
    task: "task-042",
    action_key: "task-042:unclassed",
    payload: { est_cost_usd: 40 },
  });
  const scoped = evaluateBudgets(
    records,
    classScope({ daily_usd: 100 }),
    { class: "financial.spend", est_cost_usd: 1 },
    EVAL_TS,
  );
  assert.equal(verdictFor(scoped.verdicts, "daily_usd").consumed, 0);

  const global = evaluateBudgets(
    records,
    globalScope({ global: { daily_usd: 100 } }),
    { class: "financial.spend", est_cost_usd: 1 },
    EVAL_TS,
  );
  assert.equal(verdictFor(global.verdicts, "global.daily_usd").consumed, 40);
});

// --- fail-closed ---------------------------------------------------------

test("an unknown class limit name fails closed with a note", () => {
  const result = evaluateBudgets(
    [],
    classScope({ weekly_usd: 500 }),
    { class: "financial.spend", est_cost_usd: 1 },
    EVAL_TS,
  );
  assert.equal(result.pass, false);
  const entry = verdictFor(result.verdicts, "weekly_usd");
  assert.equal(entry.pass, false);
  assert.equal(entry.window, "per-action");
  assert.equal(entry.consumed, 0);
  assert.ok(entry.note !== undefined && entry.note.includes("weekly_usd"));
});

test("an unknown global budget limit name fails closed with a note", () => {
  const result = evaluateBudgets(
    [],
    globalScope({ global: { monthly_usd: 500 } } as NonNullable<BudgetScope["globalBudgets"]>),
    { class: "financial.spend", est_cost_usd: 1 },
    EVAL_TS,
  );
  assert.equal(result.pass, false);
  assert.equal(verdictFor(result.verdicts, "global.monthly_usd").pass, false);
});

test("a class rolling limit without its class pattern fails closed", () => {
  const result = evaluateBudgets(
    [],
    { classLimits: { daily_usd: 100 }, classPattern: null, globalBudgets: null },
    { class: "financial.spend", est_cost_usd: 1 },
    EVAL_TS,
  );
  assert.equal(result.pass, false);
  assert.ok(verdictFor(result.verdicts, "daily_usd").note !== undefined);
});

test("an unparseable evaluation timestamp refuses every applicable limit", () => {
  const result = evaluateBudgets(
    [],
    { classLimits: { per_action_usd: 25 }, classPattern: "financial.*", globalBudgets: { global: { daily_usd: 100 } } },
    { class: "financial.spend", est_cost_usd: 1 },
    "not-a-timestamp",
  );
  assert.equal(result.pass, false);
  assert.equal(result.verdicts.length, 2);
  for (const entry of result.verdicts) {
    assert.equal(entry.pass, false);
    assert.ok(entry.note !== undefined);
  }
});

test("no applicable limits at all is a vacuous pass", () => {
  const result = evaluateBudgets(
    [],
    { classLimits: null, classPattern: null, globalBudgets: null },
    { class: "financial.spend", est_cost_usd: 1000 },
    EVAL_TS,
  );
  assert.deepEqual(result, { pass: true, verdicts: [] });
});

// --- conjunction and determinism ----------------------------------------

test("one failing limit fails the whole evaluation", () => {
  const records = log(grant("financial.spend", 95, before(60 * 60 * 1000)));
  const result = evaluateBudgets(
    records,
    {
      classLimits: { per_action_usd: 25, daily_usd: 100 },
      classPattern: "financial.*",
      globalBudgets: { global: { daily_usd: 1000, daily_actions: 200 } },
    },
    { class: "financial.spend", est_cost_usd: 10 },
    EVAL_TS,
  );
  assert.equal(result.pass, false, "class daily_usd is over even though everything else passes");
  assert.equal(verdictFor(result.verdicts, "per_action_usd").pass, true);
  assert.equal(verdictFor(result.verdicts, "daily_usd").pass, false);
  assert.equal(verdictFor(result.verdicts, "global.daily_usd").pass, true);
  assert.equal(verdictFor(result.verdicts, "global.daily_actions").pass, true);
});

test("verdicts are emitted in a stable order: class limits then global scopes", () => {
  const result = evaluateBudgets(
    [],
    {
      classLimits: { per_action_usd: 25, daily_usd: 100 },
      classPattern: "financial.*",
      globalBudgets: { team: { daily_usd: 500 }, global: { daily_usd: 100, daily_actions: 200 } },
    },
    { class: "financial.spend", est_cost_usd: 1 },
    EVAL_TS,
  );
  assert.deepEqual(
    result.verdicts.map((entry) => entry.limit),
    ["daily_usd", "per_action_usd", "global.daily_actions", "global.daily_usd", "team.daily_usd"],
  );
});

test("every named budget scope is evaluated, not only `global`", () => {
  const records = log(grant("financial.spend", 40, before(60 * 60 * 1000)));
  const result = evaluateBudgets(
    records,
    globalScope({ global: { daily_usd: 1000 }, team: { daily_usd: 30 } }),
    { class: "financial.spend", est_cost_usd: 1 },
    EVAL_TS,
  );
  assert.equal(result.pass, false);
  assert.equal(verdictFor(result.verdicts, "team.daily_usd").pass, false);
});

test("the same records and timestamp always yield deeply equal verdicts", () => {
  const records = log(
    grant("financial.spend", 12.34, before(6 * 60 * 60 * 1000)),
    started("financial.transfer", 7.5, before(2 * 60 * 60 * 1000)),
    nonConsuming("execution.completed", "financial.spend", 99, before(60 * 60 * 1000)),
  );
  const scope: BudgetScope = {
    classLimits: { per_action_usd: 25, daily_usd: 100 },
    classPattern: "financial.*",
    globalBudgets: { global: { daily_usd: 100, daily_actions: 200 } },
  };
  const action = { class: "financial.spend", est_cost_usd: 5 };
  const first = evaluateBudgets(records, scope, action, EVAL_TS);
  const second = evaluateBudgets(records, scope, action, EVAL_TS);
  // A structurally equal but distinct input array must give a deeply equal
  // answer: nothing is cached on identity and nothing is read from ambient state.
  const third = evaluateBudgets(records.map((record) => ({ ...record })), scope, action, EVAL_TS);
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.equal(first.pass, true);
});
