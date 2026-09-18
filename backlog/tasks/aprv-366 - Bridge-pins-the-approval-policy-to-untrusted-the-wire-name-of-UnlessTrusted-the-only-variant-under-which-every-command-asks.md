---
id: APRV-366
title: >-
  Bridge pins the approval policy to untrusted (the wire name of UnlessTrusted),
  the only variant under which every command asks
status: To Do
assignee: []
created_date: '2026-09-18 01:30'
labels:
  - codex
  - bridge
dependencies:
  - APRV-361
priority: high
ordinal: 283000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From docs/codex-app-server-bridge.md follow-up 6 (APRV-349). Observed 2026-09-18: thread/start with approvalPolicy unless-trusted is refused (enum untrusted, on-request, granular, never); with untrusted and a read-only sandbox every command and every patch in the run produced a question. An adoption that does not pin it gates an unknown fraction of the session. The bridge sends untrusted on thread/start, refuses to proceed if the server answers with a different effective policy, and records the accepted value in the session record.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 thread/start is sent with approvalPolicy untrusted and the accepted params are recorded
- [ ] #2 A server refusing the value, or reporting another effective policy, stops the bridge with a distinct code
<!-- AC:END -->
