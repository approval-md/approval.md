---
id: APRV-236
title: >-
  Bounded head-moved retry for every gate writer, not only the hook: approval
  grant lost the append race on a busy log and told the human to retype
status: To Do
assignee: []
created_date: '2026-09-02 20:28'
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
