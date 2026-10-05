---
id: APRV-483
title: >-
  reviewSample checks the reviewer against the class's approvers roster,
  including the CLI --as path, the way grants do
status: To Do
assignee: []
created_date: '2026-10-05 06:51'
labels:
  - agentvillage
dependencies: []
priority: high
ordinal: 368000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Supervised-retro core piece (in scope for Oct 11). Grants check the sender against the class's approvers roster; reviewSample does not, and the CLI --as path can name anyone. A review by a non-roster reviewer must not count.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A non-roster reviewer is refused with a named code, on every channel and on the CLI --as path
- [ ] #2 A test covers roster, non-roster and --as
- [ ] #3 Docs state the roster rule for reviews
<!-- AC:END -->
