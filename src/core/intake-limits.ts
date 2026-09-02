/**
 * Request-volume limits at intake (SPEC.md §5.2, APRV-173).
 *
 * > **Request-volume limits.** `limits.max_pending` (per class or global):
 * > maximum simultaneously pending requests; further requests are refused at
 * > intake with reason `queue-full`. `limits.requests_per_hour` (per origin):
 * > rolling-window ceiling on request creation; excess is refused with reason
 * > `rate-limited`.
 *
 * This module is that computation. It was policy vocabulary that no runtime
 * read until this task: a policy could declare either key, the schema would
 * accept it, and nothing enforced it.
 *
 * ## What these limits protect
 *
 * Budgets meter money and action counts, which is the world's exposure to the
 * agent. These meter the QUEUE, which is the human's exposure to the agent. An
 * agent that floods the queue with cheap, in-budget requests spends nothing and
 * still defeats the gate, because an approver facing two hundred prompts stops
 * reading them and starts clearing them. So the ceiling here is on attention,
 * and a refusal costs the requester one exit code and the approver nothing.
 *
 * That difference is why a refusal on this path appends NOTHING (Carter's
 * approved reading, 2026-08-31). `budget.exceeded` exists because a budget
 * refusal is a fact about a commitment that audit must be able to reconstruct;
 * a queue-flood refusal is a fact about a flood, and writing one log record per
 * refused request would hand the flooder the log growth it was refused the
 * queue for. The refusals are machine-readable and distinct (§11.1 invariant
 * 6), which is what an agent and an auditor each need, and the events that WERE
 * admitted are still all in the log to count from.
 *
 * ## Pure, deterministic, injected time
 *
 * Same discipline as `core/budgets.ts`: no I/O, no clock, no randomness. The
 * evaluation instant and the TTL are parameters, so a verdict is replayable
 * from the log alone. Nothing here re-runs class matching; the gate hands in
 * the limits the matcher already resolved and the pattern that produced them.
 *
 * ## What "pending" means
 *
 * A request is pending when {@link requestState} derives `requested` for its
 * action key at the evaluation instant: no grant, rejection, revocation,
 * withdrawal, expiry event or lapsed TTL, and no execution. That derivation is
 * `core/state.ts`'s and is the same one the gate refuses `duplicate-request`
 * from and the channels build the queue from. Counting pending requests with a
 * second, private definition is the one thing this module must not do — the
 * cap a policy writes is a cap on the queue a human is shown, so it counts the
 * queue a human is shown.
 *
 * ## What "per origin" means at v0.1
 *
 * **Origin is the record's `actor`.** The approved reading (Carter,
 * 2026-08-31): the actor on `approval.requested` is assigned by the runtime
 * from its own configuration rather than from the request, and under MCP the
 * `--as` argument is appended last, so a caller cannot choose the identity its
 * requests are counted under. Per-guest actors therefore make the ceiling
 * per-client, which is the useful shape. This is a v0.1 reading of the spec's
 * word "origin" rather than a claim that actor and origin are the same thing
 * forever: an origin richer than the actor (a session, a remote address) would
 * be a spec amendment, and it would only ever partition the count further.
 *
 * ## The rolling window
 *
 * `requests_per_hour` is measured over the hour preceding the evaluation
 * instant, tiled exactly as `core/budgets.ts` tiles its 24 hours: a request
 * consumes iff
 *
 *     evaluationTs - 1h  <  record.ts  <=  evaluationTs
 *
 * half-open at the bottom, closed at the top, so consecutive windows tile the
 * timeline and no request is counted in two of them. A request stamped exactly
 * one hour before the evaluation instant has aged out; one stamped at the
 * instant itself is in.
 *
 * ## Fail-closed, and what "unset" means
 *
 * A limit that is DECLARED and cannot be evaluated fails: a value that is not a
 * positive finite integer, or an evaluation timestamp no window can be computed
 * from, yields `pass: false` with a note. Silence is never a grant.
 *
 * A limit that is NOT declared enforces nothing, and that is the conservative
 * answer rather than an exception to it. SPEC.md §5.2 says these ceilings are a
 * tripwire whose "defaults are generous"; a runtime that invented one would
 * refuse requests under a policy the human attested and read, and the refusal
 * would name a number that appears nowhere in the file they signed. The
 * fail-closed direction for an ABSENT request-volume limit is the same one the
 * rest of the runtime takes for an absent `approval_ttl`: the policy declares
 * no ceiling, so no ceiling binds, and the manual gate that binds every request
 * on this path is what stands between the queue and the flood in the meantime.
 * Where an operator wants a tripwire, one line of policy arms it.
 *
 * ## Division of labour with `core/budgets.ts`
 *
 * These two names are evaluated HERE and nowhere else. `core/budgets.ts` skips
 * them by name rather than refusing them as unknown limits, and this module
 * ignores every limit name that is not one of them. The two skip lists are
 * complements, and each module's comment names the other: a limit that both
 * skipped would be a ceiling in the policy file that no code enforces, which is
 * the exact defect this task exists to close.
 */

