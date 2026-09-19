---
id: APRV-381
title: >-
  Daemon audit sweep: a lock-timeout on the audit.sampled append is reported as
  transient and retried by name, never as a dropped sample
status: To Do
assignee: []
created_date: '2026-09-19 16:09'
labels:
  - daemon
  - audit
  - sampling
dependencies: []
priority: medium
ordinal: 295000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-19 ~16:00Z in the primary daemon (approval up) right after a lane hook append and a records advance were writing the same log: tick 7405 printed "append-refused audit sampling: append-failed: audit.sampled for hook:...:vcs.push.main was not appended (lock-timeout): another writer holds .approval/log/events.jsonl.lock; gave up after 2000ms". Reading src/core/audit.ts: pendingSamples re-derives eligible, selected, not-yet-sampled candidates from the log on every sweep, so the dropped sample is retried on the next tick and the log shows head moving 51446 to 51448 over the following ticks; nothing was lost. Two things are wrong anyway. (1) The message says the sample was not appended and nothing more, so an operator reading the daemon window (Carter did) takes it as a lost audit record; the sweep should classify a lock-timeout (and head-moved from src/core/log.ts) as transient, say it will retry on the next tick, and confirm by a follow-up line when the retry appends, with the action key. A refusal that is not transient (schema, chain, policy) keeps the current form. (2) DEFAULT_LOCK_TIMEOUT_MS is 2000 for every writer; the daemon own appends contend with hook appends from several lanes and with approval log advance, which holds the lock for the whole verify-and-commit. Decide whether the daemon sweep should wait longer (it is the one writer that can afford to) or back off and skip the sweep when the lock is held, and record the decision. Related: APRV-40 (sampling), APRV-57 (sample line), APRV-150 (append race), APRV-123 (unappendable verdict is a refusal; not touched here, a sample is not a verdict).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A lock-timeout or head-moved on the audit.sampled append is reported as transient with the action key and the words that it retries on the next tick; a later successful append of the same sample prints a line naming it as the retry
- [ ] #2 A non-transient append refusal keeps the existing append-refused form, with a test for each of the two shapes built through the real append path (a held lock in the test process, then released)
- [ ] #3 The daemon sweep lock wait is decided (longer wait or skip-and-retry) and documented in the sweep header and docs/cli-reference.md under up or daemon run
- [ ] #4 build, typecheck, lint, daemon and audit suites pass
<!-- AC:END -->
