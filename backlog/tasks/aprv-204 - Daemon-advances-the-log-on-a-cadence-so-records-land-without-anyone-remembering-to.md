---
id: APRV-204
title: >-
  Daemon advances the log on a cadence, so records land without anyone
  remembering to
status: To Do
assignee: []
created_date: '2026-09-02 00:30'
labels:
  - dogfood
  - daemon
dependencies: []
priority: medium
ordinal: 168000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Advancing the log is bookkeeping: it commits the record of decisions that were already made, verifies the chain, and opens a records PR. Since the seq 7413 ceremony log.advance is supervised-live 0.1, so the class no longer needs a hand on the keyboard, yet the verb is still only ever run when a session or the human remembers to. Outcome: the daemon, which is already the log's sole writer in the primary checkout, advances the log itself on a cadence (a configurable interval, and/or after N new events, and at graceful shutdown), running the same code path as the CLI verb through the gate as agent:daemon so the action is classified log.advance, sampled like any other supervised action, and refused cleanly when the gate says so. A failed or refused advance is reported on the daemon's status surface and retried on the next tick; the daemon never merges the records PR (vcs.push.main stays a session's supervised act, or the human's). Why: the committed log is the project's truth and its freshness should not depend on a person's memory; the APRV-125 sign-off named this end state and today's seq 7413 amend made it reachable.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The daemon advances the log on a configurable cadence and at graceful shutdown when there are unpushed records, through the same verified append-lock path as log advance, and opens or updates one records PR per day rather than one per tick
- [ ] #2 The advance is gated as log.advance for agent:daemon: a supervised sample or a refusal is honored, recorded, and retried on the next tick; the daemon never runs gh pr merge
- [ ] #3 approval daemon status (and doctor) report the last advance attempt, its outcome, and the count of records not yet on a records branch
- [ ] #4 A records PR opened by the daemon passes the records-tier guards unchanged; tests cover the cadence trigger, the shutdown flush, and the refusal path against a scratch repo
- [ ] #5 SPEC.md section 10.1 gains the daemon-cadence sentence, flagged pending sign-off, drafted in the task notes for the orchestrator to apply
- [ ] #6 npm test passes; lint clean
<!-- AC:END -->