import type { EventRecord } from "./log.js";
import type { Policy } from "./policy-load.js";
import { matchesPattern } from "./policy-match.js";
import { payloadOf, requestState } from "./state.js";

/** Length of the `requests_per_hour` window: one hour, in milliseconds. */
export const REQUEST_WINDOW_MS = 60 * 60 * 1000;

/** The limit name capping simultaneously pending requests (SPEC.md §5.2). */
export const MAX_PENDING = "max_pending";

/** The limit name capping request creation per origin (SPEC.md §5.2). */
export const REQUESTS_PER_HOUR = "requests_per_hour";

/**
 * The two names this module owns.
 *
 * Exported so `core/budgets.ts` skips exactly these and no others: one array,
 * read by both modules, so the two skip lists cannot drift apart into a limit
 * nobody evaluates.
 */
export const INTAKE_LIMIT_NAMES = [MAX_PENDING, REQUESTS_PER_HOUR] as const;

/** Is `name` a request-volume limit (and therefore not a budget's business)? */
export function isIntakeLimitName(name: string): boolean {
  return (INTAKE_LIMIT_NAMES as readonly string[]).includes(name);
}

/** The refusal a failing limit produces at intake. Mirrors SPEC.md §5.2. */
export type IntakeRefusal = "queue-full" | "rate-limited";

/**
 * Which limits apply, as resolved by the policy matcher — this module does not
 * re-run matching. Shaped like `BudgetScope` deliberately.
 *
 * - `classLimits` is `Resolution.limits`: the winning rule's `limits` map.
 * - `classPattern` is that rule's pattern. Class-scoped counting attributes a
 *   record by matching its `payload.class` against this pattern, exactly as
 *   budgets attribute, so one `financial.*` rule is one queue ceiling shared by
 *   every class it governs rather than a separate invisible queue per class.
 * - `globalBudgets` is `policy.budgets`: named scopes, each conjunctive, each
 *   counting every live request whatever its class. That is what makes it
 *   global, and it is the same reading `core/budgets.ts` gives `daily_actions`.
 */
export interface IntakeScope {
  classLimits: Record<string, number> | null;
  classPattern: string | null;
  globalBudgets: Policy["budgets"] | null;
}

/** The request being admitted: its class, and the origin it is counted under. */
export interface IntakeAction {
  class: string;
  /** The requesting actor. See "What per origin means" in the header. */
  origin: string;
}

/**
 * One limit's outcome.
 *
 * `observed` is what the log already holds (pending requests, or requests in
 * the window), `requested` is always `1` — the request being admitted — and
 * `remaining` is the headroom left after admitting it, so a failing verdict
 * shows how far over the line the queue is.
 *
 * Plain integers rather than the decimal strings `BudgetVerdict` carries. Those
 * are strings because a failing budget verdict is copied into `budget.exceeded`
 * and becomes hashed material; these verdicts are never appended anywhere, and
 * a count has no fractional part to serialize differently in another language.
 */
export interface IntakeVerdict {
  /** `max_pending`, `requests_per_hour`, or `<scope>.max_pending`. */
  limit: string;
  scope: "class" | "global";
  window: "simultaneous" | "rolling-1h";
  /** The refusal code this verdict produces when it fails. */
  refusal: IntakeRefusal;
  observed: number;
  requested: number;
  remaining: number;
  /** The declared ceiling, or `null` when it could not be read as one. */
  ceiling: number | null;
  pass: boolean;
  /** Present only when the verdict needs explaining (fail-closed refusals). */
  note?: string;
}

/** Outcome of {@link evaluateIntakeLimits}. Conjunctive: all must pass. */
export interface IntakeVerdicts {
  pass: boolean;
  verdicts: IntakeVerdict[];
}

/** `payload.class` when it is a string, else `null`. */
function classOf(record: EventRecord): string | null {
  const value = payloadOf(record)["class"];
  return typeof value === "string" ? value : null;
}

/**
 * Does this record belong to the scope being counted?
 *
 * `pattern === null` is the global scope: everything belongs. Otherwise the
 * record's own declared class must match the winning rule's pattern. A record
 * carrying no usable class is invisible to a class-scoped count for the reason
 * `core/budgets.ts` gives: it cannot be SHOWN to belong to the class. It is
 * still counted by every global scope.
 */
function inScope(record: EventRecord, pattern: string | null): boolean {
  if (pattern === null) return true;
  const cls = classOf(record);
  return cls !== null && matchesPattern(pattern, cls);
}

