---
id: APRV-212
title: >-
  Daemon tick pins a core on a 10k-record log: quadratic audit sweep,
  per-task-file verified reads, snapshot self-wake
status: Done
assignee:
  - 'agent:claude-code'
created_date: '2026-09-02 09:25'
updated_date: '2026-09-02 10:22'
labels:
  - daemon
  - performance
dependencies: []
references:
  - APRV-186
  - APRV-187
  - APRV-188
  - docs/postmortem-2026-08-31-hook-cpu.md
priority: high
type: bug
ordinal: 175000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Recurrence of the CPU class from APRV-186/187/188 on a different path: the hook cold walk was fixed (APRV-186) and hooks now resume behind the daemon's snapshot (APRV-188), and now the DAEMON's own tick is the hot spot. Measured 2026-09-02 ~09:10 on the primary checkout, 'node /opt/homebrew/bin/approval up' with no flags: 7m05s CPU in 8m34s wall; six 1s %CPU samples 0, 47, 96, 84, 91, 14 (bursts of several seconds near 100%, main thread in kevent between them, so not a tight spin); RSS 340 MB. Log: .approval/log/events.jsonl 6,796,310 bytes, 10,364 records, of which 9,425 are execution.started; hooks from concurrent Claude Code sessions append ~20 records/min (last 10 min: 19,12,17,17,25,25,26,21,6,7); 249 payloads; 206 task files in backlog/tasks; DEFAULT_DEBOUNCE_MS 250, DEFAULT_INTERVAL_MS 30000, so the watcher-driven tick is effectively continuous. Static trace of tick(): (1) core/audit.ts supervisedExecutions runs declaringTasks, hasApprovalCycle and findDeclaration (three full-log scans) per execution.started record, ~290M iterations per tick; (2) scanForDrift calls this.read() once per task file (checkOneFile and reportEnvelopeLoss), ~214 verified reads per tick, each re-reading and re-hashing the 6.8 MB prefix; (3) every clean read publishes verified-head.json (a second full sha256 plus temp+rename) into dirname(logPath), the directory the daemon watches, so the daemon wakes itself after every tick. QUEUE.md is written into .approval/, which is not watched, and is ruled out as a self-feed. APRV-188 did not cover this path: it made hooks resume behind the daemon's snapshot, and the per-read publication it added is one of the three costs here.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Per-phase tick timings over 10 ticks against a 10k-record log with the live log's record mix are recorded before and after, and the dominant phase(s) are named
- [x] #2 The daemon does not wake itself from its own writes: the verified-head snapshot, QUEUE.md, and task-file write-back never schedule a watcher tick, confirmed by a test
- [x] #3 One tick against a 10k-record log performs a bounded number of verified reads that does not grow with the number of task files, asserted structurally (read-cache counters), not on wall clock
- [x] #4 supervisedExecutions is linear in log length and provably equivalent to the per-key helpers it replaces (test compares the index against findDeclaration, declaringTasks and hasApprovalCycle for every key)
- [x] #5 The verified-head snapshot is published only when the verified prefix changed, and never hashes the file a second time
- [x] #6 SPEC.md §11.1 invariants hold: enforcement reads only verified records, every append is compare-and-append with the head it decided from; implementation notes name the enforcement read path as touched; no schema change
- [x] #7 docs/cli-reference.md daemon run section explains what a sustained multi-session append rate does to the daemon and what --debounce and --interval tune
- [x] #8 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Profile BEFORE against a synthetic 10k-record log with the live mix (a copy of the live log is refused: .approval/log classifies policy.core / log.mutate, human-only): build the fixture through the real append path (attest, register, startExecution for ~9.4k supervised executions, 206 task files), run 10 in-process ticks with per-phase timers, and --cpu-prof daemon run --once; confirm the self-wake by counting watcher ticks with no appends. 2. Fix A: indexDeclarations(records) in core/execute.ts (one pass: declaring tasks, last declaration, approval-cycle keys); supervisedExecutions consults it; per-key helpers stay for the gate. 3. Fix B: scanForDrift reads once per scan for the decision; a file that drifts re-reads immediately before its append and re-derives against the fresh head (compare-and-append unchanged). 4. Fix C: publishSnapshot reuses the digest the cache already proved and publishes only when (byte_length, sha256) changed; the log-dir watcher schedules only for the log's own basename; the tasks-dir watcher ignores files the daemon wrote this tick; tick event gains additive ms/phases/reads fields. 5. Tests: tests/daemon-tick-cost.test.ts (reads per tick independent of task-file count; snapshot inode unchanged without append; generous smoke budget), tests/audit-index.test.ts (index equivalent to the per-key helpers on every key, supervisedExecutions output unchanged), tests/daemon.test.ts no-self-wake case. 6. Profile AFTER, same script. 7. docs/cli-reference.md daemon run: sustained append rate and --debounce/--interval tuning; postmortem is APRV-213. 8. npm test, lint, notes, one PR with one commit per task, arm the merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
BEFORE (synthetic 10k fixture with the live mix, 483 registered tasks, 9,094 execution.started, 270 pending requests, 206 task files, 6.4 MB; a copy of the live log is refused: .approval/log classifies policy.core and any script naming the path classifies log.mutate, both human-only). 5 in-process ticks: TICK 2,926 ms/tick, CPU 3,345 ms/tick; read (nested) 2,079 ms over 210 verified reads/tick; scanForDrift 2,089; sweepTtl 720 (first tick expired 270 lapsed requests); render 36; writeBack 23; audit residual 56 (sampling secret unresolved). cpu-prof of one real daemon run --once: 45% sha256 update, 16% chainAnomalies, 7% file read. supervisedExecutions alone with the secret resolved: 3,313 ms per call (2,724 candidates). Self-wake probe (real daemon, --interval 10m, no external appends, 45 s): 18 ticks. Snapshot published 210 times per tick into the watched log dir. Verdict: dominant = per-task-file verified reads (B) and the snapshot publish hashing + write (C); the quadratic audit scan (A) is the largest single phase whenever the sampling secret resolves; QUEUE.md ruled out as a wake source (not in a watched dir).

