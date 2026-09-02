/**
 * Request-volume limits at intake: `queue-full` and `rate-limited` (APRV-173).
 *
 * SPEC.md §5.2 has blessed `limits.max_pending` and `limits.requests_per_hour`
 * since v0.1 and no runtime read either of them. This file pins the two halves
 * of closing that gap: the pure counting in `core/intake-limits.ts`, and the
 * refusals `core/gate.ts` produces from it.
 *
 * Every log these tests count over is built through the REAL append path —
 * `attest`, `register`, `request`, `decide`, `withdraw` — never by writing
 * records by hand. A hand-built log would let a counting bug agree with a
 * fixture bug, and the pending set is exactly the thing this module must not
 * define for itself.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { renderQueue } from "../src/channels/render-queue.js";
import { evaluateBudgets } from "../src/core/budgets.js";
import { decide, register, request, withdraw, type GateRefusal } from "../src/core/gate.js";
import {
  evaluateIntakeLimits,
  isIntakeLimitName,
  pendingCount,
  requestsInWindow,
  REQUEST_WINDOW_MS,
} from "../src/core/intake-limits.js";
import {
  assertClean,
  at,
  attest,
  eventTypes,
  fixedClock,
  newScenario,
  records,
  scratchRoot,
  T0,
  type Scenario,
} from "./scenario.js";

const { root, cleanup } = scratchRoot("intake-limits");
after(cleanup);

/** A declared binding: manual actions MUST carry one (amended SPEC.md §6.2). */
const BOUND = "e".repeat(64);

/** One hour, the `requests_per_hour` window, in minutes. */
const HOUR_MINUTES = REQUEST_WINDOW_MS / 60_000;

const EMAIL = "communicate.email.external";
const KEYS = ["task-042:a", "task-042:b", "task-042:c", "task-042:d"] as const;

function policy(lines: string[]): string {
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    '  approval_ttl: "1h"',
    "  on_expiry: reject",
    "classes:",
    "  read.*:",
    "    autonomy: autonomous",
    `  ${EMAIL}:`,
    "    autonomy: manual",
    ...lines,
    "```",
    "",
  ].join("\n");
}

/** No request-volume limit anywhere: whatever refuses below is not this module. */
const POLICY_NO_LIMITS = policy([]);
const POLICY_MAX_PENDING_1 = policy(["    limits:", "      max_pending: 1"]);
const POLICY_MAX_PENDING_2 = policy(["    limits:", "      max_pending: 2"]);
const POLICY_PER_HOUR_2 = policy(["    limits:", "      requests_per_hour: 2"]);
const POLICY_BOTH = policy([
  "    limits:",
  "      max_pending: 1",
  "      requests_per_hour: 1",
]);
const POLICY_GLOBAL_MAX_PENDING = policy([
  "budgets:",
  "  global:",
  "    max_pending: 1",
]);

const ENVELOPE = {
  origin: { app: "example-capture", created_by: "human:carter" },
  state: "proposed",
  actions: [
    ...KEYS.map((key) => ({
      class: EMAIL,
      summary: `Send ${key}`,
      reversible: false,
      est_cost_usd: "0.01",
      idempotency_key: key,
      payload_hash: BOUND,
    })),
    {
      class: "read.file",
      summary: "Read the ledger",
      reversible: true,
      est_cost_usd: "0",
      idempotency_key: "task-042:read",
    },
  ],
};

function ready(policyText: string): Scenario {
  const unit = newScenario(root, policyText);
  attest(unit);
  const registered = register(
    unit.logPath,
    { task: "task-042", envelope: ENVELOPE },
    "agent:claude",
    { ...unit.options, clock: fixedClock(T0) },
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);
  return unit;
}

function ask(unit: Scenario, key: string, minute: number, actor = "agent:claude") {
  return request(
    unit.logPath,
    { task: "task-042", actionKey: key, cls: EMAIL, est_cost_usd: "0.01", reversible: false },
    actor,
    { ...unit.options, clock: fixedClock(at(minute)) },
  );
}

function askOk(unit: Scenario, key: string, minute: number, actor = "agent:claude"): void {
  const result = ask(unit, key, minute, actor);
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
}

function refusal(result: ReturnType<typeof ask>): GateRefusal {
  assert.equal(result.ok, false, "expected a refusal");
  return result as GateRefusal;
}

// ---------------------------------------------------------------------------
// pendingCount — the queue, derived rather than redefined
// ---------------------------------------------------------------------------

