---
id: APRV-233
title: >-
  Daemon advance: recording the outcome loses the race with concurrent appends,
  leaves the execution dangling, and re-runs the advance every tick
status: In Progress
assignee:
  - 'agent:opus-lane-r'
created_date: '2026-09-02 20:15'
updated_date: '2026-09-02 20:54'
labels:
  - daemon
  - bug
dependencies: []
priority: high
ordinal: 188000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Seen 2026-09-02 on Carter's approval up --advance right after APRV-211 (PR #235) landed: the advance pushed records-log-2026-09-02 (PR #240), then execution.completed could not be appended because a hook record landed between the read and the append (head moved, expected 13986 found 13987), the execution daemon-log-advance-1-13984 was left dangling, and the next periodic tick treated the advance as not done and ran it again about 90 s later (ticks 2, 5, 8 each re-pushed the same branch), so the 15-minute cadence was not honoured. Two defects. (1) recordFinish appends on the head the advance read before its git work and does not re-read and retry on head-moved; every other gate writer retries a bounded number of times since APRV-150 (compare-and-append unchanged: re-read, re-derive, append on the fresh head). (2) A failed outcome record must not reset the cadence: the advance already happened, so the next tick should reconcile the dangling execution (record completed or failed against the fresh head) and honour --advance-interval, never push again inside the interval for the same owed span. Also check whether the advance holds the log append lock across the git side effect; during these runs the harness hook refused every command on the machine with append-failed (another writer holds events.jsonl.lock, gave up after 2000 ms), which suggests the in-process authorize step or the finish step held the lock while the child ran. If it does, the lock must be released before the child is awaited. Why: the cadence exists to remove taps and noise; an advance that re-pushes every 90 s and stalls every hook on the machine is worse than the manual step it replaced.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A test with a concurrent appender between the advance's read and its finish proves execution.completed lands (bounded retry on head-moved, through compare-and-append) and no execution is left dangling
- [ ] #2 A test proves that after a finish failure the next tick reconciles the dangling execution and does not run another advance inside --advance-interval for the same owed span
- [ ] #3 A test proves the log append lock is not held while the advance child runs (a concurrent appender succeeds within the hook's 2 s window during a 5 s advance stub)
- [ ] #4 The 2026-09-02 transcript (advance at ticks 2, 5, 8; dangling daemon-log-advance-1-13984 and -13991) is explained in the notes
- [ ] #5 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. recordFinish gains a bounded head-moved retry, local to daemon/advance.ts (APRV-150's bound of 3; retry only on append-failed with append.code head-moved; each attempt is a fresh finishExecution, so a fresh verified read, fresh not-started/already-finished checks and a fresh compare-and-append against the head THAT read observed). Shaped as one small function so APRV-236's shared core helper can replace the loop body.
2. When the bound is spent the attempt carries pendingFinish {actionKey, exitCode, reason, note}: the outcome this process OBSERVED and could not record. The daemon holds it and the next tick settles it first, before any trigger is evaluated. Nothing guesses an outcome and nothing auto-closes another process's dangling execution.
3. A failed outcome record must not reset the cadence. In advanceIfDue: an unsettled pendingFinish blocks every new attempt; and a dangling advance execution in the log, or a last attempt that already published, holds the next attempt until the interval has elapsed, so the record-count trigger no longer runs around --advance-interval for a span an advance already carried.
4. The append lock is released before the git side effect. Under the lock: verify the chain, check the staged set, read the working log, pin its bytes as a git blob. Outside it: fetch, commit-on-base, push, gh - with the pinned blob forced into the scratch index so the commit carries exactly the verified bytes.
5. Tests: a real two-writer race through the real append path; a reconcile-then-interval case; a 5 s advance stub with a concurrent appender inside 2 s; an appender that lands during the verb's push phase through the progress seam.
6. npm test, oxlint, notes.
<!-- SECTION:PLAN:END -->
