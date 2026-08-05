/**
 * Policy explanation: the decision trace behind an autonomy resolution
 * (SPEC.md §5.2, §7, and the `approval policy check|test` command of §10.1).
 *
 * `resolve()` in `policy-match.ts` answers *what* policy does with a class.
 * This module answers *why*, in two registers at once: a frozen machine-readable
 * {@link Explanation} for agents, and an ordered list of human sentences
 * (`decisionPath`) that the CLI prints verbatim. Both are derived from the same
 * `Resolution`; nothing here re-implements matching, specificity, tie-breaking
 * or the floor, because a trace that computed the answer a second time could
 * disagree with the answer — and the trace would be the more convincing lie.
 *
 * ## The three reasons an outcome is `manual` (SPEC.md §5.2, §7)
 *
 * `manual` is the system's resting state, and "why manual" is the question a
 * human actually asks. {@link Explanation.manualBecause} names exactly one of:
 *
 * - `"matched-rule"` — a `classes` rule (or `defaults.autonomy`) says `manual`.
 *   The policy was read, understood, and it says ask.
 * - `"irreversibility-floor"` — the policy granted `autonomous`/`supervised`,
 *   and §7's floor overrode it because the action declared `reversible: false`.
 *   The policy is *not* what produced this answer, and {@link
 *   Explanation.overridden} records what it did say.
 * - `"load-failure"` — the policy could not be loaded, so every class is
 *   `manual`. {@link Explanation.loadFailure} carries the code and message.
 *
 * The distinction is operational, not cosmetic: the first is working as
 * intended, the second means the caller under-declared or over-reached, and the
 * third means someone must go fix a file. Collapsing them into "manual" hides
 * a broken policy behind an answer that looks deliberate.
 *
 * ## Determinism
 *
 * Pure: no I/O, no clock, no randomness, no caching. `explain(load, class, opts)`
 * is deeply equal across calls, including `decisionPath` strings, because
 * `resolve()` already imposes a total order on candidates.
 */

import type {
  Autonomy,
  PolicyClassRule,
  PolicyLoadErrorCode,
  PolicyLoadResult,
} from "./policy-load.js";
import { resolve, type Provenance, type Specificity } from "./policy-match.js";

/**
 * Action-class grammar for a *concrete* class (not a pattern).
 *
 * `schema/policy.schema.json`'s `classPattern` admits `*` because a policy key
 * is a pattern. The thing being explained is an action, and an action's class is
 * never a wildcard: asking "what does policy do with `read.*`" is a category
 * error — `read.*` is not something an agent can do. Uppercase, whitespace,
 * empty segments and leading/trailing dots are rejected for the same reason the
 * schema rejects them in keys: they can never name a real action.
 */
export const ACTION_CLASS_PATTERN = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$/u;

/** Does `value` name a concrete action class? See {@link ACTION_CLASS_PATTERN}. */
export function isActionClass(value: string): boolean {
  return ACTION_CLASS_PATTERN.test(value);
}

/** Why a `manual` outcome is `manual`. `null` when the outcome is not manual. */
export type ManualBecause = "matched-rule" | "irreversibility-floor" | "load-failure";

/** How a candidate won, or that it merely tied. */
export type TieBreak =
  /** Strictly the most specific match; no tie to break. */
  | "specificity"
  /** Tied on specificity; won because it is the strictest autonomy. */
  | "strictest-autonomy"
  /** Tied on specificity and strictness; won on lexicographic pattern order. */
  | "lexicographic"
  /** Tied with the winner on specificity, and lost the tie-break. */
  | "tied-specificity";

/** The resolved grant, flattened for consumers that only want the answer. */
export interface ExplanationOutcome {
  autonomy: Autonomy;
  /** Approvers carried from the matched rule; `null` when unset or unmatched. */
  approvers: string[] | null;
  /** Limits carried from the matched rule; `null` when unset or unmatched. */
  limits: Record<string, number> | null;
}

/** One rule that matched the class, with why it did or did not win. */
export interface ExplanationCandidate {
  pattern: string;
  /** `[literalSegments, wildcardSegments, totalSegments]` (SPEC.md §5.2). */
  specificity: Specificity;
  autonomy: Autonomy;
  winner: boolean;
  /** Present only for the winner and for candidates tied with it. */
  tieBreak?: TieBreak;
}

