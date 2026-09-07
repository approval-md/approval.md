---
id: APRV-293
title: 'Proposals: solo-dev quickstart and no-daemon mode'
status: Done
assignee:
  - '@claude'
created_date: '2026-09-07 02:34'
updated_date: '2026-09-07 02:35'
labels:
  - indie
  - proposal
dependencies: []
priority: medium
type: docs
ordinal: 217000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two design proposals under docs/proposals/, proposed and not built, no SPEC amendment. solo-dev-quickstart.md: why the current README loses a solo developer at step two, an 'approval quickstart' three-question setup, an 'approval guard -- <command>' verb that folds register/request/wait/run into one call with the token spent in-process, and a five-line solo policy template (defaults autonomous, five named manual classes). no-daemon-mode.md: the daemon's responsibilities against a solo need, the waiting verb acting as the runtime for its own wait, lazy housekeeping under the append lock, a poll lease for concurrent waiters, doctor detection, and the boundary with git-hosted logs. Each ends with the tasks it implies; those are filed when picked up, not now. Motivation: adoption by indie developers building personal apps, alongside labs (GOVERNANCE.md).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 docs/proposals/solo-dev-quickstart.md and docs/proposals/no-daemon-mode.md exist with a status line saying proposed, not built, and no SPEC amendment
- [x] #2 README 'Where to look next' names both proposals in one sentence next to the existing hardened-authorization pointer
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Copy both proposals into docs/proposals/. 2. README pointer in Where to look next. 3. Commit, push, PR, arm.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Drafted from the licensing session of 2026-09-06/07. Commercial-arm material was kept out of the repo on purpose; the proposals mention a hosted channel only as one more channel with Telegram's trust boundary.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Two proposal docs added and linked from the README. Verified by reading both files and the README hunk; no code or SPEC change.
<!-- SECTION:FINAL_SUMMARY:END -->
