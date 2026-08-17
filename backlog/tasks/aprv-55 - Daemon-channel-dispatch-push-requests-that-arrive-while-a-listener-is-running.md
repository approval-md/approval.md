---
id: APRV-55
title: 'Daemon channel dispatch: push requests that arrive while a listener is running'
status: To Do
assignee: []
created_date: '2026-08-17 15:51'
updated_date: '2026-08-17 21:41'
labels: []
milestone: m-9
dependencies: []
priority: high
type: feature
ordinal: 54000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found during the M5 proof (APRV-51): the v0.1 Telegram listener sends every pending manual request at startup and then long-polls for decisions only. A request that arrives while daemon and listener are already running is not pushed to the phone until the listener restarts. SPEC 10.2 assigns channel notification dispatch to the daemon ("dispatches channel notifications"), which APRV-39 deliberately left out of scope. Either the daemon dispatches on approval.requested through the channel contract, or the listener re-scans the queue on each poll cycle; the choice belongs to the implementer after reading the channel contract and the daemon tick. Notifications must be idempotent (one delivery per request, re-derived from the log, never remembered).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A request appended while daemon and telegram listener are running reaches the configured chat without a restart
- [ ] #2 Exactly one delivery per request across restarts and ticks, derived from the log
- [ ] #3 The web and cli channels either gain the same behavior or document why they do not need it
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Assigned to M7 at decomposition (2026-08-17): the M7 demo (APRV-70) needs a request that arrives while daemon and listener are running to reach the phone without a restart, which is exactly this task. It is on the demo critical path.
<!-- SECTION:NOTES:END -->
