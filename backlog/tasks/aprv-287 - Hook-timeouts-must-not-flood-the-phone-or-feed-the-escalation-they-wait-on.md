---
id: APRV-287
title: Hook timeouts must not flood the phone or feed the escalation they wait on
status: To Do
assignee: []
created_date: '2026-09-06 22:33'
labels:
  - hook
  - daemon
  - telegram
dependencies: []
priority: high
ordinal: 213000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Tonight (2026-09-06) three hook waits expired in a row while the daemon was dead behind a stale socket. Each expired wait (a) left its request open until the policy TTL, so the daemon restart redelivered a dozen dead requests to Carter's phone one message each, and (b) counted as a failed side-effecting call, so the loop-escalation floor (SPEC §10.2, APRV-280) deepened on the very timeouts it was causing: escalation routes reads to the phone, unanswered reads time out, timeouts extend the escalation. Carter asked for fixes for both the flood and the feedback loop.

Three changes, one task, because they share the hook's timeout path:

1. Withdraw on timeout. When `approval hook` gives up waiting it appends `approval.withdrawn` (reason `timeout`, existing enum) for its own request, unless the identical command is retried from the same cwd inside a short grace window (default 5 min), in which case the retry adopts the open request exactly as today. A tap on a withdrawn request authorizes nothing and the channel says so in the reply.
2. Collapse redelivery. On daemon start or listener reconnect, pending requests older than the hook wait are delivered as ONE summary message naming the count and the classes, with a single reject-all action; fresh requests keep one message each. Navigation stays process memory per §10.1 delivery pacing: losing the summary degrades to showing requests again.
3. A timeout is not a failure. The escalation counter reads execution outcomes; an expired wait records a withdrawal, not `execution.failed`, and must not advance the counter. Reads already change nothing (APRV-280); this closes the same hole for side-effecting classes whose wait simply expired.

SPEC: §10.1 hook timeout paragraph and §10.2 escalation counting, both marked (Amended APRV-<this>, pending sign-off). Invariant touched: 6 (any new refusal code is pinned) and the append-only rule (withdrawal is a new record, nothing is edited).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An expired hook wait appends approval.withdrawn (reason timeout) for its request unless the same command from the same cwd retries within the grace window; tests/cli-hook.test.ts covers withdrawn, adopted-by-retry, and tap-after-withdraw (authorizes nothing, channel reply says so)
- [ ] #2 Daemon start and listener reconnect deliver requests older than the hook wait as one summary message with a reject-all action; tests/channels-telegram.test.ts covers the collapsed and the fresh case, and losing the summary degrades to re-showing requests
- [ ] #3 An expired wait does not advance the loop-escalation counter; tests/loop-escalation (or the APRV-280 suite) proves three expired waits leave the floor closed while three execution.failed still open it
- [ ] #4 SPEC §10.1 and §10.2 amended with pending-sign-off markers; docs/claude-code-hook.md documents the grace window and the withdrawal; CHANGELOG entry
<!-- AC:END -->
