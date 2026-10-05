---
id: APRV-478
title: >-
  The harness spend waits for the log lock on the event loop, so a signal during
  lock contention blocks instead of being dropped after the spend
status: To Do
assignee: []
created_date: '2026-10-05 03:36'
labels:
  - security
dependencies:
  - APRV-475
priority: medium
ordinal: 364000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From the APRV-475 refuter (PR #611, 2026-10-05), reproduced on the PR build. After the wait finds a grant, the hook passes the shared pause (BEFORE_SPEND, src/cli/hook.ts) and then calls consumeGrants -> consumeHarnessGrant (src/core/gate.ts), which does a full verified read and an append that waits on acquireLock (src/core/log.ts, DEFAULT_LOCK_TIMEOUT_MS = 2000, sleepSync retries), possibly repeated by withHeadMovedRetry. That stretch is synchronous, so a SIGTERM delivered during it is held while the wait's listener is registered, and then DROPPED when the wait's finally removes the listener (a held signal whose last listener is removed is discarded; scratch repro dropped.mjs prints survived on Node 24 and 26). Repro lockrace.mjs: hook claude-code, --interval 1500ms, grant recorded, another writer holds events.jsonl.lock (the daemon does this routinely), SIGTERM 1.7 s later while the hook spins on the lock, lock released 100 ms after: exit 0, an allow on stdout, one execution.started appended AFTER the signal; same on hermes (inherited from APRV-473). The docs and the proposed SPEC §10.1 hunk carve out 'the spend itself' as the residue, but that stretch can be seconds under contention on a large log (the live log is ~53 MB). Side observation, pre-existing: the start record's ts is taken before the lock wait, so under contention it can predate its append by about a second. Decide whether the carve-out may include lock contention; if not, make the lock wait yield inside the generator (try the lock, and on contention yield the retry interval so each retry crosses a poll phase), then take a final zero pause immediately before the consume, shrinking the residue to the read and append under the lock.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A signal delivered while the spend waits for the log lock is answered by the wait's handler (the block printed, no execution.started) on every harness, pinned by a test that holds the lock
- [ ] #2 The synchronous drivers (commandHook in process, the serve worker, the Codex bridge) keep their behaviour
- [ ] #3 Docs and the SPEC §10.1 interrupt hunk state the residue that remains
<!-- AC:END -->
