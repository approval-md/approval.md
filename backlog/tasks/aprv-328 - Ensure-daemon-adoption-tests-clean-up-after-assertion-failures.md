---
id: APRV-328
title: Ensure daemon adoption tests clean up after assertion failures
status: Done
assignee:
  - '@codex-sol'
created_date: '2026-09-09 22:56'
updated_date: '2026-09-17 00:26'
labels: []
dependencies: []
modified_files:
  - tests/daemon-advance-adopt.test.ts
priority: high
type: bug
ordinal: 247000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The full suite stalled in daemon-advance-adopt after an assertion path could leave its daemon timer and mock server open. Ensure test resources close on both success and failure without changing runtime behavior or weakening assertions.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The daemon and mock server are cleaned up when the asynchronous test succeeds or throws, preserving original assertions and error reporting.
- [x] #2 The focused daemon adoption suite terminates successfully and a subsequent full suite produces an actual exit and summary.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Inspect the final daemon-advance-adopt async test and wrap owned resource lifecycle in reliable finally cleanup. Preserve assertions, timeout semantics and production source. Run the focused test with a bounded timeout, then the single permitted full suite and record exact exits. Prior full run was interrupted143 after more than12minutes of a sleeping sole child; isolated original tests passed7/7 in16.83seconds, so do not claim the interrupted run passed.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented test-only reliable resource cleanup in tests/daemon-advance-adopt.test.ts. The asynchronous test now starts daemon.run inside the protected body, preserves every original assertion and timeout, then sequentially stops and drains the daemon before closing the mock server. Cleanup collects errors and attempts the second closer even if the first fails; a prior assertion error is rethrown unchanged when cleanup succeeds, while combined failures remain visible. Added a focused helper regression covering original-error preservation and both-cleaner execution after a cleanup failure. Final checks: build, lint with deny-warnings, typecheck and diff check exit 0; bounded focused test passed 8/8 in 18.51 seconds, wrapper exit 0, /private/tmp/aprv328-daemon-adopt-focused-final.log; final-head full suite passed 4,097, skipped 1, failed 0, exit 0 in 544.96 seconds, /private/tmp/aprv328-full-final.log. Two earlier broad runs exited 143 and are superseded, non-passing evidence: the first diagnosed the leak and the second exercised a review-superseded cleanup ordering.

Closeout verification (lane/closeouts, 2026-09-16). The code is on main: PR #380 "feat: bind Codex workspace proposals and close test resources" is MERGED at aebb204fb5a181ffc81d58da75cdfb7805e2b619 (gh pr view 380 --json mergeCommit,state). PR CI run 34416802253 passed every required job (ci, full gate node 22 shards 1-3, protected paths, classify tier); the merge commit's own run 34418188770 concluded success.

AC1 re-verified against the merged bytes rather than against intent: tests/daemon-advance-adopt.test.ts:85-120 defines withReliableCleanup, which runs every registered closer whether the body resolved or threw, rethrows the original body error unchanged when all cleanups succeed, and otherwise raises an AggregateError carrying the body error as cause. The async adoption test at :562-601 registers the daemon stop and mock.close() through it, so both handles close on the assertion path as well as the success path. Assertions and timeouts are unchanged; no src/ file is touched by the diff.

AC2 re-verified by running the focused suite from a clean worktree at merged main: node scripts/run-tests.mjs --only daemon-advance-adopt, wrapper exit 0, tests 8 / pass 8 / fail 0 (log /tmp/lane5.log). The suite terminates instead of hanging, which is the regression's whole point. The full-suite half of AC2 stands on the run already recorded above (4,097 passed, 1 skipped, 0 failed, exit 0, 544.96s, /private/tmp/aprv328-full-final.log) plus the three merged full-gate shards in run 34416802253, all of which produced an actual exit and summary.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Wrapped the daemon-adoption async test's owned resources in withReliableCleanup so the daemon timer and mock server close on the failure path as well as the success path, with a focused regression proving the original assertion error survives cleanup and that every closer still runs after one of them throws. No runtime source changed and no assertion weakened. Verified on merged main (PR #380, merge aebb204): focused suite 8/8, exit 0; full suite 4,097 passed / 1 skipped / 0 failed, exit 0; PR CI run 34416802253 and merge run 34418188770 both green.
<!-- SECTION:FINAL_SUMMARY:END -->
