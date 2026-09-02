---
id: APRV-230
title: >-
  Phantom ticks: the daemon wakes without an append; find the watcher source and
  filter or attribute it
status: To Do
assignee: []
created_date: '2026-09-02 18:17'
labels:
  - daemon
  - performance
dependencies: []
references:
  - APRV-212
  - APRV-213
  - docs/postmortem-2026-09-02-daemon-tick-cpu.md
priority: medium
type: bug
ordinal: 183000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed on the primary 2026-09-02 after APRV-212 shipped, with --debounce 250ms and later 2s: tick pairs and runs at an UNCHANGED head with no external append (e.g. ticks 67/68 at seq 11219, 72/73, 74/75, a run of ticks 79-83 at seq 11230, and ticks 1/2 at seq 12295 right after a fresh start with read proof full). The daemon watches two directories: dirname(logPath) (.approval/log) and the task folder (backlog/tasks). APRV-212 already filters the daemon's own writes: the log-dir watcher schedules only for the log's basename or a nameless event; the tasks watcher ignores this process's write-back basenames and its .<name>.tmp-<pid>-<n> temp files. Candidates for what remains: (a) the append lockfile events.jsonl.lock created and removed by every writer (filtered by name today, but a nameless platform event for it would pass); (b) fs.watch on macOS delivering two events for one append (write plus attribute change) more than one debounce apart; (c) other sessions' backlog CLI edits or Backlog.md's own rewrites in backlog/tasks (legitimate, but each is a full tick); (d) editor swap files or .DS_Store in the task folder; (e) the hook's approval wait polling writing nothing but the platform reporting a change anyway. Each phantom tick costs a full tick (~300 ms on the live log) so at the observed rate it is roughly a third of the daemon's CPU. Approach: add a debug-level line (behind --json or a --trace-watch flag) that names the watcher, the event type and the filename for every watcher event, run it on the primary for an hour, classify what fired, then filter what is provably the daemon's own or bookkeeping (lockfile, swap files) and attribute the rest on the tick line (tick.woke_by: log | tasks | interval, plus the filename). Correctness never depended on the watcher (SPEC §10.2), so an over-eager filter costs latency and never a wrong answer; an under-eager one costs CPU. Do not change --debounce defaults here.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A --trace-watch flag (or the --json stream) reports every watcher event with watcher name, event type and filename, and a run on the live primary classifies the phantom-tick sources; the classification is in the implementation notes with counts
- [ ] #2 Events provably from bookkeeping files (the append lockfile, editor swap files, .DS_Store) no longer schedule a tick, with a test per filtered name
- [ ] #3 The tick line gains an additive woke_by field (log | tasks | interval) and the filename that woke it when one was reported, and the human formatter prints it
- [ ] #4 The APRV-212 no-self-wake test still passes and a new test proves a lockfile create/remove in the log dir does not tick
- [ ] #5 docs/cli-reference.md daemon run section documents the trace flag and the woke_by field; npm test passes; lint clean
<!-- AC:END -->