test("pendingCount counts live requests and nothing else", () => {
  const unit = ready(POLICY_NO_LIMITS);
  askOk(unit, KEYS[0], 1);
  askOk(unit, KEYS[1], 2);
  askOk(unit, KEYS[2], 3);
  askOk(unit, KEYS[3], 4);
  assert.equal(pendingCount(records(unit), null, at(5), 3_600_000), 4);

  // Each exit from the queue is honoured by the derivation that owns it.
  assert.equal(
    decide(unit.logPath, KEYS[0], "grant", "human:carter", {
      ...unit.options,
      clock: fixedClock(at(6)),
    }).ok,
    true,
  );
  assert.equal(
    decide(unit.logPath, KEYS[1], "reject", "human:carter", {
      ...unit.options,
      clock: fixedClock(at(7)),
    }).ok,
    true,
  );
  assert.equal(
    withdraw(unit.logPath, KEYS[2], "agent:claude", {
      ...unit.options,
      clock: fixedClock(at(8)),
      reason: "superseded",
    }).ok,
    true,
  );
  assert.equal(pendingCount(records(unit), null, at(9), 3_600_000), 1);
  assertClean(unit);
});

test("a TTL-lapsed request has left the queue with no event of any kind", () => {
  const unit = ready(POLICY_NO_LIMITS);
  askOk(unit, KEYS[0], 1);
  const log = records(unit);

  // Inside the hour it is pending; past it, it is not — and no `approval.expired`
  // record was written to make that true.
  assert.equal(pendingCount(log, null, at(59), 3_600_000), 1);
  assert.equal(pendingCount(log, null, at(62), 3_600_000), 0);
  assert.ok(!eventTypes(unit).includes("approval.expired"));

  // A policy declaring no TTL keeps it pending forever, which is the same
  // answer `requestState` gives every other reader.
  assert.equal(pendingCount(log, null, at(10_000), null), 1);
});

test("pendingCount attributes by the winning rule's pattern, exactly as budgets do", () => {
  const unit = ready(POLICY_NO_LIMITS);
  askOk(unit, KEYS[0], 1);
  askOk(unit, KEYS[1], 2);
  const log = records(unit);

  assert.equal(pendingCount(log, "communicate.email.*", at(3), 3_600_000), 2);
  assert.equal(pendingCount(log, EMAIL, at(3), 3_600_000), 2);
  assert.equal(pendingCount(log, "files.write.*", at(3), 3_600_000), 0);
  // `null` is the global scope: every live request, whatever its class.
  assert.equal(pendingCount(log, null, at(3), 3_600_000), 2);
});

// ---------------------------------------------------------------------------
// requestsInWindow — creation, per origin, half-open at the bottom
// ---------------------------------------------------------------------------

test("the window is half-open at the bottom and closed at the top", () => {
  const unit = ready(POLICY_NO_LIMITS);
  askOk(unit, KEYS[0], 0);
  askOk(unit, KEYS[1], 30);
  const log = records(unit);

  // Top edge, closed: a request stamped at the evaluation instant is in.
  assert.equal(requestsInWindow(log, "agent:claude", null, at(30)), 2);
  // Bottom edge, half-open: exactly one hour old has aged out.
  assert.equal(requestsInWindow(log, "agent:claude", null, at(HOUR_MINUTES)), 1);
  // A moment before that boundary it is still in.
  assert.equal(
    requestsInWindow(log, "agent:claude", null, at(HOUR_MINUTES - 1 / 60)),
    2,
  );
  // And a moment after the second request's own hour, the window is empty.
  assert.equal(requestsInWindow(log, "agent:claude", null, at(HOUR_MINUTES + 31)), 0);
});

test("the window counts CREATION, so an answered request still spent it", () => {
  const unit = ready(POLICY_NO_LIMITS);
  askOk(unit, KEYS[0], 1);
  assert.equal(
    withdraw(unit.logPath, KEYS[0], "agent:claude", {
      ...unit.options,
      clock: fixedClock(at(2)),
      reason: "cancelled",
    }).ok,
    true,
  );
  // Withdrawn, so not pending — and still counted by the hour it was made in.
  const log = records(unit);
  assert.equal(pendingCount(log, null, at(3), 3_600_000), 0);
  assert.equal(requestsInWindow(log, "agent:claude", null, at(3)), 1);
});

