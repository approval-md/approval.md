/**
 * The scrutiny ratchet (amended SPEC.md §11, A3) — the guard test.
 *
 * > Fields authored by the party under oversight (`route.confidence`,
 * > summaries, cost estimates) MAY raise scrutiny, inform display, or feed
 * > retrospective analysis. They MUST NOT reduce sampling probability,
 * > downgrade a resolved autonomy level, or shortcut any refusal path. Scrutiny
 * > only ratchets upward on self-report.
 *
 * This is a rule about what the code MUST NOT do, so the test is shaped
 * accordingly: two independent guards, one structural and one behavioral.
 *
 * 1. **`route.confidence` is not read.** A source scan over every module that
 *    resolves, gates, meters, or refuses. The field exists in the envelope
 *    schema (§6.2 permits it as a monitoring signal) and is deliberately not
 *    carried into `DeclaredAction`, so there is nothing for a decision path to
 *    consult. A scan is the right instrument here: a behavioral test can only
 *    prove the paths it happens to walk, whereas the claim is that no path
 *    reads the field at all.
 * 2. **A confident, cheap, well-summarized action is treated identically.**
 *    Two envelopes differing only in the claimed fields resolve the same way,
 *    refuse the same way, and consume the same budget — and `est_cost_usd: "0"`
 *    still spends one action of every action-count limit, because an
 *    authorization with no declared cost is still an authorization.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateBudgets } from "../src/core/budgets.js";
import { decide, register, request, type GateRefusal } from "../src/core/gate.js";
import { resolve } from "../src/core/policy-match.js";
import { loadPolicy } from "../src/core/policy-load.js";
import {
  assertClean,
  at,
  attest,
  fixedClock,
  newScenario,
  records,
  scratchRoot,
  T0,
  type Scenario,
} from "./scenario.js";

const { root, cleanup } = scratchRoot("ratchet");
after(cleanup);

// ---------------------------------------------------------------------------
// 1. The structural guard
// ---------------------------------------------------------------------------

/** Modules that resolve, gate, meter, or refuse — every decision path there is. */
const DECISION_MODULES = [
  "policy-match.ts",
  "policy-load.ts",
  "state.ts",
  "gate.ts",
  "token.ts",
  "execute.ts",
  "budgets.ts",
  "loop.ts",
  "attest.ts",
];

/** `src/core/<name>` as source text. */
function coreSource(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../src/core/${name}`, import.meta.url)), "utf8");
}

/** Source with block and line comments stripped: prose may name the field. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
}

test("no decision path reads route.confidence (the ratchet, structurally)", () => {
  for (const name of DECISION_MODULES) {
    const code = withoutComments(coreSource(name));
    assert.equal(
      /\bconfidence\b/u.test(code),
      false,
      `src/core/${name} references \`confidence\` outside comments. Amended SPEC.md §11: a field the party under oversight authored may raise scrutiny, never reduce it, and the way this codebase keeps that true is by not consulting it in any resolution, sampling, or refusal path.`,
    );
  }
});

test("the derived declaration carries no confidence field to be tempted by", () => {
  const code = withoutComments(coreSource("state.ts"));
  // DeclaredAction is what every decision path sees of what the agent claimed.
  assert.match(code, /interface DeclaredAction/u);
  assert.equal(/confidence/u.test(code), false);
});

// ---------------------------------------------------------------------------
// 2. The behavioral guard
// ---------------------------------------------------------------------------

const POLICY_COUNTED = [
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "classes:",
  "  communicate.email.external:",
  "    autonomy: manual",
  "    limits:",
  "      daily_actions: 1",
  "```",
  "",
].join("\n");

const BOUND = "d".repeat(64);

/**
 * An envelope whose CLAIMED fields are dialed all the way up or all the way
 * down, declaring `task-042:chaser` plus any `extraKeys`.
 *
 * The extra keys exist because SPEC.md §7 (APRV-147) refuses a manual request
 * for an action the log has not declared: a scenario that asks about a second
 * key declares it here, so that what the scenario is testing stays the budget
 * ratchet rather than the declaration check.
 */
