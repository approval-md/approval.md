---
id: APRV-135
title: Telegram listener prunes its delivery and digest maps
status: To Do
assignee: []
created_date: '2026-08-25 12:43'
labels:
  - channels
  - telegram
dependencies: []
priority: low
ordinal: 127000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Born 2026-08-25 from the APRV-115 builder's out-of-scope observation. The listener's deliveries map was already never pruned (documented as such) and APRV-115's digests map joins it: both grow for every prompt sent and are only released on process exit. Not a correctness issue (nonces are consumed and terminal states annotate), but a listener left running for weeks holds memory proportional to every prompt it ever sent, and APRV-110's ambient runtime makes week-long listeners the normal case rather than the exception. Outcome: entries whose every member is in a terminal state (decided, expired, withdrawn) and past the policy approval TTL are dropped on a periodic sweep; a live button can never reference a dropped entry precisely because terminal-plus-TTL is the condition under which no callback can still be honoured. Keep the sweep in the listener process; the log is untouched (this is process memory, no events).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Terminal-and-past-TTL delivery and digest entries are dropped on a periodic sweep; a callback arriving for a dropped entry answers with the existing stale-callback path, tested
- [ ] #2 Memory does not grow across a long simulated run of decided prompts, tested with a bounded-size assertion
- [ ] #3 npm test passes; lint clean
<!-- AC:END -->
