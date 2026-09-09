---
id: APRV-328
title: Ensure daemon adoption tests clean up after assertion failures
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-09 22:56'
updated_date: '2026-09-09 23:16'
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
- [ ] #1 The daemon and mock server are cleaned up when the asynchronous test succeeds or throws, preserving original assertions and error reporting.
- [ ] #2 The focused daemon adoption suite terminates successfully and a subsequent full suite produces an actual exit and summary.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Inspect the final daemon-advance-adopt async test and wrap owned resource lifecycle in reliable finally cleanup. Preserve assertions, timeout semantics and production source. Run the focused test with a bounded timeout, then the single permitted full suite and record exact exits. Prior full run was interrupted143 after more than12minutes of a sleeping sole child; isolated original tests passed7/7 in16.83seconds, so do not claim the interrupted run passed.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented test-only reliable resource cleanup in tests/daemon-advance-adopt.test.ts. The asynchronous test now starts daemon.run inside the protected body, preserves every original assertion and timeout, then sequentially stops and drains the daemon before closing the mock server. Cleanup collects errors and attempts the second closer even if the first fails; a prior assertion error is rethrown unchanged when cleanup succeeds, while combined failures remain visible. Added a focused helper regression covering original-error preservation and both-cleaner execution after a cleanup failure. Final checks: build, lint with deny-warnings, typecheck and diff check exit 0; bounded focused test passed 8/8 in 18.51 seconds, wrapper exit 0, /private/tmp/aprv328-daemon-adopt-focused-final.log; final-head full suite passed 4,097, skipped 1, failed 0, exit 0 in 544.96 seconds, /private/tmp/aprv328-full-final.log. Two earlier broad runs exited 143 and are superseded, non-passing evidence: the first diagnosed the leak and the second exercised a review-superseded cleanup ordering.
<!-- SECTION:NOTES:END -->
