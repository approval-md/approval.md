/**
 * Class matching and autonomy resolution (SPEC.md §5.2, §7).
 *
 * Given a loaded policy and an action class, decide the autonomy level that
 * governs the action, and say *why* — which rule matched, which rules were
 * considered, and whether the irreversibility floor overrode the match.
 *
 * This module is pure and deterministic: no I/O, no clock, no randomness, no
 * caching. The same `(load, actionClass, options)` always yields a deeply equal
 * `Resolution`. Every ordering decision below is total, so candidate order and
 * winner selection never depend on object key insertion order beyond what is
 * explicitly documented.
 *
 * ## Matching grammar (SPEC.md §5.2, `schema/policy.schema.json` `classPattern`)
 *
 * Patterns and classes are dot-separated segments. Within a pattern:
 *
 * - a literal segment matches exactly that segment;
 * - `*` in a non-final position matches exactly one segment;
 * - a **trailing** `.*` matches **one or more** remaining segments of any depth.
 *
 * The "one or more" is a deliberate choice: `read.*` matches `read.web` and
 * `read.web.page` but **not** the bare class `read`. The schema's
 * `classPattern` admits `read` and `read.*` as two distinct keys a policy may
 * list separately with different autonomy, so they must not be aliases of one
 * another; and §7 introduces `read.*` as a *namespace*, i.e. the things under
 * `read`, not `read` itself. A policy that wants the bare class covered writes
 * it as its own rule (or relies on `defaults.autonomy`).
 *
 * A bare `*` pattern is a single-segment pattern whose only segment is a
 * wildcard, and it is not "trailing `.*`" — it matches any single-segment class
 * (`read`, `deploy`) and nothing deeper. `*.*` is what matches exactly two
 * segments, `*` followed by a trailing wildcard.
 *
 * ## Specificity (SPEC.md §5.2, Specificity bullet)
 *
 * Candidates are ordered by the three-part key
 * `(literalSegments DESC, wildcardSegments ASC, totalSegments DESC)`. A trailing
 * `.*` counts as one wildcard segment and contributes no literals. Patterns
 * still tied are equally specific, and then "deny beats allow" decides: the
 * strictest autonomy among the tied rules wins.
 *
 * ## Fail-closed
 *
 * A not-ok {@link PolicyLoadResult} resolves **every** class to `manual` with
 * provenance `"fail-closed"` — see `policy-load.ts`. An absent
 * `defaults.autonomy` is likewise `manual` (provenance `"default"`): the schema
 * permits omitting `defaults`, and the absence of a grant is not a grant.
 */

import type { Autonomy, PolicyClassRule, PolicyLoadResult } from "./policy-load.js";

/** Where a {@link Resolution}'s autonomy came from. */
export type Provenance =
  /** A `classes` rule matched. */
  | "rule"
  /** No rule matched; `defaults.autonomy` (or its absent-means-manual form). */
  | "default"
  /** The policy failed to load; everything is `manual`. */
  | "fail-closed"
  /** The §7 irreversibility floor overrode the resolved autonomy. */
  | "floor";

/**
 * Specificity key: `[literalSegments, wildcardSegments, totalSegments]`.
 * Compared as literals DESC, wildcards ASC, total DESC.
 */
export type Specificity = [number, number, number];

/** A rule whose pattern matched the action class, with its specificity key. */
export interface Candidate {
  pattern: string;
  rule: PolicyClassRule;
  specificity: Specificity;
}

/**
 * Outcome of {@link resolve}.
 *
 * `candidates` is every matching rule in descending specificity order, so a
 * decision trace (APRV-12 `explain`) can be rendered without re-deriving the
 * match.
 */
export interface Resolution {
  autonomy: Autonomy;
  provenance: Provenance;
  matched: { pattern: string; rule: PolicyClassRule } | null;
  approvers: string[] | null;
  limits: Record<string, number> | null;
  floorApplied: boolean;
  candidates: Candidate[];
}

/** Options for {@link resolve}. */
export interface ResolveOptions {
  /**
   * Whether the action can be undone. `false` engages the SPEC.md §7
   * irreversibility floor; `true` and `undefined` do not.
   */
  reversible?: boolean;
}

/** Strictness order, strictest first (SPEC.md §5.2 "deny beats allow"). */
const STRICTNESS: Readonly<Record<Autonomy, number>> = {
  manual: 0,
  supervised: 1,
  autonomous: 2,
};

const WILDCARD = "*";

/** Split a dotted class or pattern into segments. */
function segments(text: string): string[] {
  return text.split(".");
}

/**
 * Does `pattern` match `actionClass`?
 *
 * See the module header for the grammar. Both are split on `.`; the pattern's
 * final segment is the only one that may span more than one class segment, and
 * only when the pattern has more than one segment (a bare `*` is single-span).
 */
export function matchesPattern(pattern: string, actionClass: string): boolean {
  const patternSegments = segments(pattern);
  const classSegments = segments(actionClass);

  const lastIndex = patternSegments.length - 1;
  const hasTrailingWildcard =
    patternSegments.length > 1 && patternSegments[lastIndex] === WILDCARD;

  if (hasTrailingWildcard) {
    // Trailing `.*` consumes ONE OR MORE segments: the class must be strictly
    // deeper than the pattern's literal prefix.
    if (classSegments.length < patternSegments.length) return false;
  } else if (classSegments.length !== patternSegments.length) {
    return false;
  }

  const fixedCount = hasTrailingWildcard ? lastIndex : patternSegments.length;
  for (let index = 0; index < fixedCount; index += 1) {
    const patternSegment = patternSegments[index];
    if (patternSegment === WILDCARD) continue;
    if (patternSegment !== classSegments[index]) return false;
  }
  return true;
}

