/**
 * Budget evaluation from the log (SPEC.md §5.2, §8).
 *
 * "An action must pass its class limits AND global budgets. Budget consumption
 * is computed from the log, never from a mutable counter." This module is that
 * computation: given the records of the append-only log, the limits the policy
 * matcher already resolved, the action about to be admitted, and the moment of
 * evaluation, it returns a per-limit verdict and one conjunctive answer.
 *
 * Pure and deterministic: no I/O, no clock, no randomness, no caching. The
 * evaluation timestamp is a **required parameter** — a budget decision that
 * depended on ambient time could not be replayed from the log, and replay is
 * the whole point of computing consumption from the log in the first place.
 * This module also does not re-run class matching: the gate hands in the
 * already-matched limits and the pattern that produced them.
 *
 * ## THE CONSUMPTION CONTRACT — what APRV-16 (the gate) MUST honor
 *
 * Budgets meter **authorization**, not completion. An authorized action
 * consumes budget whether or not it ultimately executes, because the human's
 * decision is the commitment; a runtime that only charged completed actions
 * would let a crashed or hung executor mint unlimited authorizations.
 *
 * The evaluator therefore reads consumption from exactly two event types, and
 * the gate MUST write them accordingly:
 *
 * 1. `approval.granted` — the manual path. A human said yes; budget is spent.
 * 2. `execution.started` — the supervised/autonomous paths. Under the amended
 *    §6.3 those paths emit no approval events, so the record that authorizes
 *    execution *is* the start event.
 *
 * To avoid charging a manual action twice (granted, then started), an
 * `execution.started` is counted only when the window contains no
 * `approval.granted` bearing the same `action_key`.
 *
 * **The gate MUST record `payload.est_cost_usd` (a number, USD) and
 * `payload.class` (the action's dotted class string) on every
 * `approval.granted` and `execution.started` event it appends.** Those two
 * payload fields are the entire input to USD accounting and class scoping.
 * A consuming event with no usable `est_cost_usd` contributes **0** to USD
 * sums but still counts as **1** action for `daily_actions` — an authorization
 * with no declared cost is still an authorization. A consuming event with no
 * usable `payload.class` is invisible to class-scoped limits (it cannot be
 * shown to belong to the class) but is still counted by global budgets, which
 * charge every authorization regardless of class.
 *
 * Nothing else consumes. `approval.rejected`, `approval.expired`, and
 * `approval.revoked` consume nothing: an authorization that was refused or
 * lapsed was never a commitment. `execution.completed` and `execution.failed`
 * consume nothing either — they report on a commitment already charged at
 * authorization time, and charging them again would double-count.
 *
 * ## The rolling window (SPEC.md §5.2, rolling-window amendment)
 *
 * A `daily` limit is evaluated over the 24 hours preceding the evaluation
 * moment, not over a calendar day. An event consumes iff
 *
 *     evaluationTs - 24h  <  event.ts  <=  evaluationTs
 *
 * — half-open at the bottom, closed at the top. An event exactly 24h old has
 * aged out; an event stamped at the evaluation instant is in. The bound is
 * half-open on exactly one side so that consecutive 24h windows tile the
 * timeline without double-counting a boundary event. Timestamps are compared
 * via `Date.parse` on the RFC 3339 strings the schema already guarantees.
 *
 * Rolling, not calendar: a burst that straddles midnight must not have its own
 * tripwire reset underneath it.
 *
 * ## Fail-closed
 *
 * A limit the evaluator does not understand cannot be proven satisfied, so it
 * fails: an unknown limit name yields `pass: false` with an explanatory `note`.
 * The same applies to an unparseable evaluation timestamp (no window can be
 * computed) and to class-scoped rolling limits offered without the class
 * pattern that scopes their consumption. Silence is never a grant.
 */

import type { Policy } from "./policy-load.js";
import type { EventRecord } from "./log.js";
import { matchesPattern } from "./policy-match.js";

/** Length of the rolling `daily` window: 24 hours, in milliseconds. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Event types that authorize execution and therefore consume budget. */
export const CONSUMING_EVENTS = ["approval.granted", "execution.started"] as const;

