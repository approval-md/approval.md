---
id: APRV-479
title: >-
  A hook killed by a default-disposition signal mid-append leaves
  events.jsonl.lock behind, and a lock that is never stolen wedges every writer
status: To Do
assignee: []
created_date: '2026-10-05 05:49'
labels:
  - security
dependencies: []
priority: medium
ordinal: 365000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From the APRV-478 refuter (PR #612, 2026-10-05). Pre-existing, not changed by APRV-478. On the non-Hermes harness hooks no SIGTERM/SIGINT listener is registered outside the wait (APRV-477 scope), so a signal that lands while the process holds <log>.lock (inside appendEvent's lockedRun, on the carried-grant spend or the unattended charge) kills it before releaseLock runs. core/log.ts never steals a lock (by design: stealing is how two writers share a seq), so every later writer, the daemon included, refuses lock-timeout until a human removes the file. Same for any CLI verb killed by SIGKILL mid-append. Decide: a guard that defers the default disposition while the lock is held (a listener that only records the signal and re-raises after release), an owner-pid in the lockfile plus a doctor/status line naming a lock whose owner is dead, or both; stealing stays out.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A repro (kill a hook or verb with SIGTERM while it holds the lock) is a test, and the chosen behaviour is pinned
- [ ] #2 doctor or status names a lockfile whose owner is gone, without removing it
- [ ] #3 No path steals a live writer's lock
<!-- AC:END -->
