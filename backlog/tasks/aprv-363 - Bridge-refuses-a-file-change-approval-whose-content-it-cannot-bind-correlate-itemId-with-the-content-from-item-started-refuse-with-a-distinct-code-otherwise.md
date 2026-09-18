---
id: APRV-363
title: >-
  Bridge refuses a file-change approval whose content it cannot bind: correlate
  itemId with the content from item/started, refuse with a distinct code
  otherwise
status: To Do
assignee: []
created_date: '2026-09-18 01:30'
labels:
  - codex
  - bridge
dependencies:
  - APRV-361
priority: high
ordinal: 280000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From docs/codex-app-server-bridge.md follow-up 3 (APRV-349). Observed 2026-09-18: item/fileChange/requestApproval carries only itemId, threadId, turnId, startedAtMs, reason null and grantRoot null; no patch content and no cwd. The content arrives earlier on a different notification. A client that approves the identifier approves a reference, not bytes. The bridge must correlate the itemId with the content it recorded from item/started (or the turn diff), classify that content, and refuse with a distinct machine-readable code when the correlation cannot be made or the recorded content is absent.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A file-change request with a correlated content record is classified against that content and its hash is in the registered payload
- [ ] #2 A file-change request with no correlated content is declined with its own refusal code, and the code is in the conformance refusal union
<!-- AC:END -->
