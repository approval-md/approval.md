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
 * (`read`, `deploy`) and nothing deeper. `*.*` is a wildcard followed by a
 * trailing wildcard, so it matches any class of TWO OR MORE segments. (APRV-137
 * corrects this line, which read "exactly two". The trailing `.*` consumes one
 * or more, so `*.*` matches `a.b` and `a.b.c` alike. `matchesPattern` always
 * behaved this way; only the comment was wrong.)
 *
 * ## Specificity (SPEC.md §5.2, Specificity bullet)
 *
 * Candidates are ordered by the two-part key
 * `(literalSegments DESC, wildcardSegments ASC)`. A trailing `.*` counts as one
 * wildcard segment and contributes no literals. Patterns still tied are equally
 * specific, and then "deny beats allow" decides: the strictest autonomy among
 * the tied rules wins.
 *
 * ## Fail-closed
 *
 * ## The autonomy split (amended SPEC.md §5.2, APRV-127)
 *
 * A rule may declare `supervised-live` (with a `live_rate`) or `supervised-retro`
 * as well as the pre-split `supervised`. Both collapse onto the one enforced
 * `supervised` autonomy, and the difference travels beside it as
 * `Resolution.supervision`: `"live"` means a `live_rate` fraction of the class's
 * actions stop at the human gate BEFORE executing, `"retro"` means every action
 * proceeds and a fraction is reviewed AFTERWARDS. Bare `supervised` is `"retro"`,
 * with a load-time note from `policy-load.ts` naming the alias.
 *
 * Nothing about the SELECTION lives here: this module is pure, and selection
 * needs an operator-held secret. `core/sampler.ts` derives it, and `core/gate.ts`
 * applies it at intake.
 *
 * A not-ok {@link PolicyLoadResult} resolves **every** class to `manual` with
 * provenance `"fail-closed"` — see `policy-load.ts`. An absent
 * `defaults.autonomy` is likewise `manual` (provenance `"default"`): the schema
 * permits omitting `defaults`, and the absence of a grant is not a grant.
 *
 * ## `human-only` (amended SPEC.md §5.2, APRV-185)
 *
 * A fourth level, and the strictest: an action reserved to human hands, taken
 * outside agent execution entirely. It resolves like any other level and
 * nothing here refuses anything — this module is pure — but every enforcement
 * path downstream refuses it with the code `class-human-only`, so a resolution
 * carrying it authorizes no request, no decision, no token and no run.
 *
 * The fail-closed target stays `manual` and deliberately does not follow the
 * new head of the strictness table. A policy that cannot be parsed must remain
 * recoverable through its own gate, and a broken file whose every class became
 * `human-only` would put the repair behind a level that admits no gated repair.
 * Failing closed raises the scrutiny an action gets; it does not remove the
 * path by which a human fixes the file.
 */

import type {
  Autonomy,
  DeclaredAutonomy,
  PolicyClassRule,
  PolicyLoadResult,
  SupervisionMode,
} from "./policy-load.js";

/** Where a {@link Resolution}'s autonomy came from. */
export type Provenance =
  /** A `classes` rule matched. */
  | "rule"
  /** No rule matched; `defaults.autonomy` (or its absent-means-manual form). */
  | "default"
  /**
   * Amended SPEC.md §5.2 (APRV-266): no rule matched a `policy.edit` sub-class,
   * so the `policy.edit` line itself decided it. Distinct from `"rule"` because
   * the pattern that decided does not MATCH this class — a reader of the trace
   * has to be able to see that the class inherited rather than matched — and
   * distinct from `"default"` because `defaults.autonomy` did not decide it.
   */
  | "inherited"
  /** The policy failed to load; everything is `manual`. */
  | "fail-closed"
  /** The §7 irreversibility floor overrode the resolved autonomy. */
  | "floor";