/**
 * The frozen machine-readable trace. `approval policy check --json` prints this
 * object verbatim, so field names and value domains are public API.
 */
export interface Explanation {
  /** The class that was asked about, echoed back. */
  class: string;
  /** `reversible` as supplied; `null` when the caller did not state it. */
  reversible: boolean | null;
  outcome: ExplanationOutcome;
  provenance: Provenance;
  manualBecause: ManualBecause | null;
  /** Set only when the policy failed to load (`provenance: "fail-closed"`). */
  loadFailure: { code: PolicyLoadErrorCode; message: string } | null;
  /** The winning rule, or `null` for a default / fail-closed outcome. */
  matched: { pattern: string; rule: PolicyClassRule } | null;
  /**
   * What the floor overrode: the pre-floor autonomy and the rule that granted
   * it. `pattern` is `null` when the grant came from `defaults.autonomy` rather
   * than a rule. `null` overall when the floor did not apply.
   */
  overridden: { pattern: string | null; autonomy: Autonomy } | null;
  /** Every matching rule, most specific first (order from `resolve()`). */
  candidates: ExplanationCandidate[];
  /** Ordered human sentences narrating the decision; what the CLI prints. */
  decisionPath: string[];
}

/** Options for {@link explain}. */
export interface ExplainOptions {
  /** `false` engages the SPEC.md §7 irreversibility floor. */
  reversible?: boolean;
}

/** Strictness order, strictest first — mirrors `policy-match.ts`. */
const STRICTNESS: Readonly<Record<Autonomy, number>> = {
  manual: 0,
  supervised: 1,
  autonomous: 2,
};

function quote(text: string): string {
  return JSON.stringify(text);
}

function specificityText(specificity: Specificity): string {
  return `literals=${specificity[0]} wildcards=${specificity[1]} segments=${specificity[2]}`;
}

/**
 * Explain what `load`'s policy does with `actionClass`.
 *
 * Matching is delegated wholly to {@link resolve}: it is called twice, once
 * without options to observe the pre-floor autonomy and once with them for the
 * final answer. Two calls of a pure function are cheaper than a second
 * implementation of the floor.
 */
export function explain(
  load: PolicyLoadResult,
  actionClass: string,
  options: ExplainOptions = {},
): Explanation {
  const reversible = options.reversible ?? null;
  const base = resolve(load, actionClass);
  const final = resolve(load, actionClass, options);

  const decisionPath: string[] = [
    `class ${quote(actionClass)}; reversible: ${
      reversible === null ? "not stated" : String(reversible)
    }`,
  ];

  if (!load.ok) {
    decisionPath.push(
      `policy could not be loaded (${load.code}): ${load.message}`,
      "fail-closed (SPEC §5.2): an unreadable policy grants nothing, so every class is manual",
      "final: manual",
    );
    return {
      class: actionClass,
      reversible,
      outcome: { autonomy: "manual", approvers: null, limits: null },
      provenance: "fail-closed",
      manualBecause: "load-failure",
      loadFailure: { code: load.code, message: load.message },
      matched: null,
      overridden: null,
      candidates: [],
      decisionPath,
    };
  }

  decisionPath.push(`policy loaded from ${load.source.path}`);

  const candidates = annotate(final.candidates, final.matched?.pattern ?? null);
  describeCandidates(decisionPath, actionClass, candidates);
  describeWinner(decisionPath, load, base.provenance, base.autonomy, candidates);

  const overridden = final.floorApplied
    ? { pattern: final.matched?.pattern ?? null, autonomy: base.autonomy }
    : null;
  describeFloor(decisionPath, reversible, final.floorApplied, overridden);
  decisionPath.push(`final: ${final.autonomy}`);

  return {
    class: actionClass,
    reversible,
    outcome: {
      autonomy: final.autonomy,
      approvers: final.approvers,
      limits: final.limits,
    },
    provenance: final.provenance,
    manualBecause: manualBecauseOf(final.autonomy, final.floorApplied),
    loadFailure: null,
    matched: final.matched,
    overridden,
    candidates,
    decisionPath,
  };
}

/**
 * A non-manual outcome has no "because": the question only arises for `manual`.
 * The floor is checked before the rule, because when both are true it is the
 * floor that decided — the rule said something more permissive.
 */
function manualBecauseOf(autonomy: Autonomy, floorApplied: boolean): ManualBecause | null {
  if (autonomy !== "manual") return null;
  return floorApplied ? "irreversibility-floor" : "matched-rule";
}

