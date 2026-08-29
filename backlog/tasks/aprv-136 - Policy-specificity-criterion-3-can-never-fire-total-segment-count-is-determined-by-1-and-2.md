---
id: APRV-136
title: >-
  Policy specificity criterion (3) can never fire: total segment count is
  determined by (1) and (2)
status: In Progress
assignee: []
created_date: '2026-08-25 13:08'
updated_date: '2026-08-29 15:43'
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
- [ ] #2 SPEC section 5.2 amended to the chosen resolution, marked for human sign-off
- [x] #3 Matcher tests pin the tie: two patterns tying on literals and wildcards resolve as equally specific and fall through to strictest autonomy
- [ ] #4 If resolution (b) is chosen, ranking-change tests cover a pattern pair the old and new orders rank differently
- [x] #5 npm test passes; lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Resolution (a) chosen: criterion (3) deleted as dead text, behavior preserved.

1. Unreachability re-verified against the CURRENT TypeScript matcher, not just the spec prose. In src/core/policy-match.ts, specificityOf at line 248 builds the key by splitting the pattern on dots, counting wildcard segments, and returning [patternSegments.length - wildcards, wildcards, patternSegments.length]. The third element is therefore the sum of the first two by construction, for every pattern, with no branch that can break the identity. compareSpecificity at the old line 258 then compared literals DESC, wildcards ASC, and finally totals DESC. Reaching the third leg required a[0] === b[0] and a[1] === b[1]; those two equalities force a[0] + a[1] === b[0] + b[1], hence a[2] === b[2], hence the third leg returned exactly zero on every input that reached it. Confirmed, matching the clean-room GAP-5 finding: the TypeScript matcher had the same dead comparison as the spec text.

2. Code change. compareSpecificity in src/core/policy-match.ts now returns 0 after the wildcard leg, with a comment naming the arithmetic that makes a third leg impossible. The Specificity tuple keeps its third element: it is display-only, reported by specificityText in src/core/policy-explain.ts line 155 as segments=N, so narrowing the tuple would churn the explain trace for no semantic gain. The module header specificity section and the Specificity type doc were updated from a three-part key to a two-part key.

3. Behavior preservation. No ordering changes, because the removed leg returned 0 on every input that could reach it. Candidate ordering, the explain trace, and every tie outcome are byte-identical.

4. Tests. Specificity level (c) was reframed: it previously called the third leg a defensive tie-break implemented for conformance with the written rule, which is stale once the rule is gone. It now pins the arithmetic the deletion rests on, and adds an all-pairs assertion that any two patterns agreeing on literals and wildcards have identical keys. A new test states AC3 directly: a.*.c and *.b.c both key as 2, 1, 3, and resolve as equally specific falling through to strictest autonomy, asserted in both declaration orders so the fall-through is a property of the tie and not of YAML key order.

5. SPEC 11.1 global invariants touched: none are weakened. The change is confined to the deterministic core, and it makes the ordering function total and explicit rather than carrying a leg that never fires. Fail-closed is untouched: full ties still resolve to the strictest autonomy, so ambiguity still resolves to the stricter path. No log, schema, or write-boundary code is involved, and no dependency was added.

6. Verification. npm run lint clean. npm test totals 2305 tests, which is the 2304 green baseline on main plus the one new tie test. Two full runs each showed 3 failures, but the failing set CHANGED between runs, covering memory does not grow across a long run of decided prompts, a manual command is allowed when a grant lands mid-wait, a rejected request denies with hook-rejected, and a grant that lapsed its TTL carries nothing. All four are daemon and timing dependent and none touch policy matching; the shifting set indicates contention from parallel sessions, not a regression from this change, which is pure deterministic code that cannot affect daemon timing. Note also that running the policy-match suite directly under tsx fails on schema loading, an artifact of bypassing the build, so npm test is the valid gate.

7. AC2 is NOT landed: the SPEC.md edit is manual-class and timed out twice at the approval hook, so the human was unavailable. AC4 is not applicable, since resolution (a) was chosen and no ranking behavior changed. Everything else is committed; the SPEC amendment awaits a tap and must be replayed verbatim as a single Edit on SPEC.md section 5.2, replacing the Specificity bullet.

OLD TEXT, exact: - **Specificity.** Pattern specificity is compared as follows: (1) more literal (non-wildcard) segments is more specific; (2) ties broken by fewer wildcard segments; (3) remaining ties by greater total segment count; a trailing `.*` counts as a single wildcard segment and contributes no literal segments. Patterns still tied are equally specific and the strictest-autonomy rule applies.

NEW TEXT, exact: - **Specificity.** Pattern specificity is compared as follows: (1) more literal (non-wildcard) segments is more specific; (2) ties broken by fewer wildcard segments; a trailing `.*` counts as a single wildcard segment and contributes no literal segments. Patterns still tied are equally specific and the strictest-autonomy rule applies. An earlier criterion (3) broke remaining ties by greater total segment count; it was removed because it could never fire. Every segment is either literal or wildcard, so two patterns tying on (1) and on (2) have equal totals by arithmetic, and a tie surviving both criteria is genuine equality. (Amended APRV-136, pending sign-off.)
<!-- SECTION:NOTES:END -->