/**
 * Specificity key: `[literalSegments, wildcardSegments, totalSegments]`.
 * Ordered on the first two elements only, as literals DESC then wildcards ASC.
 * `totalSegments` is the sum of the other two, so it can never break a tie they
 * did not already break; it is carried for the explain trace, which reports it.
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
  /**
   * Amended SPEC.md §5.2 (APRV-127): what the winning rule (or the default)
   * actually WROTE, before the split was collapsed onto {@link Autonomy}. A
   * reader that wants to echo the policy's own word — `explain`, the amendment
   * differ, a channel's provenance line — uses this; a reader that wants to
   * know what is enforced uses `autonomy`.
   */
  declaredAutonomy: DeclaredAutonomy;
  /**
   * `"live"` or `"retro"` when `autonomy` is `supervised`, `null` otherwise.
   * Bare `supervised` is `"retro"` — see `policy-load.ts`'s alias note.
   */
  supervision: SupervisionMode | null;
  /**
   * The declared `live_rate` for a `supervised-live` class, else `null`.
   *
   * Never `null` for a live class that reached here through the schema, which
   * requires the key. A live class that somehow carries no usable rate resolves
   * to `1` rather than to `null`: see {@link supervisionOf} for why the missing
   * rate is read as "gate all of them".
   */
  liveRate: number | null;
  /**
   * The declared `retro_rate` for a supervised class, else `null` (amended
   * SPEC.md §5.2, APRV-183).
   *
   * `null` is not "do not sample": it is "this class declared no rate of its
   * own", and the retrospective sampler reads it as the instruction to fall back
   * to `audit.supervised_sample_rate`. A rate the schema would have rejected
   * cannot arrive here, and one that somehow does is read as absent, which puts
   * the class back on the global rate rather than on a number nobody wrote.
   */
  retroRate: number | null;
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

/**
 * Strictness order, strictest first (SPEC.md §5.2 "deny beats allow"), over the
 * DECLARED vocabulary.
 *
 * `supervised-live` sits between `manual` and the retrospective modes because it
 * is the only supervised mode that can stop an action before it happens: at rate
 * 1 it is `manual`, at any lower rate it is strictly more scrutiny than review
 * after the fact. `supervised` and `supervised-retro` share a rank because they
 * are the same level under two spellings; the lexicographic tie-break in
 * {@link compareCandidates} then decides between two equally specific rules that
 * spell it differently, deterministically and without preferring either word.
 *
 * Exported because `core/policy-explain.ts` needs the same order to name the
 * tie-break in its trace, and a private mirror of this table there is exactly
 * the drift a decision trace must never have from the decision.
 *
 * The RATE is not part of the order. A tie between `supervised-live 0.5` and
 * `supervised-live 0.01` is a tie between two equally specific rules that
 * disagree about a fraction, and ordering by rate would let a policy author move
 * a rule's precedence by editing a number they were only tuning. The
 * lexicographic tie-break settles it, exactly as it settles every other tie.
 *
 * APRV-185 puts `human-only` above `manual` at the head of the table, and this
 * table is the one place the ordering exists: the tie-break below,
 * `core/policy-explain.ts`'s trace, and `core/agents-md.ts`'s draft merge all
 * read it and hold no copy. It sits above `manual` because it is strictly more
 * scrutiny — `manual` says a human decides and an agent then acts, `human-only`
 * says the human acts — so a tie between the two must resolve to the level that
 * lets no agent execute.
 */
export const STRICTNESS: Readonly<Record<DeclaredAutonomy, number>> = {
  "human-only": 0,
  manual: 1,
  "supervised-live": 2,
  supervised: 3,
  "supervised-retro": 3,
  autonomous: 4,
};

/**
 * Collapse a declared level onto the enforced {@link Autonomy} plus its
 * supervision mode and live rate.
 *
 * Pure and total. A `supervised-live` rule whose `live_rate` is absent, or is
 * not a usable proportion, resolves to **1** — every action in the class is
 * gated. `policy.schema.json` requires the key, so this branch is unreachable
 * for a policy that loaded; it is here as the fail-closed backstop, and the
 * direction is the one the rest of this runtime takes everywhere else. The
 * alternative reading, "a rate we could not understand means gate none of them",
 * would turn a typo into a silently disabled control, which is the failure this
 * project exists to prevent.
 *
 * `human-only` (APRV-185) collapses onto itself carrying nothing, exactly as
 * `manual` and `autonomous` do. It names no supervision because it describes no
 * agent execution to supervise, and the schema forbids both rates on it, so
 * there is no fraction here for a reader to misread as live.
 */
export function supervisionOf(declared: DeclaredAutonomy, rule: PolicyClassRule | null): {
  autonomy: Autonomy;
  supervision: SupervisionMode | null;
  liveRate: number | null;
  retroRate: number | null;
} {
  if (declared === "human-only" || declared === "manual" || declared === "autonomous") {
    return { autonomy: declared, supervision: null, liveRate: null, retroRate: null };
  }
  // APRV-183. A `retro_rate` is carried by every supervised mode, live included:
  // the fraction a live draw does not gate executes and stays in the
  // retrospective pool, so that pool has a rate whether or not the class also
  // gates some of its actions. An unusable value is read as absent, which leaves
  // the class on the global rate rather than on an invented one.
  const retro = rule?.retro_rate;
  const retroRate =
    typeof retro === "number" && Number.isFinite(retro) && retro > 0 && retro <= 1 ? retro : null;
  if (declared !== "supervised-live") {
    return { autonomy: "supervised", supervision: "retro", liveRate: null, retroRate };
  }
  const rate = rule?.live_rate;
  const usable = typeof rate === "number" && Number.isFinite(rate) && rate > 0 && rate <= 1;
  return { autonomy: "supervised", supervision: "live", liveRate: usable ? rate : 1, retroRate };
}

