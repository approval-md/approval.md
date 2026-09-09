---
id: APRV-230
title: >-
  Phantom ticks: the daemon wakes without an append; find the watcher source and
  filter or attribute it
status: In Progress
assignee:
  - '@opus-230'
created_date: '2026-09-02 18:17'
updated_date: '2026-09-06 08:18'
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
- [x] #2 Events provably from bookkeeping files (the append lockfile, editor swap files, .DS_Store) no longer schedule a tick, with a test per filtered name
- [x] #3 The tick line gains an additive woke_by field (log | tasks | interval) and the filename that woke it when one was reported, and the human formatter prints it
- [x] #4 The APRV-212 no-self-wake test still passes and a new test proves a lockfile create/remove in the log dir does not tick
- [ ] #5 docs/cli-reference.md daemon run section documents the trace flag and the woke_by field; npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/daemon/daemon.ts: add an exported `bookkeepingReason(name)` predicate naming the class of a bookkeeping file (lockfile, editor swap/backup, .DS_Store/AppleDouble, temp) so both watchers and the tests share one list.
2. Rework `attachWatchers`: one `onWatchEvent(watcher, event, name)` per directory that decides schedule vs ignore with a machine-readable reason (self-write, own-temp, bookkeeping, not-the-log, no-name-believed), records the wake (source + file) when it schedules, and emits a `watch` DaemonEvent when tracing is on. A nameless platform event still schedules (the platform saying 'something here changed'); documented as the one remaining unattributable wake.
3. New additive DaemonEvent `{event:'watch', watcher, type, file, action:'scheduled'|'ignored', reason}`, emitted only under DaemonOptions.traceWatch. Human formatter prints it as a 'watch:' line on stdout.
4. tick line: additive `woke_by: 'log'|'tasks'|'interval'` plus optional `woke_file`, taken from the wake that opened the current debounce window and cleared at tick start; startup/--once/periodic ticks report `interval`. Human formatter appends 'woke by <source>[ (<file>)]'.
5. CLI: --trace-watch on `daemon run` and `approval up` (flag tables, help text, verb-registry input flags), threaded to DaemonOptions.traceWatch.
6. Tests (tests/daemon.test.ts): one live-daemon case per filtered name (events.jsonl.lock in the log dir, .task-042.md.swp, .DS_Store, and a task backup in the task folder) proving no tick; a --trace-watch case asserting watcher/type/file on the trace lines; a woke_by case (external append -> log, task edit -> tasks, periodic -> interval); the APRV-212 no-self-wake case unchanged.
7. Trace classification: run a scratch instance under $TMPDIR that reproduces lockfile/swap/.DS_Store sources and record the counts in the notes; the live-primary run stays with the human (AC1 left unchecked).
8. docs/cli-reference.md daemon run: document --trace-watch, the watch line and the woke_by field; update the JSON sample. npm run build, daemon suites, lint, typecheck.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What changed

- `src/daemon/daemon.ts`: `bookkeepingKind(name)` names the classes of file that sit in a
  watched directory without ever being its subject (the append lockfile `<log>.lock`, vim
  swap files, emacs autosave/lock files, `~` and JetBrains backups, `.DS_Store` and
  AppleDouble `._*`). `classifyWatchEvent` is now the whole watcher decision in one place
  and returns a machine-readable reason (`self-write`, `own-temp`, `bookkeeping`,
  `not-the-log`) or `null` for "schedule". APRV-212's two filters are unchanged inside it.
- New additive DaemonEvent variant `watch`: watcher, the platform's own event type, the
  file it named (or null), `action` (scheduled|ignored) and `reason`. Emitted only under
  the new `DaemonOptions.traceWatch`, so the default stream is unchanged.
- The `tick` line gains additive `woke_by` (log|tasks|interval) and optional `woke_file`.
  The attributed wake is the event that OPENED the debounce window (later events in the
  same burst only move the deadline); it is taken once at the top of a tick and cleared
  there, so a periodic tick that runs first takes the attribution with the work.
  `interval` covers the periodic tick, the startup tick and `--once`.
