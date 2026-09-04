---
id: APRV-233
title: >-
  Daemon advance: recording the outcome loses the race with concurrent appends,
  leaves the execution dangling, and re-runs the advance every tick
status: Done
assignee:
  - 'agent:opus-lane-r'
created_date: '2026-09-02 20:15'
updated_date: '2026-09-04 23:35'
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
- [x] #1 A test with a concurrent appender between the advance's read and its finish proves execution.completed lands (bounded retry on head-moved, through compare-and-append) and no execution is left dangling
- [x] #2 A test proves that after a finish failure the next tick reconciles the dangling execution and does not run another advance inside --advance-interval for the same owed span
- [x] #3 A test proves the log append lock is not held while the advance child runs (a concurrent appender succeeds within the hook's 2 s window during a 5 s advance stub)
- [x] #4 The 2026-09-02 transcript (advance at ticks 2, 5, 8; dangling daemon-log-advance-1-13984 and -13991) is explained in the notes
- [x] #5 npm test passes; lint clean
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built (APRV-233)

Four changes, in the order the incident produced them.

**1. The outcome record retries.** `daemon/advance.ts` gained
`finishWithHeadMovedRetry`: `isFinishHeadMoved` (code `append-failed` AND
`append.code === head-moved`, so only the precondition retries and never a lock
timeout, a corrupt log or a real verdict) plus a bounded loop over WHOLE
`finishExecution` calls. An attempt is a fresh `readVerifiedRecords`, a fresh
not-started / already-finished / execution-delegated derivation against that
read, and an append carrying the head THAT read observed. Nothing crosses an
attempt except the exit code and the reason, which are facts about the world
rather than conclusions about the log. The bound is APRV-150's three, spelled
again rather than imported (core/gate.ts keeps its copy private), and
`AdvanceInput.retryOnHeadMoved` lowers it only, clamped 1..3, which is the seam
one harness uses to pin both the pre-fix denial and the post-fix recovery.

LOCAL ON PURPOSE, AND BRIEFLY: APRV-236 is lifting a shared head-moved retry
into core for every gate writer. This is deliberately one function around one
whole operation, so that helper can replace the loop body without touching a
caller here.

**2. An outcome that could not be recorded is carried, not lost.** When the
bound is spent, the attempt returns `pendingFinish` (the action key, the exit
code and the reason the failing append would have written) and the daemon holds
it. The top of the next tick settles it through `settleAdvanceFinish`, on the
head as it stands then, before any trigger is evaluated, and that tick does
nothing else either way. `already-finished` counts as settled: something closed
the cycle in the meantime and there is nothing left to carry.

**3. A dangling advance is reconciled from evidence, and blocks a new one.**
`reconcileDanglingAdvance` closes a cycle this process does not remember, and
only on evidence: the records the cycle was authorized to publish are
demonstrably on a records branch, read through the same `publishedState` the
cadence and the doctor row read. When they are, `execution.completed` lands with
a note saying so. When they are NOT, nothing is written: the execution stays
open for a person, the daemon warns with the repair, and no new advance starts.
`authorizeAdvance` refuses `advance-unreconciled` over any open advance cycle,
which is what replaces the bare `already-executed` the field transcript shows.

**4. The append lock is released before the git side effect.** `logAdvance`
wrapped the whole verb (git fetch, commitOnBase, git push, gh pr list, gh pr
create) in `withAppendLock`. It now holds it for `snapshotUnderLock` only:
verify the chain, check the staged set, read the working log, and pin its exact
bytes with `git hash-object -w`. Everything after runs unlocked, and
`commitOnBase` gained `blobs`, which forces the pinned object into the scratch
index with `git update-index --cacheinfo` after `git add -A`. So the commit
still carries exactly the bytes that verified, and the seq range it names is
still the range it commits, without any writer on the machine waiting on a
network round trip.

## The 2026-09-02 transcript, explained

The advance pushed the day's branch, and its `execution.completed` met a head a
harness hook had moved between this runtime's read and its append. The
compare-and-append refused, correctly (SPEC section 11.1 invariant 5). Every
other writer on this path has re-derived and re-attempted since APRV-150; this
one did not, so `daemon-log-advance-1-13984` was left open.