/**
 * Which limits apply, as resolved by the policy matcher — this module does not
 * re-run matching.
 *
 * - `classLimits` is `Resolution.limits`: the matched rule's `limits` map.
 * - `classPattern` is the pattern of the rule those limits came from
 *   (`Resolution.matched.pattern`). Class-scoped rolling limits count only
 *   authorizations whose `payload.class` matches this **same rule pattern** —
 *   not string equality with the action's class. A `financial.*` rule is one
 *   budget shared by every class it governs, which is what a policy author
 *   writing a single `daily_usd` under `financial.*` means; charging
 *   `financial.spend` and `financial.transfer` to separate invisible buckets
 *   would silently double the ceiling they wrote.
 * - `globalBudgets` is `policy.budgets`: named scopes, each conjunctive.
 */
export interface BudgetScope {
  classLimits: Record<string, number> | null;
  classPattern: string | null;
  globalBudgets: Policy["budgets"] | null;
}

/** The action being admitted. `est_cost_usd` absent means "no declared cost". */
export interface BudgetAction {
  class: string;
  est_cost_usd?: number;
}

/**
 * Which window a limit is measured over.
 *
 * `task-total` is the envelope cap of SPEC.md §6.2 (`budget.max_cost_usd`): not
 * a window at all but the whole life of one task, which is what "maximum total
 * spend across this task's actions" means.
 */
export type BudgetWindow = "per-action" | "rolling-24h" | "task-total";

/**
 * Where a limit came from: the matched class rule, `policy.budgets`, or the
 * task's own registered envelope (SPEC.md §6.2 `budget`). All three are
 * conjunctive with each other — "the stricter of the two binds".
 */
export type BudgetVerdictScope = "class" | "global" | "task";

/**
 * One limit's outcome.
 *
 * `consumed` is what the window already holds, `requested` is what this action
 * would add (USD for money limits, `1` for action counts), and `remaining` is
 * `limit - consumed - requested` — the headroom left *after* admitting the
 * action, so a `pass: false` verdict shows how far over the line it is.
 * `note` is present only when the verdict needs explaining, which at v0.1 means
 * only fail-closed refusals.
 */
export interface BudgetVerdict {
  limit: string;
  scope: BudgetVerdictScope;
  window: BudgetWindow;
  consumed: number;
  requested: number;
  remaining: number;
  pass: boolean;
  note?: string;
}

/** Outcome of {@link evaluateBudgets}. Conjunctive: all must pass. */
export interface BudgetVerdicts {
  pass: boolean;
  verdicts: BudgetVerdict[];
}

/** Known class-limit names (SPEC.md §5.1). Anything else fails closed. */
const PER_ACTION_USD = "per_action_usd";
const DAILY_USD = "daily_usd";
const DAILY_ACTIONS = "daily_actions";

/** The verdict label for the envelope's own cap (SPEC.md §6.2 `budget`). */
export const TASK_MAX_COST_USD = "budget.max_cost_usd";

/**
 * Round monetary arithmetic to 1e-6 USD.
 *
 * Sums of IEEE-754 doubles drift (`0.1 + 0.2 !== 0.3`), and an action refused
 * because a sum landed a nanocent over its ceiling would be both wrong and
 * unexplainable. Six decimals is far finer than any real currency amount and
 * far coarser than the drift. Applied identically to every reported number and
 * to the comparison itself, so the verdict always agrees with its own figures.
 */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** A payload field read defensively: the log's payload shape is open at v0.1. */
function payloadOf(record: EventRecord): Record<string, unknown> {
  const payload = record.payload;
  return typeof payload === "object" && payload !== null ? payload : {};
}

