---
id: APRV-135
title: Telegram listener prunes its delivery and digest maps
status: Done
assignee: []
created_date: '2026-08-25 12:43'
updated_date: '2026-08-26 17:43'
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
- [x] #1 Terminal-and-past-TTL delivery and digest entries are dropped on a periodic sweep; a callback arriving for a dropped entry answers with the existing stale-callback path, tested
- [x] #2 Memory does not grow across a long simulated run of decided prompts, tested with a bounded-size assertion
- [x] #3 npm test passes; lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built 2026-08-26, merged in PR #128. Sweep condition: every member terminal AND older than the policy approval TTL (the gate refuses all decisions past the TTL, which is what makes an unannotated delivery droppable); no declared TTL means only observed settlements drop, against a stated 24h floor — an undecided prompt keeps its button forever, correctly. Runs from pollOnce before the long poll, rate-limited to once a minute, injectable clock, digests and their all-nonces go with the entry, log untouched. Bounded-size assertion over a long simulated run of decided prompts.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The listener's delivery and digest maps sweep settled entries past the TTL, so week-long listeners hold memory proportional to open work rather than to history. Merged in PR #128.
<!-- SECTION:FINAL_SUMMARY:END -->