/** Every action key with an `approval.requested`, in log order, deduplicated. */
function requestedKeys(records: EventRecord[]): string[] {
  const keys: string[] = [];
  for (const record of records) {
    if (record.event !== "approval.requested") continue;
    const key = record.action_key;
    if (key === undefined || keys.includes(key)) continue;
    keys.push(key);
  }
  return keys;
}

/**
 * How many requests are simultaneously pending at `evaluationTs`.
 *
 * Derived through {@link requestState}, one action key at a time, so every
 * exit from the queue is honoured by the definition that owns it: a decision,
 * a revocation, a withdrawal (APRV-106), an `approval.expired` record, a TTL
 * lapsed by arithmetic with no record at all, and an execution. Nothing here
 * re-implements any of that.
 *
 * `pattern` scopes the count: `null` counts the whole queue (the global
 * scopes), a pattern counts the requests attributed to the winning rule.
 * Attribution reads the class off the `approval.requested` record rather than
 * off the derivation, because the pending set is the set of requests, and the
 * class a request was routed under is the class it was recorded with.
 *
 * Cost is one derivation per requested key, which is what
 * `channels/tagging.ts` already pays to build the same queue. Sharing that
 * cost is the point: a faster private walk would be a second definition of
 * pending, and the two would agree until the day they did not.
 */
export function pendingCount(
  records: EventRecord[],
  pattern: string | null,
  evaluationTs: string,
  ttlMs: number | null,
): number {
  let count = 0;
  for (const key of requestedKeys(records)) {
    const derivation = requestState(records, key, evaluationTs, ttlMs);
    if (derivation.state !== "requested") continue;
    if (derivation.requestSeq === null) continue;
    const record = records.find((candidate) => candidate.seq === derivation.requestSeq);
    if (record === undefined) continue;
    if (!inScope(record, pattern)) continue;
    count += 1;
  }
  return count;
}

/**
 * How many `approval.requested` records `origin` created inside the window.
 *
 * Counts records, not live requests: the ceiling is on request CREATION, so a
 * request that was granted, rejected or withdrawn a minute after it was made
 * still consumed the origin's share of the hour. A ceiling that forgot a
 * request the moment it was answered would be no ceiling at all — an agent
 * could withdraw each request as it made it and create them without bound.
 *
 * A record whose `ts` cannot be parsed is COUNTED: it cannot be shown to lie
 * outside the window, and the fail-closed reading of an unplaceable request is
 * that it is inside. Same rule, and the same reason, as `core/budgets.ts`.
 *
 * Returns `null` when `evaluationTs` is not a parseable instant: no window can
 * be computed, so nothing can be counted, and the caller fails the limit closed
 * rather than reporting a zero that reads as headroom.
 */
export function requestsInWindow(
  records: EventRecord[],
  origin: string,
  pattern: string | null,
  evaluationTs: string,
): number | null {
  const evaluationMs = Date.parse(evaluationTs);
  if (Number.isNaN(evaluationMs)) return null;
  const floor = evaluationMs - REQUEST_WINDOW_MS;
  let count = 0;
  for (const record of records) {
    if (record.event !== "approval.requested") continue;
    if (record.actor !== origin) continue;
    if (!inScope(record, pattern)) continue;
    const ms = Date.parse(record.ts);
    if (!Number.isNaN(ms) && !(ms > floor && ms <= evaluationMs)) continue;
    count += 1;
  }
  return count;
}