/**
 * Specificity key of a pattern (SPEC.md §5.2). A trailing `.*` is one wildcard
 * segment contributing no literals — which is exactly how it is already counted
 * by segment splitting, so no special case is needed here.
 */
export function specificityOf(pattern: string): Specificity {
  const patternSegments = segments(pattern);
  let wildcards = 0;
  for (const segment of patternSegments) {
    if (segment === WILDCARD) wildcards += 1;
  }
  return [patternSegments.length - wildcards, wildcards, patternSegments.length];
}

/** Compare two specificity keys; negative when `a` is MORE specific. */
function compareSpecificity(a: Specificity, b: Specificity): number {
  if (a[0] !== b[0]) return b[0] - a[0]; // more literals first
  if (a[1] !== b[1]) return a[1] - b[1]; // fewer wildcards first
  return b[2] - a[2]; // more total segments first
}

/**
 * Total order over candidates: specificity first, then pattern name ascending.
 *
 * The lexicographic tail is not policy semantics — it exists so `candidates`
 * has one canonical order for equally specific rules, independent of YAML key
 * order, making the trace byte-stable.
 */
function compareCandidates(a: Candidate, b: Candidate): number {
  const bySpecificity = compareSpecificity(a.specificity, b.specificity);
  if (bySpecificity !== 0) return bySpecificity;
  return a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0;
}

const FAIL_CLOSED: Readonly<Resolution> = {
  autonomy: "manual",
  provenance: "fail-closed",
  matched: null,
  approvers: null,
  limits: null,
  floorApplied: false,
  candidates: [],
};

/**
 * Resolve the autonomy governing `actionClass` under `load`.
 *
 * 1. A not-ok load resolves `manual` / `"fail-closed"` for every class.
 * 2. Otherwise collect matching `classes` rules, order them by specificity, and
 *    take the most specific; among a full specificity tie the strictest
 *    autonomy wins, and among equally strict tied rules the lexicographically
 *    smallest pattern is chosen so the outcome is deterministic.
 * 3. With no matching rule the result is `defaults.autonomy` — or `manual` when
 *    `defaults` or `defaults.autonomy` is absent — with provenance `"default"`.
 * 4. Finally, `options.reversible === false` engages the §7 floor: a resolved
 *    `autonomous` or `supervised` becomes `manual` with `floorApplied: true`
 *    and provenance `"floor"`. An already-`manual` outcome is untouched, and
 *    keeps its original provenance, because the floor did not decide it.
 *
 * `approvers` and `limits` are carried from the matched rule only; they are
 * `null` when the rule omits them or when no rule matched.
 */
export function resolve(
  load: PolicyLoadResult,
  actionClass: string,
  options: ResolveOptions = {},
): Resolution {
  if (!load.ok) return { ...FAIL_CLOSED, candidates: [] };

  const classes = load.policy.classes ?? {};
  const candidates: Candidate[] = [];
  for (const pattern of Object.keys(classes)) {
    const rule = classes[pattern];
    if (rule === undefined) continue;
    if (!matchesPattern(pattern, actionClass)) continue;
    candidates.push({ pattern, rule, specificity: specificityOf(pattern) });
  }
  candidates.sort(compareCandidates);

  const resolution = candidates.length === 0
    ? fromDefaults(load, candidates)
    : fromRules(candidates);

  return applyFloor(resolution, options);
}

/** Build the no-rule-matched resolution. */
function fromDefaults(
  load: Extract<PolicyLoadResult, { ok: true }>,
  candidates: Candidate[],
): Resolution {
  return {
    // Absent `defaults.autonomy` is `manual`: the schema allows omitting
    // `defaults` entirely, and by the fail-closed principle the absence of a
    // grant is not a grant.
    autonomy: load.policy.defaults?.autonomy ?? "manual",
    provenance: "default",
    matched: null,
    approvers: null,
    limits: null,
    floorApplied: false,
    candidates,
  };
}

/** Build the rule-matched resolution from a specificity-sorted candidate list. */
function fromRules(candidates: Candidate[]): Resolution {
  const best = candidates[0];
  if (best === undefined) throw new Error("unreachable: empty candidate list");

  // Everything tied with the head on the full specificity key competes; among
  // them the strictest autonomy wins ("deny beats allow"). `candidates` is
  // already sorted by pattern within a tie, so the first strictest is the
  // lexicographically smallest strictest — deterministic regardless of the
  // policy file's key order.
  let winner = best;
  for (const candidate of candidates) {
    if (compareSpecificity(candidate.specificity, best.specificity) !== 0) break;
    if (STRICTNESS[candidate.rule.autonomy] < STRICTNESS[winner.rule.autonomy]) {
      winner = candidate;
    }
  }

  return {
    autonomy: winner.rule.autonomy,
    provenance: "rule",
    matched: { pattern: winner.pattern, rule: winner.rule },
    approvers: winner.rule.approvers ?? null,
    limits: winner.rule.limits ?? null,
    floorApplied: false,
    candidates,
  };
}

/**
 * SPEC.md §7 irreversibility floor, applied *after* class resolution: an action
 * declared `reversible: false` MUST NOT execute under `autonomous` or
 * `supervised`. Retrospective sampling cannot undo an irreversible action, so
 * the floor resolves to `manual` and records that it, rather than the matched
 * rule, determined the outcome.
 */
function applyFloor(resolution: Resolution, options: ResolveOptions): Resolution {
  if (options.reversible !== false) return resolution;
  if (resolution.autonomy === "manual") return resolution;
  return {
    ...resolution,
    autonomy: "manual",
    provenance: "floor",
    floorApplied: true,
  };
}
