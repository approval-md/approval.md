---
id: APRV-488
title: >-
  reviewSample retries a head-moved append once with a fresh read, as the gate's
  withHeadMovedRetry does
status: To Do
assignee: []
created_date: '2026-10-05 08:19'
labels:
  - agentvillage
dependencies: []
priority: medium
ordinal: 373000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up from the PR #614 refutation (note N5, APRV-483). reviewSample now reads the policy and runs the schema validator (Ajv) between its verified log read and its compare-and-append, which widens the head-moved window, and it has no retry like the gate's withHeadMovedRetry (src/core/head-retry.ts). On a busy log (the daemon sampling, hooks appending) Telegram reviews will be refused append-failed more often, and a reviewer's tap is lost to a race that says nothing about the review. The retry must re-derive everything from the fresh read (sample still open, roster, binding), never reuse the first read's decisions (SPEC §11.1 invariant 5).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A review whose append meets head-moved re-reads the verified log and re-runs every check before one more append
- [ ] #2 A test interleaves a writer between the read and the append and shows one retry records the review
- [ ] #3 A sample reviewed by the interleaved writer itself is refused already-reviewed on the retry, never reviewed twice
<!-- AC:END -->