/**
 * The refusal every enforcement path prints for a `human-only` class (APRV-185).
 *
 * One text, in one place, for the same reason `STRICTNESS` is one table: the
 * code `class-human-only` is frozen in four separate unions (`core/gate.ts`,
 * `core/token.ts`, `core/execute.ts`, and the hook's own), and four hand-written
 * explanations of one condition would disagree about what a caller should do the
 * first time one of them was edited.
 *
 * `whatWasRefused` is the verb's own half of the sentence, so the message names
 * the thing that did not happen as well as the reason it cannot.
 */
export function humanOnlyRefusal(actionClass: string, whatWasRefused: string): string {
  return (
    `class ${actionClass} resolves to human-only (amended SPEC.md §5.2, APRV-185), so ${whatWasRefused}. ` +
    `A human performs this action outside agent execution: the policy reserves the class to human hands rather than routing it through the gate, so there is no approval to seek, no approver to ask, and no token that could exist for it. ` +
    `This is not a rejection — nobody decided anything, and asking again with a better summary will get the same answer. ` +
    `Nothing was appended. If the class should be gated rather than reserved, amend APPROVAL.md and re-attest it.`
  );
}

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

/**
 * Compare two specificity keys; negative when `a` is MORE specific.
 *
 * There are only two ordering legs, not three. Every segment is either a
 * literal or a wildcard, so `totalSegments === literalSegments +
 * wildcardSegments` for every pattern. Two keys that tie on literals and again
 * on wildcards therefore have equal totals by arithmetic, and a third leg
 * comparing totals could never separate them. SPEC.md §5.2 used to list that
 * comparison as criterion (3); it was removed as dead text (APRV-136). Keys
 * reaching the end of this function are genuinely equal, and the caller
 * resolves them with the strictest-autonomy rule.
 */
function compareSpecificity(a: Specificity, b: Specificity): number {
  if (a[0] !== b[0]) return b[0] - a[0]; // more literals first
  if (a[1] !== b[1]) return a[1] - b[1]; // fewer wildcards first
  return 0; // equal literals and wildcards implies equal totals: a real tie
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
  declaredAutonomy: "manual",
  supervision: null,
  liveRate: null,
  retroRate: null,
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
 * 3. With no matching rule, a class in the `policy.edit.*` namespace (APRV-266)
 *    inherits the `policy.edit` line when that line is a rule, with provenance
 *    `"inherited"`; otherwise the result is `defaults.autonomy` — or `manual`
 *    when `defaults` or `defaults.autonomy` is absent — with provenance
 *    `"default"`.
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
    ? fromParentOrDefaults(load, actionClass, candidates)
    : fromRules(candidates);

  return applyFloor(resolution, options);
}

/**
 * The `policy.edit` sub-class namespace (APRV-266), as a resolution rule.
 *
 * A routed `protected_paths` entry names a class the policy MAY declare and
 * need not: routing `design/` to `policy.edit.design` and then writing no
 * `policy.edit.design` line is a reasonable first step, and the answer to it
 * should be the `policy.edit` line — the line that governed that path before
 * the routing existed — rather than `defaults.autonomy`.
 *
 * That is not just ergonomics. A repository whose `policy.edit` is
 * `supervised-live 0.1` and whose default is `manual` would find every routed
 * path GATED the moment it adopted routing, which reads as the feature being
 * broken and invites the author to fix it by loosening something. Falling back
 * to the line the path is a sub-class of makes the adoption a no-op until the
 * author declares otherwise, which is what an additive key should be.
 *
 * Deliberately not generalized to "any dotted class falls back to its parent".
 * §5.2's matching grammar already gives an author `policy.edit.*` for that, and
 * a universal parent walk would silently change the resolution of every class
 * in the taxonomy — `read` is `manual` in this repository BECAUSE `read.*` does
 * not cover it, and a parent walk would make that pin unstatable. One
 * namespace, because one namespace is what the runtime itself synthesizes
 * classes in.
 */
