---
id: APRV-403
title: >-
  Daemon drift scan: a lock-timeout or head-moved on the envelope.drift append
  is reported as deferred and retried, the way APRV-381 made the audit sweep
  report it
status: To Do
assignee: []
created_date: '2026-09-20 12:44'
labels:
  - daemon
  - audit
dependencies: []
priority: medium
ordinal: 311000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found while landing APRV-381 (2026-09-20). The end-to-end daemon test that holds the append lockfile for a whole tick shows the drift scan printing append-refused for envelope.drift with a lock-timeout, the same ambiguous line the audit sweep used to print: an operator reads it as a lost record when the scan re-derives and retries on the next tick. Apply the APRV-381 shape to the drift scan: classify lock-timeout and head-moved as transient through the shared isTransientAppendError, report the deferral with the task key and the words that it retries on the next tick, name the retry when it lands, and keep the append-refused form for every non-transient refusal. Tests built through the real append path with a held lock, as in tests/audit.test.ts for APRV-381.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A lock-timeout or head-moved on the envelope.drift append is reported as deferred with the task key and retried on the next tick, and the retry names itself
- [ ] #2 Non-transient refusals keep the append-refused form; both shapes tested through the real append path
- [ ] #3 docs/cli-reference.md daemon lines updated; build, typecheck, lint, daemon and audit suites pass
<!-- AC:END -->
