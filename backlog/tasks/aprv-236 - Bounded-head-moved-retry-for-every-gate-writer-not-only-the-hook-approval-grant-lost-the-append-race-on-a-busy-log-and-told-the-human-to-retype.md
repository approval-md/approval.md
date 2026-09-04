---
id: APRV-236
title: >-
  Bounded head-moved retry for every gate writer, not only the hook: approval
  grant lost the append race on a busy log and told the human to retype
status: In Progress
assignee:
  - 'agent:opus-lane-s'
created_date: '2026-09-02 20:28'
updated_date: '2026-09-02 22:13'
labels:
  - core
  - gate
  - bug
dependencies: []
priority: high
ordinal: 191000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Seen 2026-09-02: approval grant daemon-log-advance-1-14008 in the primary refused with append-failed (head moved: expected seq 14218, found 14219) while two lanes and the daemon were appending; the human had to run it again. APRV-150 (PR #165) gave the hook's writers three bounded retries (re-read, re-derive against the fresh head, append through compare-and-append), and its lane flagged that register, request, gateAndWait and finishHarnessExecution were left unretried; grant, reject and withdraw are the same shape. Outcome: one retry helper in core (re-read, re-run the exact same checks against the fresh head, append; give up after N with the same append-failed code) used by every gate writer that a human or a session drives: grant, reject, withdraw, register, request, wait's adoption, run's execution.started, the daemon's advance finish (APRV-233 overlaps for that one). The checks are re-run, never skipped: a decision that no longer holds on the fresh head (request expired, already decided, policy drifted) refuses with its own code, not append-failed. SPEC line 573 area says nothing is retried by the writer; the notes draft the amended sentence for sign-off (the writer retries the read-check-append cycle, never the append alone). Why: a compare-and-append refusal is a fact about timing, not about authority; asking a human to retype is the wrong caller to hand it to.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval grant, reject, withdraw, register, request and run succeed under a concurrent appender in a test that appends between their read and their append, with the decision re-checked on the fresh head (a request decided in between refuses with the decided code, not append-failed)
- [x] #2 Retries are bounded (same count as APRV-150) and the final refusal is append-failed with the attempt count in its message
- [x] #3 The hook's existing retry uses the shared helper (no second implementation)
- [x] #4 SPEC sentence drafted in the notes for sign-off
- [x] #5 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. New shared module src/core/head-retry.ts: HEAD_MOVED_ATTEMPTS = 3 (APRV-150's count), isHeadMoved(result) (code append-failed AND append.code head-moved), attemptsOf(asked, ceiling) (clamp downward only), and withHeadRetry(attempts, cycle) which re-runs the WHOLE read-check-append cycle and, once the bound is spent on a still-head-moved refusal, returns it with the attempt count appended to its message. One implementation; no module keeps its own loop.
2. src/core/gate.ts: delete its local HEAD_MOVED_ATTEMPTS / isHeadMoved / attemptsOf / withHeadMovedRetry and re-export a three-line options adapter over the shared helper. Wrap register, request, decide, withdraw and finishHarnessExecution the way startHarnessExecution and consumeHarnessGrant already are: the exported name keeps its signature, the body moves verbatim into an attemptX function, and the wrapper runs it under the helper. Every attempt is a fresh readGateRecords, a fresh policy read and attestation, a fresh derivation and a fresh compare-and-append against the head it just read.
3. src/core/execute.ts: add retryOnHeadMoved to ExecuteOptions and wrap startExecution the same way (this is approval run's execution.started, on both the manual path through consumeToken and the supervised/autonomous path). core/token.ts's consumeToken keeps no loop of its own: it is re-entered whole by the retried cycle, so its single-use scan is re-run rather than skipped.
4. src/core/gate-window.ts: drop its duplicate trio and call the shared helper, keeping its own 4-attempt ceiling as a parameter.
5. src/core/log.ts is untouched. Update withdraw's doc rule 4 and the module header where they state the writer never retries.
6. Tests: extend tests/concurrency.test.ts with real two-process races (parent holds the append lock across both children's reads) for grant/reject, withdraw, register, request and run; assert the write lands, that a request decided in the window refuses with the decided code rather than append-failed, and that the exhausted bound names its attempt count. Update the APRV-106 grant-vs-withdraw race, whose loser now re-derives instead of reporting head-moved.
7. npm run build, per-file node --test, npx oxlint, full npm test; draft the spec sentence in the notes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What changed

One bounded head-moved retry now exists in the runtime, in `src/core/head-retry.ts`, and every writer a human or a session drives runs under it. `src/core/log.ts` is untouched: compare-and-append is byte-for-byte what it was and still refuses a stale write under the lock.

- `src/core/head-retry.ts` (new): `HEAD_MOVED_ATTEMPTS = 3` (the count APRV-150 chose, not a second number for the same fact), `isHeadMoved`, `attemptsOf(asked, ceiling)` and `withHeadRetry(attempts, cycle)`. The refusal shape it takes is structural (`{ ok, code?, message?, append? }`), so four frozen refusal unions in four modules use one helper without learning about each other.
- `src/core/gate.ts`: its local `HEAD_MOVED_ATTEMPTS` / `isHeadMoved` / `attemptsOf` / `withHeadMovedRetry` are gone, replaced by a three-line adapter that reads `GateOptions.retryOnHeadMoved` and calls the shared helper. `register`, `request`, `decide` and `withdraw` join `startHarnessExecution` and `consumeHarnessGrant` under it: each keeps its exported name and signature, its body moved verbatim into an `attemptX` function, and the wrapper runs it.
- `finishHarnessExecution` is retried PER KEY rather than as a whole verb. It appends one outcome per open delegated execution, and re-entering the verb after some of them landed would find those keys closed and could answer `already-finished` for a call that in fact wrote records. Its per-key read-check-append is the cycle, so that is the unit retried; counterparts already appended stand.
- `src/core/execute.ts`: `ExecuteOptions.retryOnHeadMoved` added, and `startExecution` (`approval run`'s writer, both the manual path and the supervised/autonomous one) wrapped the same way.
- `src/core/gate-window.ts`: its copy of the loop deleted; it calls the shared helper and passes its own 4-attempt ceiling as a parameter. Its doc claimed the same bound as the gate's and had 4 where the gate had 3; the doc now states the extra attempt and why a bypass record gets it.
- `src/daemon/advance.ts` untouched (APRV-233 owns its finish); `core/token.ts`'s `consumeToken` and `core/gate.ts`'s `expire` keep no retry of their own, deliberately. `consumeToken` is re-entered WHOLE by the retried `startExecution` cycle, so its single-use scan is re-run rather than skipped and double-spend stays exactly as pinned; `expire` is materialisation the daemon's next tick performs again.

## The attempt count, and the refusal once it is spent

The code stays `append-failed` and the `append` error stays the writer's own, because that is what a caller branches on and it is still the true reason. The message gains the count: "3 attempts were made, each a fresh read, fresh checks and a fresh compare-and-append, and the head had moved again every time. Nothing was appended." One lost race and a log under sustained contention are different operational facts, and a reader who cannot tell them apart cannot act on either.

## Global invariant paths touched

- **Invariant 5, every check-then-append passes through compare-and-append.** Preserved PER ATTEMPT, which is where it has to hold. This is a bounded loop over complete read-check-append cycles, never a retry of an append: every attempt supplies `expectedHead` from its own read, and an attempt whose head moved writes nothing. Unchanged in `core/log.ts`.
- **Invariant 1, enforcement paths read only verified records.** Each attempt re-reads through the verified path (`readGateRecords` / `readVerifiedRecords`); nothing crosses an attempt except the caller's inputs.
- **Invariant 2, gate-typed events never accept caller timestamps.** `tick(options)` is read inside the retried cycle, so each attempt stamps its own moment from the runtime's clock.
- **Invariant 4, self-reported fields never reduce scrutiny.** `retryOnHeadMoved` is clamped downward only: a caller may ask for less tolerance of a moved head, never more, and a non-integer, a zero or a negative resolves to the runtime's own value.
- **Invariant 6, refusals machine-readable and distinct.** No code added, none repurposed, no union widened. A verdict the fresh head produces is returned as itself and ends the loop, so a request decided in the window refuses `already-decided`, a withdrawn one `request-withdrawn`, a spent key `already-executed` or `token-consumed`, a colliding registration `task-already-registered`, a live request `duplicate-request`. Only the human-readable message of the exhausted `append-failed` changed.
- **Invariant 8, a verdict whose event cannot be appended is a refusal.** Unchanged: nothing returns proceed, prints an allow or hands back a token before its record is appended, and the exhausted bound is still a refusal.
- **Invariant 9, human-only classes are inert to agents.** Re-derived per attempt like everything else, so an amendment landing in the window is enforced rather than raced past.

## The spec sentence, drafted for sign-off

The `head-moved` row of the spec's refusal registry currently ends "...and nothing is retried by the writer", which this change makes false. Proposed replacement for that cell:

> The caller supplied a compare-and-append precondition and the tail read under the lock is a different `(seq, hash)`. Every read-dependent check that authorized the write is stale, and the append is never retried. The gate writers above it re-run the whole read-check-append cycle instead, bounded (three attempts, four for the open window's bypass record): each attempt is a new verified read, a fresh run of every check against the head that read observed, and a fresh compare-and-append, so §11.1 invariant 5 holds per attempt and a verdict the interleaved record changed is the verdict enforced. A caller sees `append-failed` only once the bound is spent, and the message carries the attempt count.

Not applied: the spec is a protected path, and a divergence is called out rather than edited silently.

## Tests

- `tests/head-retry.test.ts` (new, 11 tests) pins what a race cannot pin deterministically: the bound runs exactly N cycles and never more, only `head-moved` re-runs one, a verdict the fresh head produces ends the loop on the attempt that derived it, a lock timeout is returned on the first attempt with its message untouched, the ceiling is lowered by a caller and never raised, and the exhausted refusal is `append-failed` carrying the count.
- `tests/concurrency.test.ts` gains eight rounds of real two-process races in the file's existing style: the parent holds the append lock across both children's reads, so both writers are provably authorized by the same head and the second append provably meets a moved one. Every record is written by the real verbs through the real append path. Two shapes per writer: two grants both land (the incident verb), two withdrawals both land, two registrations both land, two requests both land, two autonomous runs both start; and contending for one request settles it once with the loser refused `already-decided` (grant vs reject), `duplicate-request`, `task-already-registered` or `token-consumed` rather than for the race. A `retryOnHeadMoved: 1` round pins the unretried shape and the attempt count in its message.
- The APRV-106 grant-vs-withdraw race is updated to the new contract: its loser used to be asserted `append-failed`/`head-moved` and now re-derives to `request-withdrawn` or `already-decided` depending on who won, which is the change the task is about.

## Validation

- `npm run build`: clean. `npx oxlint`: clean, exit 0.
- `npm test` (second run, quiet machine): 3033 tests, 3031 pass, 1 fail. The single failure is `an inbox that discloses no permissions prints the reminder instead of a verdict` in the setup suite, which makes a live call to the AgentMail API and failed `agentmail-unreachable ... fetch failed`. It is a network reachability fact about this machine, touches nothing in this change, and the file is green on its own: `node --test dist/tests/cli-setup.test.js` gives 90/90, exit 0.
- The first full run, taken while the machine was under load from parallel lanes, had four failures. All four are timing or network flakes and all four pass alone, each verified individually with its exit code read: setup's telegram poll ("it polled once and gave up on the human's timing"), the same AgentMail probe, the daemon sweep (a 2000ms real-clock TTL that lapsed before the test could decide), and the APRV-206 latency RATIO. `node --test dist/tests/telegram-tap-latency.test.js` 5/5 exit 0, `node --test dist/tests/daemon.test.js` 31/31 exit 0, `node --test dist/tests/cli-setup.test.js` 90/90 exit 0.
- Per-file runs during development, all exit 0: `gate.test.js` 88/88, `execute.test.js` 33/33, `concurrency.test.js` 14/14 (6 pre-existing plus 8 new), `head-retry.test.js` 11/11, `cli-hook.test.js` 88/88, and `gate-window + token + evidence-append + human-only + clock` 81/81 together.
- The latency RATIO test deserves the explicit note because `decide` is on the path it measures: the retry adds one closure call on the happy path and no extra read, and the test passes on a quiet machine (2574ms, ratio within bound).
<!-- SECTION:NOTES:END -->
