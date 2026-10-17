---
id: APRV-136
title: >-
  Policy specificity criterion (3) can never fire: total segment count is
  determined by (1) and (2)
status: Done
assignee:
  - '@fable-wave1'
created_date: '2026-08-25 13:08'
updated_date: '2026-08-29 22:03'
labels:
  - spec
  - policy
  - cleanroom-review
dependencies: []
references:
  - ../approval-md-cleanroom/SPEC-GAPS.md
  - src/core/policy-match.ts
  - tests/policy-match.test.ts
priority: medium
type: task
ordinal: 123000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC section 5.2 orders pattern specificity: (1) more literal segments wins; (2) ties broken by fewer wildcard segments; (3) remaining ties by greater total segment count. For every pattern, total segments = literal segments + wildcard segments. Two patterns that tie on both (1) and (2) therefore already have equal totals, so criterion (3) is dead text: no pair of patterns exists that reaches it and is separated by it. Found by the clean-room Python implementation (SPEC-GAPS.md GAP-5 in ../approval-md-cleanroom), which implemented the three comparisons literally and proved the third a no-op; the TypeScript matcher should be checked for the same property so the two do not silently disagree if either ever changes.

Decide-and-document: either (a) delete criterion (3) and state that ties after (1) and (2) are genuine equality, resolved by the existing strictest-autonomy rule, or (b) replace it with a criterion that can actually fire (for example, comparing totals before wildcards), which changes ranking behavior and needs its own justification and tests. Option (a) is the behavior-preserving fix. Whatever is chosen, SPEC section 5.2 is amended (human sign-off) and the matcher tests pin the tie behavior explicitly, including a pattern pair that ties on (1) and (2), so the equal-specificity path is exercised rather than assumed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A written analysis in the task notes confirms or refutes unreachability against the TypeScript matcher as implemented, not just the spec text
- [x] #2 SPEC section 5.2 amended to the chosen resolution, marked for human sign-off
- [x] #3 Matcher tests pin the tie: two patterns tying on literals and wildcards resolve as equally specific and fall through to strictest autonomy
- [x] #4 If resolution (b) is chosen, ranking-change tests cover a pattern pair the old and new orders rank differently
- [x] #5 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Salvage the starved attempt: re-apply its two source edits semantically onto a fresh branch off current main (13b86e2, post-APRV-127), verifying each hunk against the code as it now stands rather than cherry-picking a diff from a stale base.
2. Re-derive the unreachability analysis against the CURRENT src/core/policy-match.ts with refreshed line citations, and record it in the implementation notes (AC1).
3. src/core/policy-match.ts: compareSpecificity third leg `return b[2] - a[2]` becomes `return 0`, with a doc block naming the arithmetic that made it dead. Module header Specificity section and the `Specificity` type doc restated as a two-part key. Keep the tuple SHAPE at three elements: policy-explain.ts renders `segments=` in the trace and verb-registry.ts pins minItems/maxItems 3 for `approval policy explain --json`, which is public API and out of scope here.
4. tests/policy-match.test.ts: retire the old "specificity level (c)" test in favour of an APRV-136 pair. First pins the arithmetic per pattern AND over every ordered pair in the pattern set (no two keys tie on (1) and (2) while differing on (3)). Second is AC3: `calendar.*.own` vs `*.write.own` over class `calendar.write.own`, both [2,1,3], swept over six autonomy assignments asserting equal specificity, provenance "rule", strictest autonomy resolved, and the matched pattern following the autonomy rather than the shape.
5. Grep the repo for any other statement of the three-criterion ordering (docs, schema, conformance vectors, README) so the spec and the code do not drift apart in a third place.
6. SPEC.md section 5.2, resolution (a): delete criterion (3) from the Specificity bullet, state that agreement after (1) and (2) is genuine equality resolved by strictest autonomy, and forbid implementations adding an ordering criterion of their own. ONE batched Edit, last step, flagged "(Amended APRV-136, pending sign-off.)". The trailing-.* GAP-2 sentence belongs to APRV-137 and is not touched here.
7. Verify npm test and npm run lint; one commit on aprv-136-specificity-criterion.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Resolution (a) landed: criterion (3) deleted as dead text, behavior preserved. Unreachability verified against the CURRENT TypeScript matcher, not just spec prose: specificityOf (src/core/policy-match.ts ~line 248) returns [segments - wildcards, wildcards, segments], so the third element is the sum of the first two by construction; compareSpecificity reached its third leg only when both earlier legs tied, which forces equal totals, so the leg returned zero on every reachable input. Matches the clean-room GAP-5 finding. Code: compareSpecificity now returns 0 after the wildcard leg with the arithmetic stated in a comment; the tuple keeps its third element (display-only, rendered by policy-explain as segments=N; narrowing it would churn the public explain trace). Tests: the old specificity level (c) test reframed to pin the arithmetic plus an all-pairs assertion (no two patterns agree on literals and wildcards while differing on totals), and a new AC3 test where a.*.c and *.b.c tie at [2,1,3] and fall through to strictest autonomy, asserted in both declaration orders. SPEC 5.2 Specificity bullet amended (flagged APRV-136 pending sign-off), applied via a granted policy.edit. Verification: the lane suite showed shifting failures under six-way parallel test contention; a SERIAL re-run of the full suite on the branch was clean (fail 0, exit 0), lint clean. 11.1 invariants: none weakened; deterministic core only. Landed as commits f8a1b01 + 2ad0dd1 on aprv-136-specificity-criterion. Note for the record: the lane originally wrote these notes into its worktree copy of this task file (committed in f8a1b01, reverted in 2ad0dd1); this entry restores them to the primary via the CLI.

Merged: PR #143 as main 5325680 through the merge queue, after one main merge-in (b7ddca0) to pick up the PR #144 telegram-mock keepalive fix for the node-20 memory flake that was blocking the queue entry. AC4 is vacuously satisfied: resolution (a) was chosen, no ranking behavior changed, so no ranking-change tests apply. AC1 analysis recorded in these notes with current-code citations; AC2 the SPEC 5.2 amendment landed flagged pending sign-off via a granted policy.edit (2ad0dd1); AC3 the tie tests pin equal specificity falling through to strictest autonomy in both declaration orders plus the all-pairs arithmetic assertion; AC5 serial full suite fail 0 on the branch, lint clean, and the queue candidate ran the full gate green including the node-20 floor.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Dead criterion (3) removed from policy specificity ordering in both the matcher and SPEC 5.2 (flagged pending sign-off): every segment is literal or wildcard, so ties on both counts force equal totals, and surviving ties are genuine equality resolved by strictest autonomy. Behavior preserved byte for byte. Merged as PR #143 (main 5325680); verified with the reframed specificity tests, the new tie pins, serial suite fail 0, lint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
