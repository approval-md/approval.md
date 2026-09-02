---
id: APRV-236
title: >-
  Bounded head-moved retry for every gate writer, not only the hook: approval
  grant lost the append race on a busy log and told the human to retype
status: In Progress
assignee:
  - 'agent:opus-lane-s'
created_date: '2026-09-02 20:28'
updated_date: '2026-09-02 20:43'
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
- [ ] #1 approval grant, reject, withdraw, register, request and run succeed under a concurrent appender in a test that appends between their read and their append, with the decision re-checked on the fresh head (a request decided in between refuses with the decided code, not append-failed)
- [ ] #2 Retries are bounded (same count as APRV-150) and the final refusal is append-failed with the attempt count in its message
- [ ] #3 The hook's existing retry uses the shared helper (no second implementation)
- [ ] #4 SPEC sentence drafted in the notes for sign-off
- [ ] #5 npm test passes; lint clean
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