const ROUTED_NAMESPACE = "policy.edit.";

/** The line a routed class inherits from, or the ordinary default. */
function fromParentOrDefaults(
  load: Extract<PolicyLoadResult, { ok: true }>,
  actionClass: string,
  candidates: Candidate[],
): Resolution {
  if (!actionClass.startsWith(ROUTED_NAMESPACE)) return fromDefaults(load, candidates);
  const parent = resolve(load, "policy.edit");
  // Only a RULE is inherited. When the `policy.edit` line is itself absent the
  // sub-class has nothing to inherit and falls to `defaults.autonomy`, which is
  // the same answer by a shorter road and keeps `"inherited"` meaning "a
  // `policy.edit` rule decided this".
  if (parent.provenance !== "rule") return fromDefaults(load, candidates);
  return {
    ...parent,
    provenance: "inherited",
    // `candidates` is this class's own, which is empty: nothing matched it.
    // The parent's matched rule stays in `matched`, so a trace can name the
    // line that decided without claiming it matched.
    candidates,
  };
}

/** Build the no-rule-matched resolution. */
function fromDefaults(
  load: Extract<PolicyLoadResult, { ok: true }>,
  candidates: Candidate[],
): Resolution {
  // Absent `defaults.autonomy` is `manual`: the schema allows omitting
  // `defaults` entirely, and by the fail-closed principle the absence of a
  // grant is not a grant.
  const declared = load.policy.defaults?.autonomy ?? "manual";
  return {
    ...supervisionOf(declared, null),
    declaredAutonomy: declared,
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
    ...supervisionOf(winner.rule.autonomy, winner.rule),
    declaredAutonomy: winner.rule.autonomy,
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
 *
 * ## The floor is a floor, not a proof (amended SPEC.md §7, APRV-127)
 *
 * This is the enforcement point for APRV-127's rule that `supervised-retro`
 * REFUSES an action declaring `reversible: false`: such an action never resolves
 * supervised at all, in either mode, so there is no retrospective path for it to
 * take. Retrospective review of an irreversible action is regret with a paper
 * trail, and the grammar must not offer it.
 *
 * What the floor is NOT is evidence that anything else is reversible.
 * `reversible` is SELF-REPORTED by the action's own declaration. A truthful
 * `false` raises scrutiny to `manual`, which is the safe direction and the only
 * direction this field is allowed to move anything (global invariant 4). A false
 * claim of `reversible: true` — or an omitted claim — simply fails to raise it,
 * leaving the class's declared autonomy in force. So the floor catches the
 * honest declaration of irreversibility; it cannot catch a lie, and no code here
 * pretends otherwise. The control that answers the lie is the class rule: an
 * author who does not trust a class's declarations writes `manual` for the
 * class, which no declaration can loosen.
 *
 * The floor also clears `supervision`, `liveRate` and `retroRate`. An action
 * pushed to `manual` is not a supervised action with a mode; it is gated, and
 * leaving either fraction on it would tell a downstream reader that a draw still
 * applies to an action every one of whose instances stops for a human.
 *
 * ## The floor stops at `manual` (amended SPEC.md §7, APRV-185)
 *
 * The floor raises to `manual` and never to `human-only`, in either direction.
 * It never raises a class TO `human-only`, because the floor is a runtime
 * escalation computed from a self-reported field, and `human-only` is a
 * declaration a policy author makes about who performs an action. Deriving one
 * from the other would let a `reversible: false` on an envelope reserve a class
 * to human hands that its author put behind an ordinary gate. And it never
 * lowers a `human-only` class either: the early return below covers it, so an
 * irreversible action in a human-only class stays human-only rather than being
 * "raised" to the weaker level.
 */
function applyFloor(resolution: Resolution, options: ResolveOptions): Resolution {
  if (options.reversible !== false) return resolution;
  if (resolution.autonomy === "manual" || resolution.autonomy === "human-only") return resolution;
  return {
    ...resolution,
    autonomy: "manual",
    // Every field says manual, including the declared one. A resolution whose
    // `autonomy` read `manual` while its `declaredAutonomy` still read
    // `autonomous` would be one field a consumer could read and get the
    // pre-floor answer. What the rule actually said is not lost: it is in
    // `matched.rule.autonomy`, and `core/policy-explain.ts` records it as the
    // grant the floor overrode.
    declaredAutonomy: "manual",
    supervision: null,
    liveRate: null,
    // A gated action has no retrospective pool to be drawn from, so it carries
    // no retrospective rate either.
    retroRate: null,
    provenance: "floor",
    floorApplied: true,
  };
}
