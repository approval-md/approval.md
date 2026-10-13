---
id: APRV-261
title: >-
  tests/daemon-advance-finish.test.ts races the wall clock: the finish
  head-moved cases depend on a 300 ms sleep and a six-round coin flip
status: Done
assignee:
  - 'agent:opus-lane-f'
created_date: '2026-09-05 08:38'
updated_date: '2026-09-05 10:06'
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
- [x] #1 The finish head-moved cases construct their interleaving through an injected seam that fires between one attempt's read and its append, appending the competing record exactly once; no fixed delay and no round-retry loop remain in the harness
- [x] #2 The cases assert the observed sequence: the first attempt met a moved head, the second re-derived and landed, the competing record sits below the outcome, no execution is left dangling, the log verifies clean; the pre-APRV-233 shape (retryOnHeadMoved 1) is still pinned by the same harness and still leaves the execution dangling
- [x] #3 The file passes deterministically under load, proven by a runner that spawns busy-loop CPU hogs alongside it, and with every remaining delay in the harness at zero
- [x] #4 npm test passes; lint clean
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What the old harness was betting on

`raceFinish` constructed nothing. It took the append lockfile, spawned the
settle child, waited for a `ready` file the child wrote BEFORE its first
statement of work, slept a flat 300 ms, released the lock, and appended a
competing record through the real gate. Two independent scheduling bets, per
round:

1. That 300 ms is enough for a cold Node to boot, import `dist`, and run
   `readVerifiedRecords`. Lost, the parent's record lands first, the child then
   reads a log that already holds it, no head moves, and the retry under test is
   never exercised. The FIRST case still passes in that world, because its
   `completed.seq > fillerSeq` assertion holds trivially when the outcome was
   simply appended last. That is the worse half: green, and proving nothing. The
   second case notices and spends a round; when all six go that way the suite
   fails 'the unretried writer never lost the race in six rounds'.
2. That between `unlinkSync(lock)` and the child's next lock poll the parent
   completes a policy load, a verified read, a hash and its own lock
   acquisition. `core/log.ts` sets DEFAULT_LOCK_RETRY_MS to 20, so that is a
   20 ms budget on a machine that may be running eleven other lanes. Lost, the
   child appends first, the outcome sits below the filler, and the first case
   fails outright on 'the concurrent record did not land between the read and
   the append'.

Neither bet is visible in the code as a bet, which is why the file reads as
deterministic and behaves as a lottery.

## The fix: one seam, on the finish path

`FinishOptions.afterRead` (src/core/execute.ts), called in `finishExecution`
between `openExecution` (the read whose not-started / already-finished /
execution-delegated checks authorize the write) and the `append` that carries
`open.head`. `AdvanceInput.afterFinishRead` forwards it, beside the existing
`runner` and `retryOnHeadMoved` seams, at all three sites in
src/daemon/advance.ts that call `finishWithHeadMovedRetry`
(`settleAdvanceFinish`, `reconcileDanglingAdvance`, `recordFinish`).

Why it is safe to have on that path, stated where the field is declared: it
takes nothing and returns nothing, so no check can be relaxed by it, no field
supplied and no verdict reported. The refusals above it have already run, and
the append below it still states the head THAT read observed, so anything the
seam does to the log is caught by the compare-and-append exactly as an external
writer's record is. The strictest thing a seam can do is move the head and make
the attempt fail closed. Nothing in the runtime sets it.

## What the tests assert now

The child (tests/fixtures/advance/settle-finish.mjs) counts the seam's firings
and, on the FIRST one only, writes `ready` (meaning 'my read is done') and
blocks until the parent creates `go`. The parent polls for `ready`, appends the
competing record through the real gate (the child holds no lock while it waits,
so the append is immediate), writes `go`, and reads the child's JSON. No
lockfile is held by the test, no delay is waited out, and the six-round loops
are gone.

- 'finish: an outcome record that loses the append race re-derives and lands':
  `attempts === 2`, which is also the assertion that the first attempt met a
  MOVED HEAD and nothing else, since core/head-retry.ts re-runs the cycle on
  `append-failed` / `head-moved` and on no other refusal; then `ok === true`,
  the key's events are exactly [execution.started, execution.completed], no
  execution is dangling, `verify` is clean, and the outcome's seq is ABOVE the
  competing record's, so the outcome really was written after it.
