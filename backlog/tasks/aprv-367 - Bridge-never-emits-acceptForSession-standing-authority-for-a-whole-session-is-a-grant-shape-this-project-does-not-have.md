---
id: APRV-367
title: >-
  Bridge never emits acceptForSession: standing authority for a whole session is
  a grant shape this project does not have
status: To Do
assignee: []
created_date: '2026-09-18 01:30'
labels:
  - codex
  - bridge
dependencies:
  - APRV-361
priority: medium
ordinal: 284000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From docs/codex-app-server-bridge.md follow-up 7 (APRV-349). The decision vocabulary includes acceptForSession, which converts one human decision into standing authority for the rest of the session, and cancel or abort, which stop the turn rather than deny the action. The bridge answers accept and decline only. This task pins that: a policy or channel decision that would map to acceptForSession is refused with its own code, and cancel is never sent as a stand-in for a denial. The probe already holds this rule in its own source; the bridge and its conformance vectors must too.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The reply encoder can produce accept and decline only; any other value is a type error and a refusal at runtime
- [ ] #2 Conformance vectors pin the two-word vocabulary
<!-- AC:END -->