/**
 * Copy `resolve()`'s candidates into the explanation shape, marking the winner
 * and annotating the specificity tie it did or did not have to win.
 *
 * The tie group is every candidate whose specificity equals the head's — the
 * exact set `resolve()` runs "deny beats allow" over.
 */
function annotate(
  candidates: ReadonlyArray<{ pattern: string; rule: PolicyClassRule; specificity: Specificity }>,
  winnerPattern: string | null,
): ExplanationCandidate[] {
  const head = candidates[0];
  const tied =
    head === undefined
      ? []
      : candidates.filter((candidate) => sameSpecificity(candidate.specificity, head.specificity));

  let strictest = Number.POSITIVE_INFINITY;
  for (const candidate of tied) {
    strictest = Math.min(strictest, STRICTNESS[candidate.rule.autonomy]);
  }
  const strictestCount = tied.filter(
    (candidate) => STRICTNESS[candidate.rule.autonomy] === strictest,
  ).length;

  const winnerTieBreak: TieBreak =
    tied.length <= 1 ? "specificity" : strictestCount === 1 ? "strictest-autonomy" : "lexicographic";

  return candidates.map((candidate) => {
    const winner = candidate.pattern === winnerPattern;
    const inTie = head !== undefined && sameSpecificity(candidate.specificity, head.specificity);
    const base: ExplanationCandidate = {
      pattern: candidate.pattern,
      specificity: candidate.specificity,
      autonomy: candidate.rule.autonomy,
      winner,
    };
    if (winner) return { ...base, tieBreak: winnerTieBreak };
    if (inTie) return { ...base, tieBreak: "tied-specificity" };
    return base;
  });
}

function sameSpecificity(a: Specificity, b: Specificity): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function describeCandidates(
  decisionPath: string[],
  actionClass: string,
  candidates: ExplanationCandidate[],
): void {
  if (candidates.length === 0) {
    decisionPath.push(`no class rule matched ${quote(actionClass)}`);
    return;
  }
  decisionPath.push(
    `${candidates.length} rule(s) matched ${quote(actionClass)}, most specific first:`,
  );
  for (const candidate of candidates) {
    const marks = [
      candidate.winner ? "winner" : null,
      candidate.tieBreak === undefined ? null : `tie-break: ${candidate.tieBreak}`,
    ].filter((mark): mark is string => mark !== null);
    decisionPath.push(
      `  ${candidate.pattern} [${specificityText(candidate.specificity)}] -> ${candidate.autonomy}` +
        (marks.length === 0 ? "" : ` (${marks.join("; ")})`),
    );
  }
}

function describeWinner(
  decisionPath: string[],
  load: Extract<PolicyLoadResult, { ok: true }>,
  provenance: Provenance,
  autonomy: Autonomy,
  candidates: ExplanationCandidate[],
): void {
  if (provenance === "rule") {
    const winner = candidates.find((candidate) => candidate.winner);
    const reason =
      winner?.tieBreak === "strictest-autonomy"
        ? "tied on specificity; strictest autonomy wins (deny beats allow)"
        : winner?.tieBreak === "lexicographic"
          ? "tied on specificity and on strictness; smallest pattern wins, for determinism"
          : "strictly the most specific match";
    decisionPath.push(`winner: ${winner?.pattern ?? "?"} -> ${autonomy} (${reason})`);
    return;
  }
  if (load.policy.defaults?.autonomy === undefined) {
    decisionPath.push(
      "no rule matched and defaults.autonomy is absent; the absence of a grant is not a grant -> manual",
    );
    return;
  }
  decisionPath.push(`no rule matched; defaults.autonomy -> ${autonomy}`);
}

function describeFloor(
  decisionPath: string[],
  reversible: boolean | null,
  floorApplied: boolean,
  overridden: { pattern: string | null; autonomy: Autonomy } | null,
): void {
  if (reversible !== false) return;
  if (!floorApplied || overridden === null) {
    decisionPath.push(
      "irreversibility floor (SPEC §7): outcome was already manual; the floor changed nothing",
    );
    return;
  }
  const source = overridden.pattern === null ? "defaults.autonomy" : overridden.pattern;
  decisionPath.push(
    `irreversibility floor (SPEC §7): reversible: false overrides ${source} (${overridden.autonomy}) -> manual`,
  );
}