test("the window is per origin and per attributed class", () => {
  const unit = ready(POLICY_NO_LIMITS);
  askOk(unit, KEYS[0], 1, "agent:claude");
  askOk(unit, KEYS[1], 2, "agent:other");
  const log = records(unit);

  assert.equal(requestsInWindow(log, "agent:claude", null, at(3)), 1);
  assert.equal(requestsInWindow(log, "agent:other", null, at(3)), 1);
  assert.equal(requestsInWindow(log, "human:carter", null, at(3)), 0);
  assert.equal(requestsInWindow(log, "agent:claude", "files.write.*", at(3)), 0);
});

test("an unparseable evaluation instant computes no window at all", () => {
  const unit = ready(POLICY_NO_LIMITS);
  askOk(unit, KEYS[0], 1);
  assert.equal(requestsInWindow(records(unit), "agent:claude", null, "not-a-time"), null);
});

// ---------------------------------------------------------------------------
// evaluateIntakeLimits — unset, malformed, conjunctive, ordered
// ---------------------------------------------------------------------------

test("unset limits enforce nothing", () => {
  const unit = ready(POLICY_NO_LIMITS);
  askOk(unit, KEYS[0], 1);
  const log = records(unit);

  for (const scope of [
    { classLimits: null, classPattern: null, globalBudgets: null },
    { classLimits: {}, classPattern: EMAIL, globalBudgets: {} },
    // A rule with money limits and no request-volume limit: still nothing here.
    { classLimits: { per_action_usd: 25 }, classPattern: EMAIL, globalBudgets: null },
  ]) {
    const verdicts = evaluateIntakeLimits(
      log,
      scope,
      { class: EMAIL, origin: "agent:claude" },
      at(2),
      3_600_000,
    );
    assert.equal(verdicts.pass, true);
    assert.deepEqual(verdicts.verdicts, []);
  }
});

test("a declared limit that is not a positive whole number fails closed", () => {
  const unit = ready(POLICY_NO_LIMITS);
  const log = records(unit);
  for (const declared of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const verdicts = evaluateIntakeLimits(
      log,
      {
        classLimits: { max_pending: declared },
        classPattern: EMAIL,
        globalBudgets: { global: { max_pending: declared } },
      },
      { class: EMAIL, origin: "agent:claude" },
      at(1),
      3_600_000,
    );
    assert.equal(verdicts.pass, false, `${String(declared)} was admitted`);
    assert.equal(verdicts.verdicts.length, 2);
    for (const entry of verdicts.verdicts) {
      assert.equal(entry.pass, false);
      assert.equal(entry.ceiling, null);
      assert.equal(entry.refusal, "queue-full");
      assert.ok((entry.note ?? "").includes("cannot be proven satisfied"));
    }
  }
});

test("a class limit with no pattern to attribute it cannot be proven satisfied", () => {
  const unit = ready(POLICY_NO_LIMITS);
  const verdicts = evaluateIntakeLimits(
    records(unit),
    { classLimits: { max_pending: 5 }, classPattern: null, globalBudgets: null },
    { class: EMAIL, origin: "agent:claude" },
    at(1),
    3_600_000,
  );
  assert.equal(verdicts.pass, false);
  assert.ok((verdicts.verdicts[0]?.note ?? "").includes("class pattern"));
});

test("an unparseable evaluation instant fails the rate limit closed", () => {
  const unit = ready(POLICY_NO_LIMITS);
  const verdicts = evaluateIntakeLimits(
    records(unit),
    { classLimits: { requests_per_hour: 5 }, classPattern: EMAIL, globalBudgets: null },
    { class: EMAIL, origin: "agent:claude" },
    "halfway through tuesday",
    3_600_000,
  );
  assert.equal(verdicts.pass, false);
  assert.equal(verdicts.verdicts[0]?.refusal, "rate-limited");
  assert.ok((verdicts.verdicts[0]?.note ?? "").includes("rolling window cannot be computed"));
});

test("verdict order is class limits ascending, then global scopes ascending", () => {
  const unit = ready(POLICY_NO_LIMITS);
  askOk(unit, KEYS[0], 1);
  const verdicts = evaluateIntakeLimits(
    records(unit),
    {
      classLimits: { max_pending: 9, requests_per_hour: 9 },
      classPattern: EMAIL,
      globalBudgets: { zeta: { max_pending: 9 }, alpha: { max_pending: 9 } },
    },
    { class: EMAIL, origin: "agent:claude" },
    at(2),
    3_600_000,
  );
  assert.deepEqual(
    verdicts.verdicts.map((entry) => entry.limit),
    ["max_pending", "requests_per_hour", "alpha.max_pending", "zeta.max_pending"],
  );
  assert.equal(verdicts.pass, true);
  // The figures a verdict reports: one pending, one being admitted, headroom 7.
  assert.deepEqual(
    verdicts.verdicts.map((entry) => [entry.observed, entry.requested, entry.remaining]),
    [
      [1, 1, 7],
      [1, 1, 7],
      [1, 1, 7],
      [1, 1, 7],
    ],
  );
});

