---
id: APRV-188
title: 'Hooks read via the running daemon: remove the per-process cold walk'
status: To Do
assignee: []
created_date: '2026-09-01 02:57'
labels: []
dependencies: []
references:
  - docs/postmortem-2026-08-31-hook-cpu.md
priority: medium
type: enhancement
ordinal: 163000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-186 shrank the cold chain walk from ~100s to ~80ms, but every hook invocation is still a fresh process that verifies the log from genesis, so hook cost remains O(log length) per gated tool call (~0.02ms/record; seconds again if the log grows 100x). The daemon already holds a warm VerifiedReadCache and reads through the same readVerifiedRecords path as everyone else. Serve verified reads (and request-state queries) to hook processes from the running daemon over a local socket, with the current cold walk as the fallback when the daemon is down. Fail closed on any doubt about the daemon's answer: a hook must never treat an unverified or stale response as a verified read, and enforcement paths keep reading only verified records (SPEC §11). See docs/postmortem-2026-08-31-hook-cpu.md (Remaining risk) and APRV-186 for the incident and measurements.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A gated hook invocation against a large log performs no cold chain walk when the daemon is running (verified via timing or read-cache stats)
- [ ] #2 With the daemon stopped, the hook falls back to today's in-process verified read and behaves identically
- [ ] #3 The daemon-served path preserves the verified-read contract: responses are backed by the daemon's own verified walk, and any transport error, version skew, or stale answer fails closed to the fallback
- [ ] #4 SPEC §11 global invariants hold; implementation notes call out that the enforcement read path was touched
- [ ] #5 npm test passes; lint clean
<!-- AC:END -->