- CLI: `--trace-watch` on `daemon run` AND `approval up` (flag tables, verb-registry
  input flags, DAEMON_RUN_HELP). The human formatter prints `watch: <watcher> <type>
  <file> — ignored (<reason>)` and appends `woke by <source> <file>` to the tick line.
  The help line was merged with `--read-proof` to stay under the 25-line short-help cap
  (`cli-long-help` enforces it).
- `docs/cli-reference.md` daemon run: the bookkeeping filter, `woke_by`/`woke_file`,
  `--trace-watch` with a human sample, and two `watch` lines plus the new tick fields in
  the --json block. The old sentence 'any tick you see with no external append is the
  --interval tick' was removed: the trace shows it is not true (see finding 5).

## Decisions

- A platform event that names NO file still schedules a tick. It is the platform saying
  'something in this directory changed' and the log is one of the things it might be;
  believing it costs a tick and doubting it could cost an append's latency. It is the one
  wake source left deliberately unattributed, and it is now visible in the trace.
- The lockfile was already dropped by the log watcher's name check; it is now dropped as
  `bookkeeping` so the trace says what it was rather than lumping it in with the snapshot.
- `--debounce` defaults untouched, as the task requires.

## The classification (AC1), on a SCRATCH instance — the live-primary run is left for the human

An agent may not touch the primary checkout or its log (`.approval/` is `policy.core`,
human-only), so the trace ran against a throwaway instance under $TMPDIR built through the
real CLI verbs, reproducing the sources the postmortem names: five `approval request`
appends made by ANOTHER process (each takes and releases `events.jsonl.lock` and publishes
a verified-head snapshot from its own read), an editor's swap/autosave/lock/backup files
and a `.DS_Store` created and removed in the task folder, and one real task-file save.
Command: `approval daemon run --json --trace-watch --interval 60s --debounce 250ms`,
about 15 s of activity. Script kept at scratchpad/trace-classify.mjs.

55 watcher events, 8 ticks:

| watcher | file | action | reason | n |
|---|---|---|---|---|
| log | events.jsonl | scheduled | - | 6 |
| log | events.jsonl.lock | ignored | bookkeeping | 12 |
| log | verified-head.json | ignored | not-the-log | 13 |
| log | verified-head.json.<pid>.tmp | ignored | not-the-log | 10 |
| tasks | task-042.md | scheduled | - | 1 |
| tasks | task-042.md | ignored | self-write | 2 |
| tasks | .task-042.md.tmp-<pid>-1 | ignored | own-temp | 1 |
| tasks | .task-042.md.swp | ignored | bookkeeping | 2 |
| tasks | #task-042.md# | ignored | bookkeeping | 2 |
| tasks | .#task-042.md | ignored | bookkeeping | 2 |
| tasks | task-042.md~ | ignored | bookkeeping | 2 |
| tasks | .DS_Store | ignored | bookkeeping | 2 |

Ticks by wake: interval 1, log/events.jsonl 6, tasks/task-042.md 1. Heads per tick:
2, 4, 4, 5, 6, 7, 8, 8.

Findings:
1. ZERO nameless events. All 55 named a file on macOS, so candidate (a)'s 'a nameless
   platform event for the lockfile would pass' did not appear in this run. Nameless events
   are still believed, on purpose.
2. Candidate (d) is real and is now filtered: 10 of 55 events were editor/Finder
   bookkeeping in the task folder. Before this change every one of them scheduled a tick;
   after debouncing that is roughly 5 phantom ticks against 7 real ones in the same window.
3. Candidate (a), the lockfile, is 12 of 55 events (two per append per writer) and is
   dropped by name in both the old code and the new; the trace now says so.
4. APRV-212's snapshot filter carries 23 of 55 events (`verified-head.json` and its temp
   file), silent before and visible now.
