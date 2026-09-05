---
id: APRV-248
title: >-
  tests/cli-setup.test.ts telegram poll-timing test fails under machine load:
  asserts more than one poll with a 120 ms message delay
status: To Do
assignee: []
created_date: '2026-09-02 22:12'
labels:
  - test
dependencies: []
priority: medium
ordinal: 193000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Seen by the APRV-228 and APRV-225 lanes on 2026-09-02: the cli-setup telegram case 'message sent after the first poll' queues the human's message 120 ms after the verb starts and asserts polls.length is greater than 1; on a loaded machine the first poll itself lands after 120 ms, finds the message, and the assertion fails, while the test passes in isolation. tests/telegram-tap-latency.test.ts has the same shape (latency bounds that hold only on an idle box). Outcome: timing-shaped tests drive the clock or the poll sequence deterministically (inject the poll schedule or a fake timer; assert on the sequence of polls observed, not on wall-clock ordering) so they pass at any load; where a real latency bound is the point (tap latency), it runs as a separate opt-in benchmark, not in npm test. Why: a suite that fails at random under load costs every lane a full re-run and teaches people to ignore red.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The cli-setup telegram poll-timing test passes deterministically under load (proven by running it with an artificial CPU load or a shortened delay that previously failed) without changing what it proves
- [ ] #2 tests/telegram-tap-latency.test.ts wall-clock bounds move behind an opt-in flag or become sequence assertions; npm test never depends on them
- [ ] #3 npm test passes; lint clean
<!-- AC:END -->
