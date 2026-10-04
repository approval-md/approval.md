---
id: APRV-466
title: >-
  approval hook hermes: a signal during module load, before the runtime installs
  its guard, still takes the default action and leaves Hermes nothing to read;
  cli.js itself installs the fail-closed guard first
status: To Do
assignee: []
created_date: '2026-10-04 10:43'
labels:
  - agent-village
dependencies:
  - APRV-445
priority: high
ordinal: 353000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found 2026-10-04 while fixing PR #569's merge-queue ejection (APRV-445, commit a4dd89e5). The hook used to install its SIGTERM/SIGINT handler only on entering the wait, so a signal between approval.requested and the wait killed the process with nothing on stdout, which Hermes's fail_closed reads as an allow; a4dd89e5 moves the guard to the whole hermesFailClosed run (prints the hook-interrupted block directive, exits 2). What remains: a signal that lands during ESM module load, before any runtime code runs, still takes the default action. Hermes sends SIGTERM on its hook timeout and on gateway shutdown, and a sandbox restart can land it at any instant, so the window is real. Fix in cli.js (the bin) itself: the very first statements install a minimal signal guard that, when argv names the hermes hook, prints the frozen block directive and exits 2; the runtime's richer guard replaces it once loaded. Prove it with a test that signals the child the moment it is spawned (before any stderr), repeated under load; it must never exit without the directive. Related: the hosted gated image's shell_hooks patch (HOSTED-32) already blocks a hook killed by a signal on Hermes's side, which is the other half of the belt.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 cli.js installs the fail-closed signal guard before importing the runtime when argv names the hermes hook; the directive printed is byte-identical to the runtime's hook-interrupted block
- [ ] #2 A test spawns the hook and signals it immediately, repeated 20 times under load, and never observes an exit without the directive; the SIGTERM mid-wait test still passes
- [ ] #3 docs/hermes-hook.md states the two layers (process guard here, shell_hooks patch on Hermes's side) and what each covers
<!-- AC:END -->