AFTER (same fixture shape, fresh copy). 5 ticks including the expiry tick: TICK 1,060 ms (865 of it the TTL sweep's 270 one-shot expire calls). Steady state, 10 ticks on the already-expired fixture: TICK 208 ms/tick, CPU 207 ms/tick, 5 verified reads/tick (69 ms inside reads), scanForDrift 38, sweepTtl 35, writeBack 32, render 52, audit residual 49, one snapshot publish across all ticks. supervisedExecutions 3,313 -> 18 ms per call. Self-wake probe: 18 ticks -> 1 tick in 45 s. Roughly 14x per tick, 16x CPU, 180x on the audit scan. Fix shape: (A) core/execute.ts indexDeclarations (one-pass index; per-key helpers unchanged and still the gate's API; audit.ts supervisedExecutions consults it), (B) daemon.ts scanForDrift reads once for the decision, re-reads before any append and re-derives against the fresh head (compare-and-append unchanged), (C) verified-snapshot.ts publishes only when (byte_length, sha256) changed and takes the digest the cache proved; state.ts hashes once per read; attachWatchers: the log-dir watcher schedules only for the log's basename or a nameless event, the tasks watcher ignores the daemon's own write-back basenames (one generation kept) and this process's .<name>.tmp-<pid>-<n> temp files; tick line gains additive ms/reads/phases. Global invariants touched: the enforcement read path (drift decision vs append reads; the cache's publish path). Unchanged: every append carries the head it decided from; admission of snapshots and prefixes untouched (the memo can only suppress a write); enforcement reads only verified records; no schema change; the log is never mutated. Decided not to fix: the per-read whole-prefix SHA-256 (the cache's stated proof, ~14 ms at 6.4 MB, now 5x per tick, an incremental proof is its own task), chainAnomalies over the full array per read (linear, ~2 ms), loadPolicy per call (sub-ms), sweepTtl's per-candidate expire read (correct: each append needs a fresh head; only costs on a backlog of lapsed requests), QUEUE.md's unconditional rewrite (not in a watched directory), and the 250 ms / 30 s defaults (documented tuning instead). Tests: tests/audit-index.test.ts (3), tests/daemon-tick-cost.test.ts (2), tests/daemon.test.ts 'the daemon does not wake itself from its own writes', tests/verified-snapshot.test.ts (4 new). Full npm test 2806 pass / 0 fail / 1 pre-existing skip; oxlint clean. A copy of the live log could not be profiled (human-only classes); Carter can drop .approval into the scratch live/ dir to re-run.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Daemon tick 2,926 -> 208 ms (CPU 3,345 -> 207 ms) at 10k records: drift scan reads once per scan and re-reads only before an append (compare-and-append unchanged), snapshot publishes only on change with the digest the cache proved and the watcher ignores the daemon's own files (self-wake 18 -> 1 ticks/45 s), supervisedExecutions indexes declarations once (3,313 -> 18 ms). Verified by before/after per-phase profiles, cpu-prof, a real-daemon self-wake probe, 4 new test files/cases, full npm test 2806/0/1 skip, oxlint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
