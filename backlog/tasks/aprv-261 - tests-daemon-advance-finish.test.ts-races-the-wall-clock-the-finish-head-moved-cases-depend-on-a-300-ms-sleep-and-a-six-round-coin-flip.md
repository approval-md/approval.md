---
id: APRV-261
title: >-
  tests/daemon-advance-finish.test.ts races the wall clock: the finish
  head-moved cases depend on a 300 ms sleep and a six-round coin flip
status: In Progress
assignee:
  - 'agent:opus-lane-f'
created_date: '2026-09-05 08:38'
updated_date: '2026-09-05 08:40'
labels:
  - test
  - daemon
dependencies: []
priority: medium
type: bug
ordinal: 199000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The two AC-1 cases in tests/daemon-advance-finish.test.ts (APRV-233) force their interleaving with timing rather than with an injected seam. raceFinish takes the append lockfile, spawns the settle child, waits for a ready file the child writes BEFORE its read, sleeps a flat 300 ms hoping the child has got past readVerifiedRecords and is blocked on the lock, then releases the lock and immediately appends a competing record through the real gate. Whether the parent's filler or the child's blocked append reaches the freed lock first is a coin flip, and whether 300 ms was enough for the child to finish booting Node and importing dist depends on what else the machine is doing. Under load the first case fails hard on 'the concurrent record did not land between the read and the append' (the child won the lock, so the outcome sits BELOW the filler) and the second fails its six-round loop with 'the unretried writer never lost the race in six rounds' (the child never even read before the filler landed, so no head moved and nothing was pinned). Same family as APRV-248: cause the condition, never await it. Outcome: the competing record is appended from a seam that fires between the read and the append of one attempt, exactly once, so the interleaving is constructed rather than hoped for; the cases assert the sequence they observed rather than a wall-clock ordering; the delay goes to zero and the round loop goes away. The property proved does not change.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The finish head-moved cases construct their interleaving through an injected seam that fires between one attempt's read and its append, appending the competing record exactly once; no fixed delay and no round-retry loop remain in the harness
- [ ] #2 The cases assert the observed sequence: the first attempt met a moved head, the second re-derived and landed, the competing record sits below the outcome, no execution is left dangling, the log verifies clean; the pre-APRV-233 shape (retryOnHeadMoved 1) is still pinned by the same harness and still leaves the execution dangling
- [ ] #3 The file passes deterministically under load, proven by a runner that spawns busy-loop CPU hogs alongside it, and with every remaining delay in the harness at zero
- [ ] #4 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add ONE test-only seam to core: FinishOptions.afterRead in src/core/execute.ts, called in finishExecution between openExecution (the read whose not-started / already-finished / execution-delegated checks authorize the write) and the append that carries open.head. Documented for what it cannot do: it cannot relax a check, cannot supply a field, and cannot reach the append, which still states the head THAT read observed; the strictest thing a seam can do is move the head and make the attempt fail closed. No production caller sets it.
2. Thread it through src/daemon/advance.ts as AdvanceInput.afterFinishRead, into settleAdvanceFinish and recordFinish, beside the existing runner and retryOnHeadMoved seams.
3. tests/fixtures/advance/settle-finish.mjs takes a go file as well as a ready file, counts the seam firings, and on the FIRST firing only writes ready and busy-waits for go. It reports the attempt count with the settle result.
4. tests/daemon-advance-finish.test.ts: raceFinish becomes interleavedFinish. The parent no longer takes the lockfile, no longer sleeps 300 ms and no longer loops over rounds: it waits for the child's ready (which now means 'my read is done'), appends the competing record through the real gate, writes go, and awaits the child. The two cases assert the sequence they observed - attempts 2 with the default bound, the outcome above the filler, nothing dangling, verify clean; attempts 1 under retryOnHeadMoved 1, append-failed / head-moved, one dangling execution.
5. Load-proof with a scratch .mjs runner (APRV-248's method): busy-loop children on every core, the file run repeatedly, every exit code read. Also prove the OLD harness was timing-bound by driving its delay to zero.
6. npm run build, node --test on the file, oxlint, full npm test, notes.
<!-- SECTION:PLAN:END -->
