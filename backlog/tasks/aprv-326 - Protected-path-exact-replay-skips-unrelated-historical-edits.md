---
id: APRV-326
title: Protected-path exact replay skips unrelated historical edits
status: Done
assignee:
  - '@codex'
created_date: '2026-09-09 19:49'
updated_date: '2026-09-09 20:48'
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
- [x] #1 An authorized exact substring edit can reconstruct head while irrelevant prior authorized insertions are skipped.
- [x] #2 Multiple authorized edits preserve execution order and require exact full-file equality; missing, tampered, out-of-order and ambiguous applied edits cannot authorize an unmatched result.
- [x] #3 Replay resource bounds fail closed and are covered by tests; existing authorization filters remain unchanged.
- [x] #4 Focused guard tests, full suite, lint, typecheck and applicable conformance pass, with APRV-304 real evidence reproducer passing before GitHub delivery.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Preserve current verified candidate construction, hash/start/class/time checks. 2. Add deterministic bounded ordered-subsequence replay, only applying uniquely anchored edits, with explicit candidate/state/byte ceilings and exact HEAD equality. 3. Add historical-anchor pollution and adversarial regression tests. 4. Astra reviews proof and diff, validates real APRV304 evidence, then full checks and separate feature PR delivery. No SPEC, policy, CI or log changes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented deterministic skip-first ordered-subsequence replay over verified eligible Edit starts. The proof applies only unique anchors, requires a non-empty exact BASE-to-HEAD result, deduplicates same-start/same-edit aliases, excludes conflicting same-start bindings, and fails closed at 128 candidates, 2,048 exact visited states, or 64 MiB cumulative UTF-8 state, comparison, scan and prospective-output bytes. Prospective replacement size is charged before allocation. Existing payload hash, genuine execution start, class, path and time filters were preserved.

Added focused regressions for single and composed historical pollution, ambiguous historical candidates, execution reuse, wrong-order, tampered, missing and ambiguous refusal, every resource bound, and oversized replacement output. Focused guard verification passed 56/56; lint, typecheck and git diff --check each exited 0.

Parent proof review passed. The real APRV-304 report at /private/tmp/aprv326-real-aprv304-guard.json exited 0 and reconstructed SPEC.md byte-for-byte solely from policy-authorized execution.started seq 30167. The full suite at /private/tmp/aprv326-full-suite.log exited 0 with 4,036 total, 4,035 passed, 0 failed and 1 skipped. Conformance at /private/tmp/aprv326-conformance.log exited 0 with 293/293 vectors and 142 controls. PR #371 merged as 9e9b22609c0cda277a5d474bec38e04cc6ededdd on 2026-09-09.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented bounded deterministic exact replay for verified protected-file Edit authorizations, allowing irrelevant historical edits to be skipped while preserving execution order, single-use candidates, exact full-file equality and fail-closed resource ceilings. Verified with 56 focused guard tests, the real APRV-304 evidence reproducer, 4,036 full-suite tests, 293 conformance vectors, lint and typecheck; delivered by merged PR #371 (9e9b22609c0cda277a5d474bec38e04cc6ededdd).
<!-- SECTION:FINAL_SUMMARY:END -->