From there the cadence had no memory of the push except an in-process clock, and
only ONE of its two triggers consulted that clock. `--advance-after` (default
20) is evaluated independently of `--advance-interval`, and the published head
was not moving in that checkout: the second transcript shows the daemon keying
on `daemon-log-advance-1-14867`, a published seq of ZERO with 14870 records
reported off the branch, so the count trigger was satisfied on every tick. The
ninety-second spacing is the APRV-211 in-flight slot, ticks three and four found
a child still running and made no attempt, tick five was the first free one.

The second transcript adds the refusal loop. With the execution open, the next
tick's authorization reached `startExecution` on the same key and came back
`already-executed: an idempotency key is single-use and nothing here reconciles
or reruns it`, which is the gate saying, correctly, that somebody had to close
the books. Nobody did. Once the owed span moved, the key changed and the branch
was pushed again (PR #245 on the same branch name, opened after #240 merged,
which is expected and is noted on APRV-234).

And the `append-failed: another writer holds events.jsonl.lock; gave up after
2000ms` that every hook on the machine reported for the duration of each advance
was the verb holding the lock across its git and network work, in the child
APRV-211 had just moved it into. The child moved off the daemon's LOOP; it did
not move off the machine's lock. The burst of denied commands, and the records
that landed the moment each lock was released, is plausibly also what kept the
count trigger armed.

The three fixes bind independently: the retry keeps the record from being lost
at all, the reconcile closes what is lost anyway, and inside the interval the
count trigger now measures only records above the last attempt's span end, so
the same owed span cannot be re-pushed however far behind the published head
runs.

## Global invariants touched (SPEC section 11.1)

- (1) enforcement reads only verified records: unchanged. Every new read is
  `readVerifiedRecords` (through `finishExecution`) or the caller's already
  verified records; `reconcileDanglingAdvance` is pure over what it is handed
  plus git's object store.
- (2) no caller timestamps on gate-typed events: unchanged. Every append here
  still takes its ts at the write boundary from the runtime's clock.
- (5) every check-then-append through compare-and-append: preserved PER ATTEMPT,
  which is where it holds. This is a bounded loop over complete check-then-append
  operations, never a retry of an append: every attempt supplies `expectedHead`
  from its own read, an attempt whose head moved writes nothing, and a verdict
  that genuinely changed in the window is the verdict enforced. `core/log.ts` is
  untouched.
- (6) refusals machine-readable and distinct: three new daemon-local codes on
  `AdvanceAttempt.code` and the advance DaemonEvent, `advance-unreconciled` (an
  advance cycle nobody closed), `advance-settled` and `advance-reconciled` (the
  two repairs). No frozen union grew.
- (7) self-reported fields never reduce scrutiny: `FinishOptions.note` is a
  report on `execution.completed`, read back by nothing, and written by this
  runtime's own code rather than forwarded from a child.

## The decision to argue with

`core/execute.ts` says in as many words that nothing in this codebase closes a
dangling execution automatically, and `reconcileDanglingAdvance` is a carve-out
to it. Narrow on purpose: it closes only an execution THIS runtime started, for
its own log.advance cycle, whose entire effect is a git ref this runtime can
look at and did look at; it records which evidence it read; and where the
evidence is absent it writes nothing at all rather than guessing, because a
false `execution.failed` for an advance that actually published would be worse
than the dangling record. If the orchestrator would rather the daemon never
close a cycle it does not remember, the alternative is to leave it dangling and
let the interval guard alone stop the re-push, at the cost of a cadence that
stays wedged until a person runs `approval execution resolve`.

## SPEC draft, pending sign-off (NOT applied)

For the paragraph describing `log advance`:

  "The advance holds the append lock only while it reads: it verifies the chain,
  checks the staged set, and pins the log's exact bytes as an object. Everything
  after that (the fetch, the commit, the push, the pull request) runs with the
  lock released, and the commit is assembled from the pinned object, so the seq
  range it names is still the range it carries. A verb that held the lock across
  a network round trip made every other writer on the machine fail closed for
  the duration, which is a denial of service the gate performed on itself."

