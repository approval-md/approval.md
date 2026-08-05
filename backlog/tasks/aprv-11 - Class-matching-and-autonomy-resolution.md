---
id: APRV-11
title: Class matching and autonomy resolution
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 00:23'
updated_date: '2026-08-05 00:43'
labels: []
milestone: m-2
dependencies:
  - APRV-10
priority: high
type: feature
ordinal: 11000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The heart of the policy engine (SPEC.md section 5.2): given a resolved policy and an action's side-effect class, decide the autonomy level and attach approvers and limits. Rules: most-specific-first matching; `*` is a single-segment wildcard; a trailing `.*` matches any depth; at equal specificity the strictest autonomy wins (manual > supervised > autonomous); an unmatched class takes defaults.autonomy; and section 7's floor — reversible: false actions MUST NOT resolve to autonomous regardless of policy. Pure deterministic code, exhaustive table-driven tests, no I/O. Two definitional gaps in the SPEC must be resolved here, documented, and flagged for human sign-off in implementation notes (candidate spec amendments, never silent): (a) the precise specificity ordering (e.g. literal segment count vs wildcard positions), and (b) what the irreversibility floor lowers autonomous to (supervised vs manual).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 match(policy, class) resolves every class in the SPEC section 5.1 canonical example to its expected rule and autonomy, including `read.*` depth matching and exact-class wins over wildcards
- [x] #2 Equal-specificity conflicts resolve to the strictest autonomy, proven with crafted overlapping rules for every autonomy pair
- [x] #3 An unmatched class resolves to defaults.autonomy, and a fail-closed loader result (APRV-10) resolves every class to manual — fail-closed propagation is a test, not a convention
- [x] #4 The reversible: false floor is enforced in resolution: an irreversible action never resolves to autonomous; the chosen floor target is documented in code and flagged for human sign-off in implementation notes
- [x] #5 The specificity ordering is precisely defined, documented in code, exhaustively tested (multi-wildcard, interior `*`, trailing `.*`, bare `*`), and flagged for human sign-off as a candidate SPEC amendment
- [x] #6 Resolution output carries the matched rule, resolved autonomy, approvers, and limits — everything the M3 gate needs without re-deriving
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/core/policy-match.ts: pure matcher over the APRV-10 Policy type — pattern parse (literal segments, single-segment *, trailing .*), candidate collection, specificity per the pre-approved section 5.2 amendment, strictest-wins ties, defaults for unmatched, fail-closed propagation (loader failure -> manual everything).
2. Floor: reversible:false -> manual (pre-approved section 7 amendment), applied AFTER class resolution; resolution result records floorApplied so APRV-12 can distinguish provenances.
3. Resolution output: matched rule (pattern + rule), autonomy, approvers, limits, floorApplied, provenance enum (rule|default|fail-closed|floor).
4. Both SPEC amendments verbatim, same commit.
5. Exhaustive table-driven tests: canonical example classes, wildcard shapes (bare *, interior *, trailing .*, multi-wildcard), specificity tiers incl. each tie-break level, strictest-wins for every autonomy pair, floor over autonomous and supervised, fail-closed propagation.
6. Opus subagent implements; fable reviews, gates, finalizes, merges, pushes; then APRV-12 + APRV-13 in parallel worktrees.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Human approval recorded in advance (2026-08-05) for both SPEC amendments in the task comment (specificity ordering; irreversibility floor -> manual with trace requirement). Not silent spec edits.

Implemented by Opus subagent; fable review found nothing to override. Both pre-approved SPEC amendments landed verbatim, same commit. Judgment calls accepted (documented in module header + tests): trailing .* requires at least one further segment (read.* matches read.web, not bare read — the schema admits read and read.* as distinct policy keys, so they must not alias; bare read falls to defaults); bare * matches single-segment classes only; lexicographic tie determinism among equally-strict full ties so traces are byte-stable regardless of YAML key order; floor applies after resolution regardless of provenance (defaulted autonomous + irreversible -> manual/floor) and preserves matched/approvers/limits so the trace can show what was overridden; tests build every policy through the real loadPolicy. Notable finding for the spec record: specificity clause (3) — greater total segment count — is structurally unreachable under the current grammar (total = literals + wildcards, so ties on (1)+(2) imply a tie on (3)); implemented verbatim anyway, with a test pinning the invariant across 14 pattern shapes so a future grammar addition (e.g. **) breaks loudly rather than silently reordering precedence. Verified from wiped node_modules/dist: 357/357 tests, lint, typecheck green.
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-08-05 00:38
---
Human pre-approved SPEC amendments (2026-08-05), to land in APRV-11's commit, verbatim. Amendment 1, section 5.2 (specificity): "Pattern specificity is compared as follows: (1) more literal (non-wildcard) segments is more specific; (2) ties broken by fewer wildcard segments; (3) remaining ties by greater total segment count; a trailing `.*` counts as a single wildcard segment and contributes no literal segments. Patterns still tied are equally specific and the strictest-autonomy rule applies." Amendment 2, section 7 (floor): "The irreversibility floor resolves to `manual`: an action declared `reversible: false` MUST NOT execute under `autonomous` or `supervised` regardless of policy. Retrospective audit cannot undo an irreversible action, so execute-then-sample is not meaningful oversight for one. Implementations MUST apply the floor after class resolution and record in the decision trace when the floor, rather than the matched rule, determined the outcome."
---
<!-- COMMENTS:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
src/core/policy-match.ts: pure resolve(load, class, {reversible}) with candidates trace, specificity per the amended section 5.2, strictest-wins ties, defaults/fail-closed propagation, and the manual irreversibility floor per amended section 7 with floorApplied provenance. Both SPEC amendments same-commit. 22 new table-driven tests. Verified: 357/357, lint, typecheck from clean install.
<!-- SECTION:FINAL_SUMMARY:END -->
