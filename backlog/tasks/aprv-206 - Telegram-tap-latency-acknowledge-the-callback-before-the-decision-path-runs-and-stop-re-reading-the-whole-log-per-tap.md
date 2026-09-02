---
id: APRV-206
title: >-
  Telegram tap latency: acknowledge the callback before the decision path runs,
  and stop re-reading the whole log per tap
status: To Do
assignee: []
created_date: '2026-09-02 04:43'
labels:
  - telegram
  - performance
dependencies: []
priority: high
ordinal: 170000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter (2026-09-02): the grant/reject buttons used to disappear at once and now take 1-3 s. Suspected cause, from src/channels/telegram.ts handleUpdate: since APRV-196 the single answerCallbackQuery is sent by the wrapper AFTER the branch finishes, and the decision branch runs recordChannelDecision, which reads and verifies the log before compare-and-append; the live log grew from about 5,200 to about 8,400 records today, so per-tap work that is linear in the log now costs seconds and will keep growing. Outcome: a tap is acknowledged to Telegram within a fixed, log-size-independent bound (the ack is the human's 'I was heard', not 'it is decided'), the button edit follows the decision as today, and the decision path stops paying O(log) per tap: verify incrementally from a cached verified head under the append lock (the daemon and channels already hold one process-lifetime view), or read only the tail the decision needs, with the chain still verified before any append (SPEC 11: every check-then-append passes through compare-and-append; enforcement reads only verified records). Measure before and after with a 10k-record fixture log. Why: the phone tap is the product's one moment; a second of lag on it reads as the gate hesitating.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A callback query is answered within 300 ms of receipt on a 10k-record log, measured in a test with a fixture log and a stubbed Telegram API, and the answer never claims a decision that has not been appended
- [ ] #2 The decision path's per-tap cost is independent of log length beyond the tail since the last verified head, proven by timing the same tap against 1k and 10k fixture logs; the verified-head cache is invalidated on any head-moved or verify failure and the chain is fully re-verified then
- [ ] #3 Exactly one answerCallbackQuery per callback is preserved (APRV-196 tests unchanged and green), and a decision that fails after the early ack edits the message to say so
- [ ] #4 docs/dogfood-cutover.md or docs/cli-reference.md states what the ack means versus what the button edit means
- [ ] #5 npm test passes; lint clean
<!-- AC:END -->