/** `payload.est_cost_usd` when it is a usable finite number, else `0`. */
function costOf(record: EventRecord): number {
  const value = payloadOf(record)["est_cost_usd"];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** `payload.class` when it is a string, else `null` (invisible to class limits). */
function classOf(record: EventRecord): string | null {
  const value = payloadOf(record)["class"];
  return typeof value === "string" ? value : null;
}

/** The action's declared cost, or `0` when it declares none. */
function requestedCost(action: BudgetAction): number {
  const value = action.est_cost_usd;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Records inside the rolling window, in log order.
 *
 * A record whose `ts` cannot be parsed is **kept**: it cannot be shown to lie
 * outside the window, and the fail-closed reading of an unplaceable
 * authorization is that it counts.
 */
function withinWindow(records: EventRecord[], evaluationMs: number): EventRecord[] {
  const floor = evaluationMs - WINDOW_MS;
  return records.filter((record) => {
    const ms = Date.parse(record.ts);
    if (Number.isNaN(ms)) return true;
    return ms > floor && ms <= evaluationMs;
  });
}

/**
 * The authorizations inside the window (see the consumption contract above).
 *
 * `approval.granted` always authorizes. `execution.started` authorizes only
 * when no `approval.granted` in the window carries the same `action_key`,
 * which is the manual-path double-count guard. A start event with no
 * `action_key` cannot be tied to a grant, so it counts — the schema requires
 * `action_key` on execution events, and the fail-closed reading of a record
 * that somehow lacks one is that it is its own authorization.
 */
function authorizations(windowed: EventRecord[]): EventRecord[] {
  const grantedKeys = new Set<string>();
  for (const record of windowed) {
    if (record.event === "approval.granted" && record.action_key !== undefined) {
      grantedKeys.add(record.action_key);
    }
  }
  return windowed.filter((record) => {
    if (record.event === "approval.granted") return true;
    if (record.event !== "execution.started") return false;
    return record.action_key === undefined || !grantedKeys.has(record.action_key);
  });
}

function verdict(
  limit: string,
  scope: BudgetVerdictScope,
  window: BudgetWindow,
  consumed: number,
  requested: number,
  ceiling: number,
  note?: string,
): BudgetVerdict {
  const consumedValue = round(consumed);
  const requestedValue = round(requested);
  const remaining = round(ceiling - consumedValue - requestedValue);
  const base: BudgetVerdict = {
    limit,
    scope,
    window,
    consumed: consumedValue,
    requested: requestedValue,
    remaining,
    pass: remaining >= 0,
  };
  return note === undefined ? base : { ...base, note };
}

/** A fail-closed refusal: nothing measured, nothing granted, reason attached. */
function refuse(limit: string, scope: BudgetVerdictScope, note: string): BudgetVerdict {
  return {
    limit,
    scope,
    window: "per-action",
    consumed: 0,
    requested: 0,
    remaining: 0,
    pass: false,
    note,
  };
}

/** Consumption totals over one filtered set of authorizations. */
interface Consumption {
  usd: number;
  actions: number;
}

function tally(events: EventRecord[]): Consumption {
  let usd = 0;
  for (const record of events) usd += costOf(record);
  return { usd: round(usd), actions: events.length };
}

/**
 * Evaluate every applicable budget limit against the log.
 *
 * Conjunctive (SPEC.md §5.2): `pass` is true only when every verdict passes.
 * Verdicts are emitted class limits first (limit names ascending), then global
 * budgets (scope name ascending, limit name ascending within a scope), so the
 * list is byte-stable regardless of policy key order.
 *
 * `records` may be the whole log; only the rolling window is consulted, and the
 * caller is never asked to pre-filter (a caller that filtered wrongly would
 * silently widen the budget).
 */
export function evaluateBudgets(
  records: EventRecord[],
  scope: BudgetScope,
  action: BudgetAction,
  evaluationTs: string,
): BudgetVerdicts {
  const classLimits = scope.classLimits ?? {};
  const classLimitNames = Object.keys(classLimits).sort();
  const globalBudgets = scope.globalBudgets ?? {};
  const globalScopeNames = Object.keys(globalBudgets).sort();

  const evaluationMs = Date.parse(evaluationTs);
  if (Number.isNaN(evaluationMs)) {
    // No parseable evaluation moment means no window, and an unmeasurable
    // budget is a refused one. Every applicable limit fails, and says why.
    const verdicts: BudgetVerdict[] = [];
    const why = `evaluation timestamp "${evaluationTs}" is not a parseable RFC 3339 instant; the rolling window cannot be computed, so no limit can be proven satisfied`;
    for (const name of classLimitNames) verdicts.push(refuse(name, "class", why));
    for (const scopeName of globalScopeNames) {
      const budget = globalBudgets[scopeName] ?? {};
      for (const name of Object.keys(budget).sort()) {
        verdicts.push(refuse(`${scopeName}.${name}`, "global", why));
      }
    }
    if (verdicts.length === 0) {
      // No limits apply at all: nothing to prove, nothing to refuse.
      return { pass: true, verdicts };
    }
    return { pass: false, verdicts };
  }

  const windowed = authorizations(withinWindow(records, evaluationMs));
  const requested = requestedCost(action);

  const verdicts: BudgetVerdict[] = [];

  // --- Class limits (the matched rule's `limits`) -------------------------
  if (classLimitNames.length > 0) {
    const pattern = scope.classPattern;
    // Class-scoped consumption counts authorizations of the SAME RULE PATTERN.
    const classEvents = windowed.filter((record) => {
      if (pattern === null) return false;
      const recordClass = classOf(record);
      return recordClass !== null && matchesPattern(pattern, recordClass);
    });
    const classConsumption = tally(classEvents);

    for (const name of classLimitNames) {
      const ceiling = classLimits[name];
      if (ceiling === undefined) continue;
      if (name === PER_ACTION_USD) {
        verdicts.push(verdict(name, "class", "per-action", 0, requested, ceiling));
        continue;
      }
      if (name === DAILY_USD || name === DAILY_ACTIONS) {
        if (scope.classPattern === null) {
          verdicts.push(
            refuse(
              name,
              "class",
              `class limit "${name}" was supplied without the class pattern that scopes its consumption; the window cannot be attributed, so the limit cannot be proven satisfied`,
            ),
          );
          continue;
        }
        const consumed = name === DAILY_USD ? classConsumption.usd : classConsumption.actions;
        const add = name === DAILY_USD ? requested : 1;
        verdicts.push(verdict(name, "class", "rolling-24h", consumed, add, ceiling));
        continue;
      }
      verdicts.push(
        refuse(
          name,
          "class",
          `unknown class limit "${name}"; this evaluator understands ${PER_ACTION_USD}, ${DAILY_USD}, and ${DAILY_ACTIONS} only, and a limit it cannot evaluate cannot be proven satisfied`,
        ),
      );
    }
  }

  // --- Global budgets (`policy.budgets`) ---------------------------------
  // Every named scope is evaluated, not just `global`: SPEC.md §5.1 permits
  // additional named scopes sharing the `global` shape, and a budget the
  // author wrote down but the runtime skipped would be a ceiling that silently
  // does not exist. Each charges every authorization in the window regardless
  // of class — that is what makes it global.
  if (globalScopeNames.length > 0) {
    const globalConsumption = tally(windowed);
    for (const scopeName of globalScopeNames) {
      const budget = globalBudgets[scopeName];
      if (budget === undefined) continue;
      const record = budget as Record<string, unknown>;
      for (const name of Object.keys(record).sort()) {
        const ceiling = record[name];
        const label = `${scopeName}.${name}`;
        if (typeof ceiling !== "number" || !Number.isFinite(ceiling)) {
          verdicts.push(
            refuse(
              label,
              "global",
              `budget "${label}" is not a finite number; a limit that cannot be compared cannot be proven satisfied`,
            ),
          );
          continue;
        }
        if (name === DAILY_USD) {
          verdicts.push(
            verdict(label, "global", "rolling-24h", globalConsumption.usd, requested, ceiling),
          );
          continue;
        }
        if (name === DAILY_ACTIONS) {
          verdicts.push(
            verdict(label, "global", "rolling-24h", globalConsumption.actions, 1, ceiling),
          );
          continue;
        }
        verdicts.push(
          refuse(
            label,
            "global",
            `unknown budget limit "${name}"; this evaluator understands ${DAILY_USD} and ${DAILY_ACTIONS} only, and a limit it cannot evaluate cannot be proven satisfied`,
          ),
        );
      }
    }
  }

  return { pass: verdicts.every((entry) => entry.pass), verdicts };
}

// ---------------------------------------------------------------------------
// The envelope's own cap (SPEC.md §6.2 `budget.max_cost_usd`) — S2
// ---------------------------------------------------------------------------

/**
 * The registered envelope's `budget.max_cost_usd` for `task`, or `null`.
 *
 * Read from the **log**, not from the task file: the file may have been edited
 * since registration, and an agent that could raise its own cap by editing
 * frontmatter after the fact would be authoring the ceiling it is judged by.
 * `register` copies the envelope's `budget` block into the `task.registered`
 * payload for exactly this read. The last registration wins, matching
 * `findDeclaration` in `core/execute.ts`.
 *
 * A cap that is not a finite non-negative number is `null` — absent rather than
 * zero. The schema already refuses those shapes at the write boundary, and
 * inventing a $0 ceiling for a malformed one would refuse every action of the
 * task with a message about money nobody wrote down.
 */
export function taskMaxCostUsd(records: EventRecord[], task: string): number | null {
  let found: number | null = null;
  for (const record of records) {
    if (record.event !== "task.registered" || record.task !== task) continue;
    const budget = payloadOf(record)["budget"];
    if (typeof budget !== "object" || budget === null) continue;
    const cap = (budget as Record<string, unknown>)["max_cost_usd"];
    if (typeof cap === "number" && Number.isFinite(cap) && cap >= 0) found = cap;
  }
  return found;
}

/**
 * Evaluate the task's own cap: does admitting `action` keep the SUM of this
 * task's authorized `est_cost_usd` at or under `maxCostUsd`?
 *
 * Commitment-based and consumption-identical to {@link evaluateBudgets}: the
 * same two event types authorize (`approval.granted`, and `execution.started`
 * only where no grant carries the same `action_key`), so a manual action that is
 * granted and then started is charged once. The only differences are scope —
 * events of *this task* — and window: there is none. A task cap is a lifetime
 * total, so an envelope that says `max_cost_usd: 0.5` cannot be spent twice by
 * waiting a day.
 *
 * `evaluationTs` is accepted for symmetry with the windowed evaluator and to
 * keep every budget call site shaped alike; it selects no window here and the
 * verdict does not depend on it.
 */
export function evaluateTaskBudget(
  records: EventRecord[],
  task: string,
  maxCostUsd: number,
  action: BudgetAction,
  _evaluationTs: string,
): BudgetVerdict {
  const consumed = tally(
    authorizations(records.filter((record) => record.task === task)),
  ).usd;
  return verdict(
    TASK_MAX_COST_USD,
    "task",
    "task-total",
    consumed,
    requestedCost(action),
    maxCostUsd,
  );
}

/**
 * Every applicable budget, conjunctively: class limits, global budgets, and the
 * task envelope's own cap.
 *
 * This is the function the three enforcement points call (`gate.request`,
 * `gate.decide`'s grant path, `execute.startExecution`), so the envelope cap is
 * checked at intake, at grant, and at execution start — the same three moments
 * policy budgets are checked, because a cap enforced at only one of them is a
 * cap a caller can route around by choosing a different door.
 *
 * Verdict order is class limits, then global budgets, then the task cap: the
 * existing byte-stable order with one deterministic addition at the end.
 * `task` may be `null` for a call site that has no task in hand, in which case
 * the cap simply does not apply.
 */
export function evaluateBudgetsWithTask(
  records: EventRecord[],
  scope: BudgetScope,
  action: BudgetAction,
  evaluationTs: string,
  task: string | null,
): BudgetVerdicts {
  const base = evaluateBudgets(records, scope, action, evaluationTs);
  if (task === null) return base;
  const cap = taskMaxCostUsd(records, task);
  if (cap === null) return base;
  const verdicts = [
    ...base.verdicts,
    evaluateTaskBudget(records, task, cap, action, evaluationTs),
  ];
  return { pass: verdicts.every((entry) => entry.pass), verdicts };
}
