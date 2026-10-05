---
id: APRV-487
title: >-
  Sample matching uses a review's subject_seq exclusively when present, and
  falls back to the action key only for pre-APRV-481 reviews
status: To Do
assignee: []
created_date: '2026-10-05 08:19'
labels:
  - agentvillage
dependencies: []
priority: medium
ordinal: 372000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up from the PR #614 refutation (note N3, APRV-481). sampledSubjects (src/core/audit.ts) falls back to action-key matching even when the review's subject_seq names a different sample, and channels/render-queue.ts mirrors that rule. It cannot misfire today: a second execution of the same key is refused already-executed (the refuter's probe P2 confirmed one sample per key). With subject_seq now required on new reviews, matching can use it exclusively when present, so a future path that samples a key twice cannot close the wrong sample.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A review carrying subject_seq closes only the sample at that seq, in sampledSubjects and in the render-queue projection alike
- [ ] #2 A review without subject_seq (written before APRV-481) keeps the action-key rule
- [ ] #3 A test builds two samples of one key through the writer and shows a review of the first leaves the second open
<!-- AC:END -->
