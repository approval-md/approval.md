---
id: APRV-211
title: >-
  Daemon advance re-asks every tick: a gated advance must adopt its open
  request, not mint a new key
status: To Do
assignee: []
created_date: '2026-09-02 09:05'
labels:
  - daemon
  - bug
dependencies: []
priority: high
ordinal: 174000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-02 on the primary log after Carter ran approval up --advance: the daemon registered and requested log.advance three times in a row (seq 10167/10168, 10172/10173, 10175/10176), each with a new idempotency key daemon-log-advance-1-<seq>, so the human got three questions for one owed advance; APRV-204 notes claim a gated tick leaves its request open and retries next tick, but the key includes the head seq, which moves with every tick, so every tick is a new question. Two later ticks then proceeded without a decision (10180/10181 executed; 10184/10185 executed and 10186 execution.failed exit 1), which is the live draw working in the daemon process, where the launch environment carries the sampling secret. Outcome: while a daemon-minted advance request is live (requested, undecided, unexpired), the next tick adopts it (waits on or re-checks that key) rather than registering another; the key is stable across ticks for the same owed span, or the daemon keys on the open request rather than the head; a decision on the open request authorises exactly one advance. Separately, the failed advance must be explained on the daemon status surface: capture the verb's refusal code and message in the advance DaemonEvent and doctor row (exit 1 with no reason is not a report). Why: the daemon cadence exists to remove taps, not multiply them.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A gated advance tick followed by N further ticks with the request still live produces exactly one approval.requested, proven by a test with a stubbed human that never answers
- [ ] #2 A grant on the open request authorises one advance on the next tick; a rejection is honoured and no new request is minted until the owed span changes
- [ ] #3 An advance that fails records the verb's refusal code and message on the advance DaemonEvent and the log-advance-cadence doctor row; the failure observed on 2026-09-02 (execution.failed exit 1 at seq 10186) is reproduced or explained in the notes
- [ ] #4 The payload hash still changes when the owed span changes, so a supervised-live draw is per distinct advance and never re-rolled for the same span
- [ ] #5 npm test passes; lint clean
<!-- AC:END -->
