---
id: APRV-479
title: >-
  A hook killed by a default-disposition signal mid-append leaves
  events.jsonl.lock behind, and a lock that is never stolen wedges every writer
status: In Progress
assignee:
  - '@claude-edge-A2'
created_date: '2026-10-05 05:49'
updated_date: '2026-10-05 07:47'
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
- [ ] #2 No path steals a live writer's lock
- [ ] #3 A lock-timeout refusal names the lockfile's holder and why its lock was kept; describeLogLock (core/log-lock.ts) describes a lockfile without touching it
- [ ] #4 A lock whose holder is provably gone is reclaimed atomically by the next writer (once per wait), recorded as audit.lock_reclaimed before that writer's own record; compare-and-append is unchanged
- [ ] #5 A lockfile with no holder record is reclaimed only once it is ten minutes old; a lock beside a log sync snapshot or an absent log is kept
- [ ] #6 Writers racing to reclaim one stale lock: exactly one reclaims, every append lands, the chain verifies
- [ ] #7 Docs (hermes-hook.md, claude-code-hook.md), CHANGELOG Unreleased, proposed SPEC hunks in notes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/core/log-lock.ts (new): the lockfile's holder record (v1 JSON: pid, host, boot, pidns/start on Linux, created, op, nonce), the liveness judgement per platform (Linux: same boot_id + pid namespace, /proc/<pid>/stat state + starttime; macOS/other: same host, kill(pid,0), boot from os.uptime; anything unverifiable is live), the atomic reclaim (exclusive link aside keyed by the stale lock's inode, verify identity by inode+content+mtime, rename the path aside, re-verify, restore on mismatch), refusal guards (a log sync snapshot beside the log, an absent log), and the termination-signal guard (defer SIGTERM/SIGINT/SIGHUP while a lock is held when no listener owns them, re-raise on the loop).
2. src/core/log.ts: acquireLock writes the holder record, tries the reclaim once per wait (first EEXIST), names the holder on lock-timeout; releaseLock unlinks only its own record; lockedRun appends audit.lock_reclaimed as the first write under a lock that followed a reclaim (fresh tail read, no head precondition), then runs the caller (whose compare-and-append sees the moved head).
3. Schema: audit.lock_reclaimed (system actor, payload lockfile/reason/holder/age_ms), fixtures, EventType union, conformance vectors regenerated (schema-validation minor bump).
4. Tests tests/log-lock-reclaim.test.ts: dead pid reclaimed + record; live pid times out; replaced pid (Linux real, decision unit test everywhere); legacy younger/older; sync snapshot refuses; SIGTERM mid-append releases (child process, stalled write layer); concurrent reclaimers (one record, all appends, chain verifies); mutation with liveness disabled.
5. Docs (hermes-hook.md, claude-code-hook.md residue paragraphs), CHANGELOG Unreleased, SPEC section 8 and 11.1 proposed hunks in notes. typecheck, lint, targeted tests.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Resume point: node scripts/run-tests.mjs --only <the related set named in the PR> from /Users/carter/dev/approval-md-wt/aprv-479 after npm run build

Resume point (WIP checkpoint): code, schema, fixtures, vectors, tests (tests/log-lock-reclaim.test.ts 17/17), docs and CHANGELOG are committed; next is the implementation notes with the SPEC hunks, ticking ACs, then gh pr create and the CLAIMS line.
<!-- SECTION:NOTES:END -->
