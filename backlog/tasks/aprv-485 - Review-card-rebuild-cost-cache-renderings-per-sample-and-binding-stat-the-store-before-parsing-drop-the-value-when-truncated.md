---
id: APRV-485
title: >-
  Review card rebuild cost: cache renderings per sample and binding, stat the
  store before parsing, drop the value when truncated
status: To Do
assignee: []
created_date: '2026-10-05 08:18'
labels:
  - agentvillage
dependencies: []
priority: medium
ordinal: 370000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up from the PR #614 refutation (note N1, APRV-480). renderingFor (src/cli/audit-card.ts) runs payloadHash and a full JSON.stringify(material, null, 2) before it slices, and openReviewCards rebuilds the card of every open sample on every listener cycle in which the log grew, so per-cycle work is O(sum of payload sizes) on top of loadPayload's own parse and hash. A truncated rendering also keeps value: material, the whole object, although the comment says the card keeps a bounded prefix. The party under review chooses payload sizes, so this is a cost an agent can steer.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A card rebuild for an unchanged (sampleSeq, bound payload hash) reuses the previous rendering instead of re-hashing and re-serialising
- [ ] #2 The payload store file is stat'ed and a file over the render bound is not parsed for a card
- [ ] #3 A truncated rendering carries no full value object
- [ ] #4 A test pins per-cycle work as bounded when the log grows by one unrelated record
<!-- AC:END -->
