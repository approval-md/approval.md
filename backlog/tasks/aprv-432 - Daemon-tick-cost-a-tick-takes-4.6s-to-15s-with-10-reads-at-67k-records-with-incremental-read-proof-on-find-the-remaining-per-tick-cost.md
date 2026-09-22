---
id: APRV-432
title: >-
  Daemon tick cost: a tick takes 4.6s to 15s with 10 reads at 67k records, with
  incremental read proof on; find the remaining per-tick cost
status: To Do
assignee: []
created_date: '2026-09-22 03:09'
labels:
  - daemon
  - performance
dependencies: []
priority: medium
ordinal: 330000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-21 in the primary daemon window: ticks 88 to 95 each reported 4.6s to 15.7s and 10 reads at head seq 66988 to 67020, woken by log events. Carter remembers ticks near 600ms. APRV-217 shipped the incremental prefix proof behind daemon.read_proof: incremental, which the doctor confirms is on, so the remaining cost is elsewhere: candidates are the 10 reads per tick (what are they, and does each re-prove from the verified snapshot or from genesis), the QUEUE.md regeneration (2460 bytes, but rendered from the whole log), the envelope scan over backlog/tasks, or the payload store. Measure before changing anything: instrument one tick with per-phase timings, report them in the task notes, then fix the largest phase. Related: APRV-186, APRV-188, APRV-209, APRV-212, APRV-217, APRV-230.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 One tick's per-phase timing is recorded in the notes from a run against a log of at least 60k records (a scratch copy of the primary log is fine), naming the phase that dominates
- [ ] #2 The dominating phase is reduced so a woken tick at 67k records completes in under one second on the same machine, with the before and after numbers in the notes
- [ ] #3 No change to what a tick reads from or appends to the log beyond what SPEC section 10.2 already states; the daemon and daemon-drift-deferral suites pass
<!-- AC:END -->
