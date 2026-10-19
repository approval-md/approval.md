---
id: APRV-525
title: >-
  Telegram reminder, stale summary, digest, paced opening, card headings and
  /queue in plain words (P-9 T1 copy)
status: In Progress
assignee: []
created_date: '2026-10-18 15:59'
labels: []
dependencies: []
references:
  - 'https://github.com/approval-md/approval.md/pull/657'
priority: medium
ordinal: 402000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A listener restart re-sends every pending request (SPEC.md:554). Before P-9 the resident saw action keys, task ids, class tallies, grouping keys, hook-timing text and COMPUTED/CLAIMED jargon in the stale summary, the digest and /queue, two reminders when stale requests were grouped, and a paced opening that never said whether older buttons still work. This task is the copy and rendering half (T1) of the read lane APRV-P9-reminder-resend-read: items 1-4, 6 and 7. Item 5 (one message per technical card) is its own task. PR #657.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A restart with 2+ stale requests sends one reminder: the stale summary counts everything re-sent and the banner is skipped; all-stale stays one message; live-only keeps the #655 banner
- [ ] #2 No action key, task id, sha256, store path, renderer id or COMPUTED/CLAIMED or hook-timing text in the stale summary, the digest member lines, the paced reminder or /queue
- [ ] #3 The paced opening says which buttons work right now, true for direct bot and relay, including when fewer are shown than pending
- [ ] #4 The card keeps its action-key row (REQUIRED_PROMPT_ROWS), its canonical payload block byte for byte (SPEC.md:568) and every origin tag (the relay quiet hold reads the ttl tag)
- [ ] #5 The claimed author id renders as one line, capped, so it cannot draw a second heading
- [ ] #6 0 lines changed in SPEC.md, APPROVAL.md and conformance/; npm test and the conformance suite green
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built on branch approval/p9-reminder-copy. Copy and rendering only: decisions, nonces, callback_data, the log, the gate, grouping, pacing, retry and the listener lifecycle are unchanged. tests/telegram-mock.ts callbackDataFor now matches buttons by callback_data verb and action ref; label-to-data pairing is pinned by two assertions in channels-telegram.test.ts (fold round 1, S2). summaryLines now takes the oldest by timestamp (the /queue header named the newest as oldest). Touches no SPEC §11 global invariant.
<!-- SECTION:NOTES:END -->
