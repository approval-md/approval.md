---
id: APRV-484
title: >-
  Post-cap approvals for hook classes set to ask: carry the pending request past
  the harness cap and replay the call on a later tap (DATA-213's core half)
status: To Do
assignee: []
created_date: '2026-10-05 06:51'
labels:
  - agentvillage
dependencies: []
priority: medium
ordinal: 369000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Oct 11 configurability page (agentvillage-data DATA-322) offers a hook class set to ask, waiting inside the tool call up to the harness cap (240 s, yielding wait from 0.4.1); a tap after the cap finds a withdrawn request and the agent must re-propose. This task removes that limit: week-one fast-follow, not an Oct 11 requirement. Core half of agentvillage-data DATA-213 (carry/replay).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A request still pending at the cap is carried, not withdrawn, when the class is configured for carry
- [ ] #2 A later grant replays the call or re-proposes it, and the resident is told which
- [ ] #3 No execution.started is written without a grant
<!-- AC:END -->
