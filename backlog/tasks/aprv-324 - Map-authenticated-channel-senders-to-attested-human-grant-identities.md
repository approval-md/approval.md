---
id: APRV-324
title: Map authenticated channel senders to attested human grant identities
status: To Do
assignee: []
created_date: '2026-09-08 22:53'
labels: []
dependencies:
  - APRV-249
references:
  - 'https://github.com/approval-md/approval.md/issues/137'
priority: medium
type: feature
ordinal: 241000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
GitHub issue #137 requests grant attribution to the actual Telegram callback sender rather than the shared listener process identity. Design an operator-attested sender-to-human mapping inside the existing machine trust boundary, coordinated with APRV249, without treating caller-supplied identity as proof.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A reviewed design defines sender mapping, unknown-sender refusal, per-class approvers, audit fields and safe migration from listener identity.
- [ ] #2 Implementation tests cover two distinct senders, missing or stale mapping, spoofed request fields, unauthorized sender and concurrent decisions before changing production attribution.
- [ ] #3 Issue #137 remains open until implemented and verified; documentation states exactly what the channel can authenticate.
<!-- AC:END -->
