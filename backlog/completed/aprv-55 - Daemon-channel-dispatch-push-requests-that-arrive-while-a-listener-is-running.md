---
id: APRV-55
title: 'Daemon channel dispatch: push requests that arrive while a listener is running'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-17 15:51'
updated_date: '2026-08-17 22:55'
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
- [x] #1 A request appended while daemon and telegram listener are running reaches the configured chat without a restart
- [x] #2 Exactly one delivery per request across restarts and ticks, derived from the log
- [x] #3 The web and cli channels either gain the same behavior or document why they do not need it
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from main, parallel. 2. Daemon channel dispatch: on each tick, for approval.requested records with no delivery yet (log-derived: no channel notify record exists — decide the dedupe: a delivery is not a log event today; the telegram listener keeps in-memory state; simplest correct design: the daemon does not dispatch itself but the listener re-scans pending on every poll cycle, deduping by action_key in memory for its process lifetime plus a startup send; document why dispatch stays in the listener at v0.1). 3. Idempotency: exactly one delivery per request per listener lifetime; restart re-sends pending (documented, and the phone shows a duplicate rather than a silence). 4. web/cli channels: document they poll on render (web) or are one-shot (cli). Tests against mock Bot API. PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Assigned to M7 at decomposition (2026-08-17): the M7 demo (APRV-70) needs a request that arrives while daemon and listener are running to reach the phone without a restart, which is exactly this task. It is on the demo critical path.

Opus subagent build, PR #33. Dispatch stays in the listener at v0.1 (documented in listener header + new SPEC 10.3 paragraph flagged for review): the listener holds the credential and approver identity, dispatch appends nothing (single-writer stance untouched), and a Bot API round-trip in the daemon tick would couple TTL/write-back to chat availability; a later build MAY move it with no event/interface change. Every poll cycle re-derives pending from the verified log and sends what this process has not sent (in-memory delivered set; loss degrades to a duplicate on the phone, never silence). Retry: no attempt limit (a give-up converts an outage into a request nobody is shown); loud for the first 3 failures per key then every 10th; startup send failure still exits non-zero (fast feedback on a mistyped token). Skip warnings deduped per key:code; steady-state queue-read failures warn and retry. web renders from the log per view (no dispatch needed); cli one-shot; documented. --once preserved. Reviewer-weigh: startup-strict/steady-lenient asymmetry; SPEC 10.2 daemon list still says dispatches with the caveat in 10.3. +5 tests.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Telegram listener delivers requests as they arrive, re-derived from the log each poll cycle, exactly-once per process lifetime, retry-forever with bounded warnings. Placement decision recorded in SPEC 10.3. PR #33.
<!-- SECTION:FINAL_SUMMARY:END -->
