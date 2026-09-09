---
id: APRV-326
title: Protected-path exact replay skips unrelated historical edits
status: In Progress
assignee:
  - '@codex'
created_date: '2026-09-09 19:49'
updated_date: '2026-09-09 20:12'
labels: []
dependencies: []
modified_files:
  - src/core/protected-path-guard.ts
  - tests/protected-path-guard.test.ts
priority: high
type: bug
ordinal: 243000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-304 delivery is refused even though its exact authorized substring Edit transforms base into head byte-for-byte. The guard greedily reapplies unrelated historical insertions with anchors still present. Preserve exact-byte proof while selecting only a valid ordered sequence of verified edits; never grant partial-line substring credit.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An authorized exact substring edit can reconstruct head while irrelevant prior authorized insertions are skipped.
- [ ] #2 Multiple authorized edits preserve execution order and require exact full-file equality; missing, tampered, out-of-order and ambiguous applied edits cannot authorize an unmatched result.
- [ ] #3 Replay resource bounds fail closed and are covered by tests; existing authorization filters remain unchanged.
- [ ] #4 Focused guard tests, full suite, lint, typecheck and applicable conformance pass, with APRV-304 real evidence reproducer passing before GitHub delivery.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Preserve current verified candidate construction, hash/start/class/time checks. 2. Add deterministic bounded ordered-subsequence replay, only applying uniquely anchored edits, with explicit candidate/state/byte ceilings and exact HEAD equality. 3. Add historical-anchor pollution and adversarial regression tests. 4. Astra reviews proof and diff, validates real APRV304 evidence, then full checks and separate feature PR delivery. No SPEC, policy, CI or log changes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented deterministic skip-first ordered-subsequence replay over verified eligible Edit starts. The proof applies only unique anchors, requires a non-empty exact BASE-to-HEAD result, deduplicates same-start/same-edit aliases, excludes conflicting same-start bindings, and fails closed at 128 candidates, 2,048 exact visited states, or 64 MiB cumulative UTF-8 state, comparison, scan, and prospective-output bytes. Prospective replacement size is charged before allocation. Existing payload hash, genuine execution start, class, path, and time filters were preserved. Added focused regressions for single and composed historical pollution, ambiguous historical candidates, execution reuse, wrong-order/tampered/missing/ambiguous refusal, every resource bound, and oversized replacement output. Verification: combined npm run build plus focused protected-path-guard suite exit 0 with 56 passed and 0 failed; npm run lint exit 0; npm run typecheck exit 0; git diff --check exit 0. Full suite and the real APRV-304 evidence reproduction remain parent-owned and pending Astra proof review.

Parent proof review passed. Parent real APRV-304 integration guard exited 0 and reconstructed the protected change solely from seq 30167; report: /private/tmp/aprv326-real-aprv304-guard.json. Final broad validation on the same frozen bytes with APPROVAL_HUMAN removed: npm test exit 0, 4,035 passed, 0 failed, 1 skipped, durable log /private/tmp/aprv326-full-suite.log. npm run conformance exit 0, 293/293 vectors passed and 0 failed across six suites, durable log /private/tmp/aprv326-conformance.log. Task intentionally remains In Progress for parent delivery.
<!-- SECTION:NOTES:END -->
