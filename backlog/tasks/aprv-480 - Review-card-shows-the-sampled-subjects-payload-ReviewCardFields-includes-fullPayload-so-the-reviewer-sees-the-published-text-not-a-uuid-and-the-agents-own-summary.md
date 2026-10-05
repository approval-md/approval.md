---
id: APRV-480
title: >-
  Review card shows the sampled subject's payload: ReviewCardFields includes
  fullPayload so the reviewer sees the published text, not a uuid and the
  agent's own summary
status: To Do
assignee: []
created_date: '2026-10-05 06:51'
labels:
  - agentvillage
dependencies: []
priority: high
ordinal: 365000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Supervised-retro, in scope for Oct 11 (Carter, 2026-10-04), from claude-main's investigation. The review card for a sampled subject currently shows a uuid and the agent's own summary of what it did, so the reviewer cannot judge the text that was actually published. ReviewCardFields should include fullPayload so the card carries the payload the subject sent.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The review card renders the payload bytes, or their hash when the channel cannot show them, and says which of the two it shows
- [ ] #2 A test per card renderer covers the bytes case and the hash-only case, including the label
- [ ] #3 Docs updated: what a reviewer sees per channel
<!-- AC:END -->
