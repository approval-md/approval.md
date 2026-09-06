---
id: APRV-282
title: 'doctor live-draw tests the daemon socket with a connect, not a stat'
status: To Do
assignee: []
created_date: '2026-09-06 07:19'
labels:
  - doctor
dependencies: []
type: bug
ordinal: 208000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On 2026-09-05 the daemon had exited but .approval/daemon/draw.sock remained on disk; doctor's live-draw row reported the socket present and owner-only, and the operator concluded the gate was up while every Telegram tap sat unconsumed. A stale socket file is the normal aftermath of a process that died; presence proves nothing. Connect to the socket (and close) and report connected, refused (stale file: name the pid file or mtime), or absent.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 live-draw reports fail with fix "approval up" when the socket file exists but refuses connections
- [ ] #2 live-draw passes only on a successful connect; tests cover present-and-listening, present-and-refusing, absent
<!-- AC:END -->
