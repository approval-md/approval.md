---
id: APRV-481
title: >-
  audit.reviewed carries subject_seq, sampled_subject_hash and verdict (required
  on new reviews); the payload hash only when the card rendered the bytes
status: To Do
assignee: []
created_date: '2026-10-05 06:51'
labels:
  - agentvillage
dependencies: []
priority: high
ordinal: 366000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Supervised-retro core piece (in scope for Oct 11). The follower and dbt halves (claude-main) read audit.reviewed, so the record must name which subject was sampled and the verdict. Required on new records; old records read unchanged. The payload hash is recorded only when the card actually rendered the bytes (see APRV-480), so a hash never claims more than the reviewer saw.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The schema requires subject_seq, sampled_subject_hash and verdict on new audit.reviewed records; old records still read unchanged
- [ ] #2 The payload hash field is present only when the card rendered the bytes, absent otherwise; tests cover both
- [ ] #3 The follower-facing field names are documented in one place and posted for the follower and dbt halves
<!-- AC:END -->
