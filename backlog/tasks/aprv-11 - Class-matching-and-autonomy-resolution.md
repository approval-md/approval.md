---
id: APRV-11
title: Class matching and autonomy resolution
status: To Do
assignee: []
created_date: '2026-08-05 00:23'
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
- [ ] #1 match(policy, class) resolves every class in the SPEC section 5.1 canonical example to its expected rule and autonomy, including `read.*` depth matching and exact-class wins over wildcards
- [ ] #2 Equal-specificity conflicts resolve to the strictest autonomy, proven with crafted overlapping rules for every autonomy pair
- [ ] #3 An unmatched class resolves to defaults.autonomy, and a fail-closed loader result (APRV-10) resolves every class to manual — fail-closed propagation is a test, not a convention
- [ ] #4 The reversible: false floor is enforced in resolution: an irreversible action never resolves to autonomous; the chosen floor target is documented in code and flagged for human sign-off in implementation notes
- [ ] #5 The specificity ordering is precisely defined, documented in code, exhaustively tested (multi-wildcard, interior `*`, trailing `.*`, bare `*`), and flagged for human sign-off as a candidate SPEC amendment
- [ ] #6 Resolution output carries the matched rule, resolved autonomy, approvers, and limits — everything the M3 gate needs without re-deriving
<!-- AC:END -->