- 'finish: the pre-APRV-233 writer loses the race and leaves the execution
  dangling': the same handshake and the same record in the same window at
  `retryOnHeadMoved: 1`, so the difference is the bound and nothing else.
  `attempts === 1`, refused `append-failed`, message matching /head moved/ (so
  a lock timeout or a schema refusal cannot pass for the 2026-09-02 line), only
  `execution.started` for the key, one dangling execution, log clean.

The property proved did not change: an outcome record whose head moved between
its read and its append re-derives and lands, and the unretried writer does not.
What changed is that both are now caused rather than awaited, and that each case
asserts the sequence the writer itself reports rather than an ordering the
scheduler happened to produce.

The only clock left in the harness is a 60 s deadline on the ready poll, and it
is a bound on FAILING: a child that dies above the seam is caught by its close
event, a child that hangs is reported instead of waited out, and no passing run
consults it.

## Global invariants (SPEC section 11.1)

This task touches invariant 5 (every check-then-append through
compare-and-append) by standing next to it, and does not weaken it. The seam
runs between the check and the append of ONE attempt, and the append still
supplies `expectedHead` from that attempt's own read; a seam that moves the head
therefore causes the refusal rather than evading it. Invariant 1 (enforcement
reads only verified records) is untouched: every attempt's read is still
`readVerifiedRecords` through `finishExecution`. Invariant 2 (no caller
timestamps on gate-typed events) is untouched: `tick()` still runs below the
seam at the write boundary. Invariant 7 (self-reported fields never reduce
scrutiny) is untouched: the seam is not a field, carries no value into any
record, and cannot lower any bar - it can only raise one.

## Verification

- `npm run build` clean, `npx tsc --noEmit` clean, `npx oxlint` clean (exit 0).
- `node --test dist/tests/daemon-advance-finish.test.js`: 6 tests, 6 pass,
  0 fail, exit 0.
- Load proof, APRV-248's method: a scratch .mjs runner spawns 48 busy-loop Node
  children (12 cores saturated four times over) and then runs the file
  repeatedly, reading each exit code. Six rounds, codes 0,0,0,0,0,0.
- Delay proof: with the harness's ready poll at `setTimeout(…, 0)` and the
  child's go-wait at `sleep(0)` - every remaining interval driven to zero -
  three more rounds under the same 48 hogs, codes 0,0,0. The polls restored to
  1 ms afterwards, because a zero-interval spin competes with the load for no
  benefit.
- Full `npm test`: 3402 tests, 3401 pass, 0 fail, 1 skipped, exit 0.

## Not reproduced on this hardware, and said plainly

The pre-fix failure could not be forced on this machine: the old harness passed
six rounds under 12 hogs and three more under 48 hogs with its 300 ms driven to
zero. That is a statement about a fast 12-core box, not a refutation - the
failure was seen in the field by other lanes, and the 20 ms lock-poll budget in
bet 2 above is a fact about the code that no amount of local green removes. What
IS demonstrated locally is the vacuity: with the delay at zero the first case
still passed, which under the old harness it could only do by proving nothing.

## Left alone, deliberately

The other four cases in this file still use durations, and they are about
durations: the cadence cases run a daemon for a fixed span to count what it did
inside an interval, and the two lock cases assert that an append completes
inside the hook's own 2 s give-up window. Those are the property, not the
harness. If the orchestrator wants the 2 s bounds moved behind an opt-in the way
APRV-248 AC2 does for tap latency, that is its own task.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The finish-race cases inject their interleaving through a read-to-append seam (FinishOptions.afterRead) with a signalling child fixture instead of a 300 ms bet; case 1 asserts two attempts and a clean landing, case 2 one attempt and append-failed with a dangling execution. Verified by daemon-advance-finish 6/6, full run 3401 pass, nine load rounds green; merged in PR #275.
<!-- SECTION:FINAL_SUMMARY:END -->
