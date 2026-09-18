---
id: APRV-365
title: >-
  Bridge custody of the app-server socket: decide and enforce who may connect,
  since a pending request is replayed to the next connection
status: To Do
assignee: []
created_date: '2026-09-18 01:30'
labels:
  - codex
  - bridge
dependencies:
  - APRV-361
priority: medium
ordinal: 282000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From docs/codex-app-server-bridge.md follow-up 5 (APRV-349). Source read at b0659c5: a disconnected client leaves the question pending and a reconnect replays it to whatever connects next. Observed 2026-09-18 on 0.155.0: a client crash ended the server process (exit 0), so the replay path was not exercised live; it stays a source claim. Until custody is settled the bridge claim is this client decided every question it was asked, which is narrower than every question was decided here. Decide the transport (stdio child owned by the bridge versus a socket others could reach), enforce it, and state the resulting claim in the design note and SPEC if it becomes a stated property.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The bridge starts the server as its own child over stdio, or documents and enforces the socket custody rule when it does not
- [ ] #2 The design note states which claim the bridge makes and why
<!-- AC:END -->