function envelope(
  confidence: number,
  summary: string,
  cost: string,
  extraKeys: readonly string[] = [],
): unknown {
  const action = {
    class: "communicate.email.external",
    summary,
    reversible: false,
    est_cost_usd: cost,
    idempotency_key: "task-042:chaser",
    payload_hash: BOUND,
  };
  return {
    origin: { app: "example-capture", created_by: "agent:claude" },
    route: { assignee: "agent:claude", confidence, rationale: summary },
    state: "proposed",
    actions: [action, ...extraKeys.map((key) => ({ ...action, idempotency_key: key }))],
  };
}

function ready(env: unknown): Scenario {
  const unit = newScenario(root, POLICY_COUNTED);
  attest(unit);
  assert.equal(
    register(unit.logPath, { task: "task-042", envelope: env }, "agent:claude", {
      ...unit.options,
      clock: fixedClock(T0),
    }).ok,
    true,
  );
  return unit;
}

test("confidence 0.01 and 0.99 produce identical resolutions and identical refusals", () => {
  const outcomes = [0.01, 0.99].map((confidence) => {
    const unit = ready(envelope(confidence, "routine templated chaser, no risk", "0.02"));
    const result = request(
      unit.logPath,
      {
        task: "task-042",
        actionKey: "task-042:chaser",
        cls: "communicate.email.external",
        est_cost_usd: "0.02",
        reversible: false,
        summary: "routine templated chaser, no risk",
      },
      "agent:claude",
      { ...unit.options, clock: fixedClock(at(1)) },
    );
    assert.equal(result.ok, true, result.ok ? "" : result.message);
    if (!result.ok) throw new Error("unreachable");

    // The same question asked of the matcher directly, for good measure: the
    // resolver's inputs are the class and reversibility, and nothing else.
    const resolution = resolve(loadPolicy({ file: unit.policyPath }), "communicate.email.external", {
      reversible: false,
    });

    assertClean(unit);
    return {
      autonomy: result.autonomy,
      proceed: result.proceed,
      floor: result.resolution.floorApplied,
      provenance: result.resolution.provenance,
      matched: resolution.matched?.pattern ?? null,
      requested: result.record !== null,
    };
  });

  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.equal(outcomes[0]?.autonomy, "manual");
  assert.equal(outcomes[0]?.proceed, false);
});

test("est_cost_usd: 0 does not buy a free action — daily_actions still charges 1", () => {
  const unit = ready(
    envelope(0.99, "free, trivial, already approved in spirit", "0", ["task-042:second"]),
  );

  const first = request(
    unit.logPath,
    {
      task: "task-042",
      actionKey: "task-042:chaser",
      cls: "communicate.email.external",
      est_cost_usd: "0",
      reversible: false,
    },
    "agent:claude",
    { ...unit.options, clock: fixedClock(at(1)) },
  );
  assert.equal(first.ok, true, first.ok ? "" : first.message);

  const granted = decide(unit.logPath, "task-042:chaser", "grant", "human:carter", {
    ...unit.options,
    clock: fixedClock(at(2)),
  });
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);

  // The zero-cost grant consumed the class's whole daily allowance.
  const verdicts = evaluateBudgets(
    records(unit),
    {
      classLimits: { daily_actions: 1 },
      classPattern: "communicate.email.external",
      globalBudgets: null,
    },
    { class: "communicate.email.external", est_cost_usd: "0" },
    at(3),
  );
  const counted = verdicts.verdicts.find((verdict) => verdict.limit === "daily_actions");
  assert.equal(counted?.consumed, "1", "a $0 authorization was not counted as an action");
  assert.equal(verdicts.pass, false);

  // And the gate agrees: a second zero-cost action of the same class is refused.
  const second = request(
    unit.logPath,
    {
      task: "task-042",
      actionKey: "task-042:second",
      cls: "communicate.email.external",
      est_cost_usd: "0",
      reversible: false,
      payload_hash: BOUND,
    },
    "agent:claude",
    { ...unit.options, clock: fixedClock(at(4)) },
  ) as GateRefusal;
  assert.equal(second.ok, false);
  assert.equal(second.code, "budget-exceeded");
  assertClean(unit);
});