// ---------------------------------------------------------------------------
// The division of labour with core/budgets.ts
// ---------------------------------------------------------------------------

test("budgets no longer refuse the request-volume names as unknown limits", () => {
  const unit = ready(POLICY_NO_LIMITS);
  const verdicts = evaluateBudgets(
    records(unit),
    {
      classLimits: { max_pending: 1, requests_per_hour: 1, per_action_usd: 25 },
      classPattern: EMAIL,
      globalBudgets: { global: { max_pending: 1, daily_actions: 100 } },
    },
    { class: EMAIL, est_cost_usd: "0.01" },
    at(1),
  );
  assert.equal(verdicts.pass, true);
  assert.deepEqual(
    verdicts.verdicts.map((entry) => entry.limit),
    ["per_action_usd", "global.daily_actions"],
  );
  assert.ok(isIntakeLimitName("max_pending") && isIntakeLimitName("requests_per_hour"));
  assert.ok(!isIntakeLimitName("daily_usd"));
});

test("the skip loses no ceiling: the same policy still refuses at intake", () => {
  // The pair this test exists for. `core/budgets.ts` passes `max_pending` over,
  // so the ONLY thing standing between this policy and an unbounded queue is
  // the intake check, and a regression that removed it would show up here as a
  // second admitted request rather than as a silent widening.
  const unit = ready(POLICY_MAX_PENDING_1);
  askOk(unit, KEYS[0], 1);
  assert.equal(refusal(ask(unit, KEYS[1], 2)).code, "queue-full");
});

// ---------------------------------------------------------------------------
// The gate: two refusals, machine-readable, distinct, appending nothing
// ---------------------------------------------------------------------------

test("queue-full refuses the request over the cap and appends nothing", () => {
  const unit = ready(POLICY_MAX_PENDING_2);
  askOk(unit, KEYS[0], 1);
  askOk(unit, KEYS[1], 2);
  const before = eventTypes(unit);

  const refused = refusal(ask(unit, KEYS[2], 3));
  assert.equal(refused.code, "queue-full");
  assert.ok(refused.message.includes("max_pending"));
  assert.deepEqual(
    (refused.limits ?? []).map((entry) => [entry.limit, entry.scope, entry.window, entry.refusal]),
    [["max_pending", "class", "simultaneous", "queue-full"]],
  );
  assert.deepEqual((refused.limits ?? []).map((entry) => [entry.observed, entry.ceiling]), [[2, 2]]);

  // Nothing appended: no event of any kind, and certainly no budget.exceeded.
  assert.deepEqual(eventTypes(unit), before);
  assertClean(unit);

  // The queue drains and the same request is admitted, unchanged.
  assert.equal(
    decide(unit.logPath, KEYS[0], "reject", "human:carter", {
      ...unit.options,
      clock: fixedClock(at(4)),
    }).ok,
    true,
  );
  askOk(unit, KEYS[2], 5);
  assertClean(unit);
});

test("a global budgets scope caps the whole queue whatever the class", () => {
  const unit = ready(POLICY_GLOBAL_MAX_PENDING);
  askOk(unit, KEYS[0], 1);
  const refused = refusal(ask(unit, KEYS[1], 2));
  assert.equal(refused.code, "queue-full");
  assert.deepEqual(
    (refused.limits ?? []).map((entry) => [entry.limit, entry.scope]),
    [["global.max_pending", "global"]],
  );
});

test("rate-limited refuses the origin's excess and appends nothing", () => {
  const unit = ready(POLICY_PER_HOUR_2);
  askOk(unit, KEYS[0], 1);
  askOk(unit, KEYS[1], 2);
  const before = eventTypes(unit);

  const refused = refusal(ask(unit, KEYS[2], 3));
  assert.equal(refused.code, "rate-limited");
  assert.deepEqual(
    (refused.limits ?? []).map((entry) => [entry.limit, entry.window, entry.refusal]),
    [["requests_per_hour", "rolling-1h", "rate-limited"]],
  );
  assert.deepEqual(eventTypes(unit), before);
  assertClean(unit);

  // A different origin is unaffected: the ceiling is per origin.
  askOk(unit, KEYS[2], 4, "agent:other");

  // And the window rolls: an hour after the first two, the origin may ask again.
  askOk(unit, KEYS[3], HOUR_MINUTES + 3);
  assertClean(unit);
});