/** A declared ceiling as an exact positive integer, or `null`. */
function ceilingOf(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

function verdict(
  limit: string,
  scope: "class" | "global",
  window: IntakeVerdict["window"],
  refusal: IntakeRefusal,
  observed: number,
  ceiling: number,
): IntakeVerdict {
  const remaining = ceiling - observed - 1;
  return {
    limit,
    scope,
    window,
    refusal,
    observed,
    requested: 1,
    remaining,
    ceiling,
    pass: remaining >= 0,
  };
}

/** A fail-closed refusal: nothing measured, nothing admitted, reason attached. */
function refuse(
  limit: string,
  scope: "class" | "global",
  window: IntakeVerdict["window"],
  refusal: IntakeRefusal,
  note: string,
): IntakeVerdict {
  return {
    limit,
    scope,
    window,
    refusal,
    observed: 0,
    requested: 1,
    remaining: -1,
    ceiling: null,
    pass: false,
    note,
  };
}

/**
 * Evaluate every applicable request-volume limit against the log.
 *
 * Conjunctive, exactly as budgets are: `pass` is true only when every verdict
 * passes. Verdicts are emitted class limits first (limit names ascending, which
 * puts `max_pending` before `requests_per_hour`), then global scopes (scope
 * name ascending), so the list is byte-stable regardless of policy key order.
 *
 * **The refusal code is the first failing verdict's**, in exactly that order,
 * and the order is normative: a caller told `queue-full` learns that the
 * approver's queue is at its ceiling, which is a standing condition it must
 * wait out or escalate; a caller told `rate-limited` learns that its own recent
 * volume is the problem, which is a condition that clears on its own. Where
 * both are true the standing condition is the one worth reporting, because an
 * agent that backs off for a minute on a `rate-limited` and retries into a full
 * queue has been told the smaller of the two facts.
 *
 * `records` may be the whole log; the caller is never asked to pre-filter, for
 * the reason `core/budgets.ts` gives: a caller that filtered wrongly would
 * silently widen the ceiling.
 */
export function evaluateIntakeLimits(
  records: EventRecord[],
  scope: IntakeScope,
  action: IntakeAction,
  evaluationTs: string,
  ttlMs: number | null,
): IntakeVerdicts {
  const classLimits = scope.classLimits ?? {};
  const globalBudgets = scope.globalBudgets ?? {};
  const verdicts: IntakeVerdict[] = [];

  // --- Class limits (the winning rule's `limits`) --------------------------
  for (const name of Object.keys(classLimits).sort()) {
    if (!isIntakeLimitName(name)) continue; // `core/budgets.ts` owns the rest.
    const declared = classLimits[name];
    const isPending = name === MAX_PENDING;
    const window: IntakeVerdict["window"] = isPending ? "simultaneous" : "rolling-1h";
    const refusal: IntakeRefusal = isPending ? "queue-full" : "rate-limited";
    const ceiling = ceilingOf(declared);
    if (ceiling === null) {
      verdicts.push(
        refuse(
          name,
          "class",
          window,
          refusal,
          `class limit "${name}" is not a positive whole number; a ceiling that cannot be compared cannot be proven satisfied, so the request is refused rather than admitted against a limit nobody can evaluate`,
        ),
      );
      continue;
    }
    if (scope.classPattern === null) {
      verdicts.push(
        refuse(
          name,
          "class",
          window,
          refusal,
          `class limit "${name}" was supplied without the class pattern that scopes its count; the queue cannot be attributed, so the limit cannot be proven satisfied`,
        ),
      );
      continue;
    }
    if (isPending) {
      verdicts.push(
        verdict(
          name,
          "class",
          window,
          refusal,
          pendingCount(records, scope.classPattern, evaluationTs, ttlMs),
          ceiling,
        ),
      );
      continue;
    }
    const observed = requestsInWindow(records, action.origin, scope.classPattern, evaluationTs);
    if (observed === null) {
      verdicts.push(
        refuse(
          name,
          "class",
          window,
          refusal,
          `evaluation timestamp "${evaluationTs}" is not a parseable RFC 3339 instant; the rolling window cannot be computed, so no request-volume limit can be proven satisfied`,
        ),
      );
      continue;
    }
    verdicts.push(verdict(name, "class", window, refusal, observed, ceiling));
  }

  // --- Global scopes (`policy.budgets`) -----------------------------------
  // Only `max_pending` lives here: `policy.schema.json` gives a budget scope
  // `daily_usd`, `daily_actions` and `max_pending`, and a rate limit has no
  // global spelling because it is measured per origin and a scope names none.
  for (const scopeName of Object.keys(globalBudgets).sort()) {
    const budget = globalBudgets[scopeName];
    if (budget === undefined) continue;
    const declared = (budget as Record<string, unknown>)[MAX_PENDING];
    if (declared === undefined) continue;
    const label = `${scopeName}.${MAX_PENDING}`;
    const ceiling = ceilingOf(declared);
    if (ceiling === null) {
      verdicts.push(
        refuse(
          label,
          "global",
          "simultaneous",
          "queue-full",
          `budget "${label}" is not a positive whole number; a ceiling that cannot be compared cannot be proven satisfied`,
        ),
      );
      continue;
    }
    verdicts.push(
      verdict(
        label,
        "global",
        "simultaneous",
        "queue-full",
        pendingCount(records, null, evaluationTs, ttlMs),
        ceiling,
      ),
    );
  }

  return { pass: verdicts.every((entry) => entry.pass), verdicts };
}

/**
 * The refusal code a failing evaluation produces, or `null` when it passed.
 *
 * One place, so the gate and any later surface answer with the same code for
 * the same verdict list. See {@link evaluateIntakeLimits} for why the first
 * failing verdict in verdict order is the one that speaks.
 */
export function intakeRefusalOf(verdicts: IntakeVerdicts): IntakeRefusal | null {
  const failed = verdicts.verdicts.find((entry) => !entry.pass);
  return failed === undefined ? null : failed.refusal;
}
