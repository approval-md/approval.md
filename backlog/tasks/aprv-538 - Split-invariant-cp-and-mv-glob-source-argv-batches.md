---
id: APRV-538
title: Split invariant cp and mv glob source argv batches
status: In Progress
assignee:
  - '@codex'
created_date: '2026-11-26 07:09'
updated_date: '2026-11-26 07:24'
labels: []
dependencies: []
ordinal: 409000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Bound synthetic argv classification for large cp/mv pattern expansions while preserving all guarded-path and credential classes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The cp/mv cost cases all assert less than 100 CPU ms and ratio at most 18 on Node 20 and Node 22.
- [ ] #2 Only pattern-expanded source operands are partitioned; options, target-directory values, actual destination and operand arity are preserved.
- [ ] #3 Equality, true-class and glob comparison sweeps have zero looser outcomes; relevant checks pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Partition expanded cp/mv source operands only with a conservative option grammar and fixed destination. 2. Memoize the plain partition only when inEveryReading proves invariance; judge other sources per reading and fall back otherwise. 3. Add semantic regressions, restore all cost assertions, run Node 20/22 cost tests and the three supplied comparison sweeps, then hand off for independent review.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
WIP checkpoint 2026-11-25: conservative cp/mv expanded-source partition retains options and actual destination in both argv lines; plain expanded sources are judged once only after inEveryReading proves invariance. Nonexpanded sources stay in the remaining-source line. Expanded option markers and unsupported flags fall back to the whole argv. Added semantic cases for positive plain-name classes, pattern destinations, -t before/after operands, literal/expanded -- and option fallbacks. Restored every absolute 100 CPU ms assertion and ratio18 assertion; no acceptance criteria checked. Build/typecheck/lint/conformance pass (994 vectors,314 controls); equality sweep against source baseline6390d987 gives2584/2584 identical, zero looser. Node20 cost remains red: cp source22.37, Hermes cp source24.24, Hermes mv source18.19; all absolute cases below100ms. Node22 final cost, full npm test, true-class and glob sweeps still running. Current-main comparison and independent critical reviews remain outstanding. This is an explicitly incomplete draft checkpoint, no merge or task closure.
<!-- SECTION:NOTES:END -->
