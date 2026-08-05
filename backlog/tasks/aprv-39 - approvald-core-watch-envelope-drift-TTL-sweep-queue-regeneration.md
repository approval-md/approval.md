---
id: APRV-39
title: 'approvald core: watch, envelope drift, TTL sweep, queue regeneration'
status: To Do
assignee: []
created_date: '2026-08-05 14:18'
labels: []
milestone: m-7
dependencies:
  - APRV-38
priority: high
type: feature
ordinal: 39000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC section 10.2: the daemon watches the backlog folder and the log, validates new and changed envelopes, applies policy, expires TTLs, re-renders projections. This task is the loop itself, foreground under approval daemon run (adopting the channel-listen pattern; backgrounding is the operator's business in v0.1): fs watch on the task folder and log; envelope validation on change with envelope.drift appended when a file contradicts the log (section 6.3); lazy TTL sweep appending approval.expired (system actor) on schedule; QUEUE.md regeneration on every relevant event; loop-escalation surfacing (the gate already refuses — the daemon makes it visible in status/queue outputs). Single-writer stance per CLAUDE.md: the daemon is the sole writer when running; document interaction with CLI verbs (advisory lockfile already serializes appends; the daemon tolerates external appends by re-reading).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval daemon run watches the task folder and log, validating changed envelopes and appending envelope.drift (schema-valid, system actor) when a file contradicts the log
- [ ] #2 TTL sweep appends approval.expired for lapsed live requests on a configurable interval, idempotent with lazy expiry
- [ ] #3 QUEUE.md regenerates on every relevant event via the real renderer; regeneration is debounced and never partial
- [ ] #4 Escalated tasks are surfaced in the daemon's own output and status; a clean shutdown leaves no lockfile or torn state
- [ ] #5 Daemon appends all go through the real gate/log paths; log verify stays clean across every daemon test; tests drive a real daemon process against temp dirs
<!-- AC:END -->