5. Candidate (b) SURVIVES and is now attributed rather than filtered: ticks 2 and 3 both
   ran at head 4, both woken by a NAMED `events.jsonl` event, for one append — macOS
   delivering two events for one append more than a debounce apart. One duplicate in seven
   watcher-driven ticks here. Filtering it would need state the watcher does not have (the
   log's size/mtime as of the last tick) and would risk dropping a real append, so it is
   left countable rather than guessed at; `woke_by` plus an unchanged `head` is the count.

WHAT IS LEFT FOR THE HUMAN (AC1 is unchecked for this reason): the same run on the live
primary. `approval up --trace-watch` (or `approval daemon run --trace-watch`) in
/Users/carter/dev/approval-md for an hour, then group the `watch` lines by
watcher/file/reason and the `tick` lines by `woke_by` with the head column beside them.
The scratch run reproduces the sources but not the primary's rate, its concurrent hook
sessions (candidate e), or other sessions' Backlog.md edits (candidate c).

## Invariants (CLAUDE.md / SPEC.md §11.1)

None touched, and none weakened. The watcher is a latency optimization and correctness
never depended on it (SPEC.md §10.2): every tick re-scans the task folder and re-derives
everything from the verified log, and the periodic tick runs whether or not any watcher
fires, so an over-eager name in the bookkeeping list costs at most one `--interval` of
latency and never an answer. No append path, no schema, no policy read, no verdict, and no
compare-and-append changed. `watch` and the two tick fields are additive, report-only
output; the frozen-union test in tests/daemon.test.ts lists the new variant.

## Verification

- `npm run build` exit 0; `npm run typecheck` exit 0; `npm run lint` exit 0, no warnings.
- `node scripts/run-tests.mjs --only daemon cli-long-help`: 58 tests, 58 pass, 0 fail,
  exit 0. That run includes the APRV-212 case 'the daemon does not wake itself from its own
  writes' (still green, AC4) and the six new cases: one per filtered bookkeeping name
  (`events.jsonl.lock` created and removed in the log dir, `.task-042.md.swp`,
  `.DS_Store`, `task-042.md~`), one asserting the trace's watcher/type/file/action/reason,
  and one asserting `woke_by`/`woke_file` for an interval tick, a task-file save and an
  append.
- `node scripts/run-tests.mjs --only daemon-tick-cost daemon-projection cli-help
  cli-long-help cli-coverage`: 54 tests, 54 pass, 0 fail, exit 0.
- Human formatter, observed on a scratch instance:
  `tick 1: head seq 8, 0 drift, 0 expired, 0 escalated (948.4 ms, 5 reads, woke by interval)`
  and `watch: log rename events.jsonl.lock — ignored (bookkeeping)`.
- `approval up --once --json --trace-watch --no-telegram --no-web --as human:carter` exits
  0 and carries `woke_by`, so both spellings of the verb accept the flag.

AC5 is left unchecked for one reason only: its 'npm test passes' clause. The docs half
is done (docs/cli-reference.md, daemon run section: the trace flag, the watch line, the
woke_by/woke_file fields, and the JSON sample) and `npm run lint` is clean. A full
`npm test` cannot pass in an agent WORKTREE: tests/ci-guard.test.ts's dependency-floor
case reads <repo root>/node_modules/<dep>/package.json, and a worktree has no node_modules
of its own (module resolution walks up to the primary checkout's). Read from the primary's
installed tree, every production dependency admits the Node 20 floor
(@modelcontextprotocol/sdk >=18, better-sqlite3 20.x||22.x||…, yaml >= 14.6, ajv and
ajv-formats declare no range), so that case is environmental and untouched by this diff,
which adds no dependency. The daemon suites, cli-help, cli-long-help, cli-coverage,
daemon-tick-cost and daemon-projection were run here and are green.
<!-- SECTION:NOTES:END -->
