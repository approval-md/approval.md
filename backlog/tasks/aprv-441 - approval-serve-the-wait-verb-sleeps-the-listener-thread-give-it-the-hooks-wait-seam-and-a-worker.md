---
id: APRV-441
title: >-
  approval serve: the wait verb sleeps the listener thread; give it the hook's
  wait seam and a worker
status: To Do
assignee: []
created_date: '2026-09-25 04:53'
labels:
  - hosting
  - serve
  - concurrency
dependencies: []
priority: medium
ordinal: 335000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up from APRV-427. commandWait in src/cli/execute.ts blocks with Atomics.wait for its own timeout, so POST /verb/wait through approval serve still freezes the tenant's facade for the duration, exactly as hook calls did before APRV-427 moved them onto worker threads with a HookWaitSeam that releases the store lock during the poll and re-takes it before every append. Harnesses wait on the hook route, so the acceptance criteria of APRV-427 hold, but a sandbox that calls the wait verb directly (the agent-scope surface publishes it) can stall the tenant's requests for up to the wait's timeout. Add the same seam to commandWait's poll loop, run it on the hook worker pool through serve, and take the store lock around the --withdraw-on-timeout append. Same invariants as APRV-427 (verified reads, compare-and-append, no server-side append).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 With a wait held open for 60 s through serve, GET /status, POST /verb/queue and GET /log/follow answer within 2 s
- [ ] #2 --withdraw-on-timeout appends under the store lock and the append lock; a concurrent verb never interleaves with it (test)
- [ ] #3 The CLI's own wait is byte-identical in behaviour; serve documents that wait no longer holds the facade
<!-- AC:END -->
