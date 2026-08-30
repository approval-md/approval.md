---
id: APRV-150
title: >-
  Hook fails closed on a benign log-append race: head-moved on a read-class
  record denies the command
status: To Do
assignee: []
created_date: '2026-08-29 14:31'
labels:
  - gate
  - hook
  - concurrency
  - bug
dependencies: []
priority: high
ordinal: 135000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-08-29 with parallel agent sessions running under the hook: a session was denied its very first command (git status, class read.shell) with hook-gate-refused:append-failed — the hook read the log head at seq 1089, another writer (a parallel session hook or the daemon) appended seq 1090 between the read and the append, and the compare-and-append correctly refused the stale write. The compare-and-append behaved exactly as SPEC 11.1 invariant 5 requires; the defect is the hook layer above it treating one lost race as a terminal refusal. The record being appended was the hook own execution.started for an autonomous read-class command: no verdict depended on the moved head, and re-reading would have produced the identical decision. Consequence: any two concurrent hook-gated sessions (or one session racing the daemon) deny each other probabilistically, which turns the gate into a lottery under exactly the parallel-fleet load the daily_actions budget was just raised (seq 1056) to accommodate. Fix direction to evaluate at planning time: a bounded re-read-and-retry inside the hook (and possibly other gate writers whose pre-append checks are provably insensitive to the interleaved record) on append-failed/head-moved, with the retry re-running the checks against the fresh head rather than replaying the stale ones — never a blind re-append. The invariant stays intact: every check-then-append still passes through compare-and-append; the retry is a new read plus new checks plus new append attempt. Discovered by an agent lane report (wave 1b, APRV-145 lane); the raw refusal text is preserved in that lane result.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A hook-gated command that loses the append race retries with a fresh read and fresh checks, bounded (small fixed attempt count), and succeeds when the re-derived verdict is unchanged
- [ ] #2 A retry whose re-derived verdict DIFFERS from the original (policy changed, budget newly exhausted, attestation stale) enforces the new verdict, proven by a test that flips state between read and append
- [ ] #3 The retry lives at the writer layer; compare-and-append itself is unchanged and still refuses stale writes (existing tests untouched)
- [ ] #4 A test reproduces the race deterministically (two writers through the real append path) and pins both the pre-fix denial and the post-fix recovery
- [ ] #5 npm test passes; lint clean
<!-- AC:END -->
