---
id: APRV-362
title: >-
  Bridge binds argv, not a rendering: record the re-parse of the shell-joined
  command beside the received string so a mismatch is visible
status: To Do
assignee: []
created_date: '2026-09-18 01:30'
labels:
  - codex
  - bridge
dependencies:
  - APRV-361
priority: medium
ordinal: 279000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From docs/codex-app-server-bridge.md follow-up 2 (APRV-349). The item-based API delivers command as one shell-joined string (observed 2026-09-18: /bin/zsh -lc with the model command quoted inside), while the legacy API delivers argv. The classifier reads argv. Decide between the two APIs for the bridge; if the item-based string is what the bridge must consume, re-parse it, record the re-parse alongside the received string in the registered payload, and refuse with a distinct code when the re-parse cannot round-trip to the received bytes. proposedExecpolicyAmendment carries the argv the server itself would apply and is a candidate source to compare against.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The registered payload carries both the received command string and the argv the bridge classified, and a round-trip mismatch is refused with its own machine-readable code
- [ ] #2 Tests cover quoting edge cases (single and double quotes, redirections, heredoc markers) against the recorded probe requests
<!-- AC:END -->
