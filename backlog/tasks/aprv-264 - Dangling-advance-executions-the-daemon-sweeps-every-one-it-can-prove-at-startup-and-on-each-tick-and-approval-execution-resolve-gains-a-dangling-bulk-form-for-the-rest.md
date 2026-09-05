---
id: APRV-264
title: >-
  Dangling advance executions: the daemon sweeps every one it can prove at
  startup and on each tick, and approval execution resolve gains a --dangling
  bulk form for the rest
status: In Progress
assignee:
  - 'agent:opus-lane-a'
created_date: '2026-09-05 10:04'
updated_date: '2026-09-05 11:01'
labels:
  - daemon
  - cli
  - dogfood
dependencies: []
priority: high
ordinal: 196000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Seen 2026-09-05 after the APRV-233 build went live: approval status listed five dangling daemon-log-advance executions left by the 2026-09-02 advance loop, the daemon refused one advance per tick naming one key each (advance-refused: an execution nobody closed, no further advance is started while it stands), and Carter resolved all five by hand with five near-identical approval execution resolve commands. APRV-233's reconcile rule closes only the current span's dangling execution and only when publishedState proves the push landed; the anchor regression filed today broke that proof (highest published seq 0), and older dangling advances from before a restart are never swept. Outcome: (1) at startup and on every tick before authorizing an advance, the daemon lists every dangling daemon-minted advance execution, and for each one the trunk or a records ref carries (the seq the execution named is at or below the highest published seq on origin/main or refs/approval/advance/*), appends execution.completed with a note naming the ref, through compare-and-append and the head-retry helper; what it cannot prove it reports once per key on the started line and the doctor cadence row, never once per tick; (2) approval execution resolve gains --dangling [--class <class>] which lists every dangling execution with what the runtime can prove for each, asks for one confirmation, and appends one outcome per key with the human as actor; keys it cannot prove are listed with the one-line manual command; (3) the refusal that blocks the advance names all outstanding keys and the bulk command. Why: five copy-pasted commands in a second terminal window is the manual step the cadence exists to remove.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A test with three dangling advance executions whose seqs the scratch trunk carries proves the daemon closes all three on its first tick with execution.completed records naming the ref, then advances
- [ ] #2 A dangling execution the trunk does not carry is reported once (started line and doctor row), not on every tick, and the advance refusal names every outstanding key plus the bulk command
- [ ] #3 approval execution resolve --dangling lists provable and unprovable keys, asks once, and appends one human-attested outcome per provable key; --json carries the list
- [ ] #4 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. core/advance-cycle.ts gains the shared, pure vocabulary of the sweep: spanEndOf (the seq an advance key names), danglingAdvanceKeys (dangling executions whose key carries the daemon's prefix), advanceSweepEntries (each key paired with the ref that proves its seq is published, or null), and RESOLVE_DANGLING_COMMAND spelled once. Pure over records plus a publishedSeq/publishedRev the caller supplies, so the daemon, the doctor row and the CLI all read one rule and a CLI module still never imports the daemon.
2. daemon/advance.ts: reconcileDanglingAdvance (one key, the last) becomes sweepDanglingAdvances (every key), one publishedState call for the whole sweep, one finishWithHeadMovedRetry per provable key with an execution.completed note naming the ref and saying the runtime observed it (ADVANCE_ACTOR, never human-attested). authorizeAdvance's advance-unreconciled refusal names every outstanding key and the bulk command.
3. daemon/daemon.ts: the startup listing (no appends) rides the started line as dangling_advances and seeds reportedDangling, which becomes a Set, so the first tick does not say it twice; each tick sweeps before any trigger, emits one advance line per settled key, and warns once per key-set change naming every outstanding key and the bulk command.
4. cli/doctor.ts: the log-advance-cadence row names the outstanding keys and the bulk command.
5. cli/execute.ts: approval execution resolve --dangling [--class <class>] [--yes] [--json], with a Prompter seam like gate-window's. Lists provable and unprovable keys, asks once on a TTY (refuses dangling-stdin-not-tty without one unless --yes), appends one human-attested resolveExecution per provable key with the generated note naming the ref, leaves unprovable keys alone with their one-line manual command. help.ts, verb-registry.ts (output becomes anyOf of the single and bulk shapes) and docs/cli-reference.md follow.
6. Tests: a sweep suite over the real git topology (three dangling advances the scratch trunk carries, closed on one tick, then advanced; one it does not carry, reported once and naming every key plus the bulk command in the refusal), and a CLI suite for --dangling (list, one confirmation, one outcome per provable key, --json, no TTY without --yes).
<!-- SECTION:PLAN:END -->