test("a refused request consumes neither the window nor the budget", () => {
  // max_pending 1 and requests_per_hour 2. The second request is refused
  // `queue-full`; if that refusal had consumed the hour, the retry after the
  // queue drained would come back `rate-limited` instead of being admitted.
  const unit = ready(policy(["    limits:", "      max_pending: 1", "      requests_per_hour: 2"]));
  askOk(unit, KEYS[0], 1);
  assert.equal(refusal(ask(unit, KEYS[1], 2)).code, "queue-full");
  assert.equal(
    decide(unit.logPath, KEYS[0], "grant", "human:carter", {
      ...unit.options,
      clock: fixedClock(at(3)),
    }).ok,
    true,
  );
  askOk(unit, KEYS[1], 4);
  assertClean(unit);
});

test("queue-full outranks rate-limited when both ceilings are met", () => {
  const unit = ready(POLICY_BOTH);
  askOk(unit, KEYS[0], 1);
  const refused = refusal(ask(unit, KEYS[1], 2));
  assert.equal(refused.code, "queue-full");
  // Both failing verdicts are reported; only the first names the refusal.
  assert.deepEqual(
    (refused.limits ?? []).map((entry) => entry.limit),
    ["max_pending", "requests_per_hour"],
  );
});

test("intake limits bind the manual path and leave the proceed path alone", () => {
  // `read.*` is autonomous: it appends no `approval.requested`, joins no queue,
  // and puts nothing in front of a human, so a full queue must not refuse it.
  const unit = ready(POLICY_GLOBAL_MAX_PENDING);
  askOk(unit, KEYS[0], 1);
  assert.equal(refusal(ask(unit, KEYS[1], 2)).code, "queue-full");

  const proceeded = request(
    unit.logPath,
    { task: "task-042", actionKey: "task-042:read", cls: "read.file", reversible: true },
    "agent:claude",
    { ...unit.options, clock: fixedClock(at(3)) },
  );
  assert.equal(proceeded.ok, true);
  assert.equal(proceeded.ok && proceeded.proceed, true);
  assert.equal(proceeded.ok && proceeded.record, null);
  assertClean(unit);
});

// ---------------------------------------------------------------------------
// Surfacing: the standing condition a refused request leaves no trace of
// ---------------------------------------------------------------------------

test("QUEUE.md shows the ceilings, and says when intake is refusing", () => {
  const unit = ready(POLICY_MAX_PENDING_1);
  askOk(unit, KEYS[0], 1);
  assert.equal(refusal(ask(unit, KEYS[1], 2)).code, "queue-full");

  const rendered = renderQueue(unit.logPath, unit.options, at(3));
  assert.equal(rendered.ok, true);
  const markdown = rendered.ok ? rendered.markdown : "";
  assert.ok(markdown.includes("## Request-volume ceilings"));
  assert.ok(markdown.includes("`max_pending`"));
  assert.ok(markdown.includes("intake is refusing `queue-full`"));

  // Deterministic, like every other line in this file.
  const again = renderQueue(unit.logPath, unit.options, at(3));
  assert.equal(again.ok && again.markdown, markdown);
});

test("a policy declaring no ceiling renders no ceilings section", () => {
  const unit = ready(POLICY_NO_LIMITS);
  askOk(unit, KEYS[0], 1);
  const rendered = renderQueue(unit.logPath, unit.options, at(2));
  assert.equal(rendered.ok, true);
  assert.ok(!(rendered.ok ? rendered.markdown : "").includes("Request-volume ceilings"));
});

test("the two refusals are distinct codes with distinct repairs", () => {
  const queue = ready(POLICY_MAX_PENDING_1);
  askOk(queue, KEYS[0], 1);
  const full = refusal(ask(queue, KEYS[1], 2));

  const rate = ready(policy(["    limits:", "      requests_per_hour: 1"]));
  askOk(rate, KEYS[0], 1);
  const limited = refusal(ask(rate, KEYS[1], 2));

  assert.notEqual(full.code, limited.code);
  assert.ok(full.message.includes("queue"));
  assert.ok(limited.message.includes("agent:claude"));
});
