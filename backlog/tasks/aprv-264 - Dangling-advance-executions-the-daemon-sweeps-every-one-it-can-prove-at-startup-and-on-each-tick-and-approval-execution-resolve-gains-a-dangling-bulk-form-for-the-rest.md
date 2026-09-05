---
id: APRV-264
title: >-
  Dangling advance executions: the daemon sweeps every one it can prove at
  startup and on each tick, and approval execution resolve gains a --dangling
  bulk form for the rest
status: To Do
assignee: []
created_date: '2026-09-05 10:04'
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
