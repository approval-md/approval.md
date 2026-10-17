---
id: APRV-12
title: 'Policy explain: core trace + approval policy check|test CLI'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 00:23'
updated_date: '2026-08-05 00:54'
labels: []
milestone: m-2
dependencies:
  - APRV-11
priority: medium
type: feature
ordinal: 12000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC.md section 10.1 ships `approval policy check|test <class>`: explain what policy does with a class. Explainability is what makes fail-closed trustworthy — a human must be able to see why an action routes to manual. Core explain() produces a machine-readable decision trace (candidate rules with specificity, the winner and why it won, applied floors and defaults, final autonomy/approvers/limits); the CLI wraps it under the APRV-9 conventions: frozen exit codes, frozen --json shapes, --help documenting both. The explain trace must also answer honestly when the policy failed to load: the fail-closed manual answer carries explicit provenance (which load failure caused it) so a broken policy is visible, not silently strict.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 explain(policy, class, {reversible?}) returns a machine-readable trace: every candidate rule with its specificity, the winning rule and tie-break reasoning, floor and default applications, and the final resolution
- [x] #2 `approval policy check <class>` and `approval policy test <class>` both work per SPEC section 10.1; --json shape and exit codes are frozen, documented in --help, and pinned by subprocess tests
- [x] #3 With a missing or unparseable policy the CLI still answers (manual, fail-closed) and the output carries explicit provenance of the load failure, distinct from a successful parse — covered by tests
- [x] #4 Exit codes follow the APRV-9 frozen table; any addition is documented in --help and pinned by tests
- [x] #5 Human-readable output shows the decision path clearly enough that a policy author can see why a class resolves as it does
- [x] #6 The trace distinguishes three manual provenances as separate machine-readable values: manual-because-matched-rule, manual-because-irreversibility-floor, and manual-because-load-failure (human-mandated; binds the section 7 floor amendment's trace requirement)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/core/policy-explain.ts: explain(load, class, {reversible?}) building on resolve()'s candidates/provenance — trace with every candidate (pattern, specificity, autonomy), winner + tie-break reasoning, floor/default application, and the three manual provenances (matched-rule vs irreversibility-floor vs load-failure with load error code).
2. src/cli/ additions: approval policy check|test <class> [--reversible] [--policy <path>] [--json]; frozen exit codes per APRV-9 table (0 success incl. fail-closed answers, 2 usage, 4 io); --help documents shape + codes.
3. Human output: decision path readable by a policy author; JSON shape frozen.
4. Subprocess tests: parse success/failure provenances, floor case, both verbs, --json shapes verbatim, --help content, usage errors.
5. Opus subagent in isolated worktree parallel with APRV-13; fable reviews, merges, gates, finalizes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent in isolated worktree; fable review found nothing to override; verified against the real APPROVAL.md end-to-end (deps.add -> manual/matched-rule, read.web -> autonomous, vcs.push.main --reversible false -> manual with floor-over-supervised shown). Accepted decisions: --reversible takes explicit true|false (three states exist — unstated/null, true, false — a bare flag can only express two, and would either make the floor unreachable or floor everything); overridden.pattern is nullable because the floor can override defaults.autonomy where no rule exists to name; exit codes deliberately use only 0/2/4 — a fail-closed manual answer on a broken policy is the ANSWER (exit 0 with manualBecause load-failure and provenance in the output), never an error, stated at length in --help; explain() is pure and delegates wholly to resolve() (called twice to read the pre-floor autonomy), re-implementing no matching logic. The three human-mandated manual provenances are distinct machine-readable values (matched-rule / irreversibility-floor / load-failure), each pinned by core and CLI tests. Verified on the merged tree from wiped node_modules/dist: 411/411, lint, typecheck green.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
src/core/policy-explain.ts + approval policy check|test: machine-readable trace with candidates/specificity/tie-breaks, three distinct manual provenances, floor-override reporting, and fail-closed answers with load-failure provenance at exit 0; frozen --json shapes and exit codes documented in --help and pinned by 34 tests. Verified: 411/411, lint, typecheck from clean install plus live-policy smoke.
<!-- SECTION:FINAL_SUMMARY:END -->
