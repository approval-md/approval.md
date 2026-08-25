---
id: APRV-136
title: >-
  Policy specificity criterion (3) can never fire: total segment count is
  determined by (1) and (2)
status: To Do
assignee: []
created_date: '2026-08-25 13:08'
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
- [ ] #1 A written analysis in the task notes confirms or refutes unreachability against the TypeScript matcher as implemented, not just the spec text
- [ ] #2 SPEC section 5.2 amended to the chosen resolution, marked for human sign-off
- [ ] #3 Matcher tests pin the tie: two patterns tying on literals and wildcards resolve as equally specific and fall through to strictest autonomy
- [ ] #4 If resolution (b) is chosen, ranking-change tests cover a pattern pair the old and new orders rank differently
- [ ] #5 npm test passes; lint clean
<!-- AC:END -->