For the paragraph describing the daemon cadence:

  "The outcome of an advance is recorded with the same bounded re-derivation
  every other writer uses: a moved head means the outcome is written again
  against the fresh log, never that it is dropped. An advance whose outcome is
  not in the log has still HAPPENED, and the cadence treats it that way: no
  further advance is authorized while such a cycle is open, and inside the
  configured interval the record-count trigger counts only records no earlier
  attempt tried to publish. The runtime may close such a cycle itself only where
  it can observe the effect, that the records are on a records branch, and it
  records what it observed; where it cannot, the cycle stays open for a person."

## Tests

`tests/daemon-advance-finish.test.ts`, six cases, real git topology with a bare
remote, `gh` stubbed on PATH, every record written by the real gate:

- the outcome record loses a real two-process append race and lands anyway (the
  parent holds the append lock across the child's read, then releases it and
  appends through the real gate; the case checks the ordering it got and asks
  for another round when the child happened to win, because the property is
  about the child LOSING);
- the same harness at `retryOnHeadMoved: 1` pins the pre-fix shape:
  `append-failed`, no outcome record, one dangling execution;
- a lost outcome is settled on the next tick, and the cadence attempts nothing
  else in nine seconds of ticking under a ONE-record count trigger (the stub
  advance child leaves the append lock held, which is how the finish is made to
  fail to order);
- an advance left open by another process is reconciled from the git evidence
  and not re-run;
- a concurrent append lands well inside the hook's 2 s window while a five
  second advance child runs;
- and the verb's own regression: an append made from the progress seam during
  the push phase succeeds, and the commit carries the snapshot rather than the
  record that raced it.

## Verification

`npm run build` clean, `npm run lint` clean. Full-suite counts are in the lane
report. Commit 550c1f2.

## Lane resumption, 2026-09-04: merged main, and the retry is now the shared one

origin/main moved under this branch after the three commits above (APRV-236,
219, 215, 209, 225, 226, 232 all landed). Merged, never rebased, in
ace90bf. Three conflicts, all mechanical: the two task files, where this
branch's In Progress status, plan and notes were kept over main's To Do copy,
and one import block in daemon/daemon.ts, where APRV-219's log-anchor imports
and this branch's advance-cycle import both had to stay. Nothing in the merge
touched the advance logic itself, and the daemon suite (31 cases) passes with
APRV-219's startup anchor check and APRV-215's preflight in the same file.

The one substantive follow-through, commit d943a99: APRV-236 landed
core/head-retry.ts, the bounded head-moved retry for every gate writer, which
is the helper the note above says this task shaped its local loop to accept. So
the local loop is gone. daemon/advance.ts now calls withHeadRetry over
attemptsOf(options.retryOnHeadMoved) around the whole finishExecution call, and
its private FINISH_ATTEMPTS constant and isFinishHeadMoved predicate are
deleted. Same bound of three, same clamp-downward-only seam the tests use to pin
the pre-fix shape at 1, same one-attempt-is-one-whole-check-then-append. One
behaviour changes with the swap: an exhausted refusal now carries the attempt
count in its message, exactly as every other writer's does since APRV-236, and
all six cases in tests/daemon-advance-finish.test.ts pass unchanged over it.

Deliberately NOT done: core/execute.ts's finishExecution is still unretried at
the core level. APRV-236 wrapped startExecution and the gate's writers; giving
the finish path its own retry inside core would change what every other caller
of it does with a moved head (approval execution resolve, and the run verb's
own outcome record), and that is a decision with its own blast radius rather
than a detail of this task. The advance wraps its own call, which is the caller
whose incident this is. If the orchestrator wants the core-level version, it is
a one-line change plus whatever the other callers' tests say.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The cadence advance's outcome record goes through the shared head-moved retry, a dangling daemon advance is reconciled on the next tick with the outcome observed, and no outcome resets the cadence so --advance-interval holds; the append lock is proven not held while the advance child runs. Verified by the daemon-advance, daemon-advance-adopt, log-advance and cli-doctor suites (69 pass) on the merged branch and CI's full run; merged in PR #259.
<!-- SECTION:FINAL_SUMMARY:END -->
