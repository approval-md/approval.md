---
id: APRV-263
title: Wait for protected socket readiness in live draw integration test
status: Done
assignee:
  - '@codex'
created_date: '2026-09-05 10:04'
updated_date: '2026-09-05 10:07'
labels: []
dependencies: []
type: bug
ordinal: 200000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
PR262 CI run33959288301 failed because the existing end-to-end draw test polls only socket existence, racing the daemon chmod to0600. Source inspection confirms production correctly fails closed and the summarizer does not change this path. Scope is the test readiness predicate only; preserve daemon behavior and all other sessions.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The integration test waits for a Unix socket with owner-only0600 permissions before making its first draw request
- [x] #2 The readiness wait stays bounded and reports a useful failure; production permission checks remain unchanged
- [x] #3 Focused live-draw checks, build, lint and typecheck pass; CI runs on the updated PR head
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Sol owns only tests/live-draw.test.ts in /private/tmp/approval-gloss-delivery; parent owns the Backlog record, review and delivery. SPEC11 deterministic enforcement and fail-closed permissions remain binding. 2. Poll existence, socket type and0600 mode with a bounded wait, handling missing-path races. 3. Run focused live-draw tests and review the diff. 4. Parent records evidence and commits this task separately in PR262 as its CI-unblocking test correction; no daemon, policy or other worktrees are changed.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parent review verified a bounded200x50ms readiness loop requiring stat.isSocket and exact0600 mode, with observed path/mode/error details on timeout. The production draw server and fail-closed socket checks are unchanged. The previous feature full suite passed3426 with1skip; GitHub run33959288301 exposed the pre-existing readiness race. Lint, typecheck and diff check exit0 after removing the unused import. Sol owns only the test file; parent owns records/review/delivery.

Focused live-draw validation passed16/16 with exit0 using permitted host sockets. The initial sandbox attempt could not create usable Unix sockets and failed; the host retry passed, including daemon cleanup. Build also passed, exit0. Remaining acceptance: updated-head GitHub CI.

GitHub started CI run33959768336 on pushed fix commit a5c4407. All stated local acceptance checks passed; GitHub delivery remains subject to the required checks and merge queue. No production code or live service was changed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Removed the existing socket creation/chmod readiness race from the integration test while retaining the bounded wait and fail-closed production checks. Focused live-draw16/16, build, lint, typecheck and diff check passed. GitHub CI started on a5c4407; final PR merge verification remains the delivery step.
<!-- SECTION:FINAL_SUMMARY:END -->
