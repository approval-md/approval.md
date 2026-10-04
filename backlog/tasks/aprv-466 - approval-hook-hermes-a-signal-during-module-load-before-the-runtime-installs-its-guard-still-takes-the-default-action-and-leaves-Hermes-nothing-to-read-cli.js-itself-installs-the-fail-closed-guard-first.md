---
id: APRV-466
title: >-
  approval hook hermes: a signal during module load, before the runtime installs
  its guard, still takes the default action and leaves Hermes nothing to read;
  cli.js itself installs the fail-closed guard first
status: Done
assignee:
  - '@claude-c14'
created_date: '2026-10-04 10:43'
updated_date: '2026-10-04 22:44'
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
- [x] #1 cli.js installs the fail-closed signal guard before importing the runtime when argv names the hermes hook; the directive printed is byte-identical to the runtime's hook-interrupted block
- [x] #2 A test spawns the hook and signals it immediately, repeated 20 times under load, and never observes an exit without the directive; the SIGTERM mid-wait test still passes
- [x] #3 docs/hermes-hook.md states the two layers (process guard here, shell_hooks patch on Hermes's side) and what each covers
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. cli.js: when argv names the hermes hook, install SIGTERM/SIGINT listeners as the first statements of the body (only node:fs is imported statically), before the dynamic import of dist/src/cli/main.js. The listener prints the runtime's hook-interrupted block (byte-identical to hermesFailClosed's early-signal directive) with writeSync(1) when nothing is on stdout yet, and exits 2.
2. Handoff without a second print: the bin's listener defers whenever another listener for the same signal is registered (the runtime's hermesFailClosed guard is added after it with process.on; the wait's handler is prepended and exits first). Once main() has answered, a signal ends the process with the verdict already reached; with something printed and no answer yet, exit 2 without printing again.
3. src/cli/hook.ts: export the early-signal directive as one function (hermesInterruptedDirective) used by hermesFailClosed, so the test compares the bin's bytes against the runtime's own.
4. Tests (new file): a resolve hook holds dist/src/cli/main.js and writes a marker to fd 2, so the signal lands deterministically inside module load; 20 concurrent children, SIGTERM/SIGINT alternating, each must exit 2 with stdout equal to the runtime directive. A raw variant signals at spawn (20 concurrent) and asserts no numeric exit other than 2 and no exit without a directive (a death by signal before cli.js runs is Node bootstrap, named as Hermes's layer). A bin-level mid-wait SIGTERM prints exactly one object. Non-hook verbs unchanged (--version guard case in propose-recheck stays).
5. Other harness hooks: the runtime answers signals with a directive only for hermes (others exit 1 with nothing), so only hermes is covered; reported.
6. docs/hermes-hook.md two-layers paragraph; CHANGELOG Unreleased; implementation notes naming SPEC 11.1 invariant 6 and the fail-closed rule.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
What was done
- cli.js: when argv names the Hermes hook (`hook hermes`, `--no-color` stripped the way main dispatches), the body's first statements register SIGTERM and SIGINT listeners, before the dynamic import of dist/src/cli/main.js. Only node:fs is imported statically, so the one stretch left uncovered is Node's own bootstrap before cli.js's first statement.
- The listener prints the runtime's hook-interrupted directive when nothing is on stdout yet (writeSync(1), since process.exit follows) and exits 2. src/cli/hook.ts gains `hermesInterruptedDirective(signal)`, now the single source hermesFailClosed's guard prints from; cli.js spells the same bytes by hand (it runs before that module can load) and tests/hermes-bin-signal-guard.test.ts compares the bin's spawned stdout with the export.

Decisions
- Handover by listener count, no removeListener: the bin's listener returns whenever another listener for the same signal is registered. hermesFailClosed adds its guard after the bin's with process.on, and the wait prepends its handler, so Node reaches the runtime's handler (which knows whether the event is a post event and what it already printed) and only one of them prints. When the runtime removes its guards in its finally, the bin's is sole again: after main has answered, a signal ends the process with the answer already given (process.exit() with the verdict's exitCode); with something printed and no answer yet, exit 2 without a second object.
- A signal during module load on a post event now answers with a block at exit 2. Hermes applies the blocking exit code to pre_tool_call only, so a post event is unaffected; the existing post-event test already accepts exit 2 with a block.
- Other harness hooks are NOT covered, on purpose: the runtime answers a signal with a directive only for hermes (claude-code, cursor, codex, grok, muse exit 1 with nothing from the wait handler, and have no hermesFailClosed). A new test pins that --version, status, hook claude-code and hook grok still die by SIGTERM while the runtime loads.
- The test holds the runtime open with a stand-in dist/src/cli/main.js that awaits at top level beside a copy of the real cli.js. A --import resolve hook (the L-d technique) does not work for this: on Node 26 the main thread waits on the hooks thread synchronously, so a signal sent while a resolve is held is dispatched only after it returns. Negative control run by hand: origin/main's cli.js with the same stand-in dies by SIGTERM with empty stdout; this branch's prints the directive at exit 2.

Invariants touched
- SPEC 11.1 invariant 6 (refusals machine-readable and distinct): the bin's answer is the runtime's existing hook-interrupted code in Hermes's {action, message} dialect, byte-identical, so no new refusal code and no second spelling.
- Fail closed (CLAUDE.md engineering invariants, SPEC 11.1): an ambiguous end of a Hermes hook resolves to the block. The bootstrap window before cli.js runs, and SIGKILL, remain Hermes's layer (the gated image's shell_hooks patch, HOSTED-32); docs/hermes-hook.md states the two layers.

Validation: tests/hermes-bin-signal-guard.test.ts 5/5 exit 0 alone and 72/72 exit 0 run concurrently with cli-hook-hermes-rules, propose-recheck (L-d, the --version guard case still exits 1) and cli-hook-hermes; the existing SIGTERM mid-wait test passes. Full suite (npm test -- --baseline) exit 1: 5593 tests, 5591 pass, 1 skip, 1 fail = gloss-codex 'Codex runner kills the process group on timeout and removes its empty cwd' (ENOENT on its capture file under load; file untouched by this diff), rerun alone 5/5 exit 0. typecheck exit 0, lint exit 0.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The approval bin (cli.js) now installs a SIGTERM/SIGINT guard in its first statements for `approval hook hermes`, so a signal while dist/ is still loading prints the runtime's own hook-interrupted block directive (byte-identical, shared through the new hermesInterruptedDirective export) and exits 2 instead of dying with an empty stdout that stock Hermes reads as an allow. The guard steps aside while the runtime's guards are registered, so only one object is ever printed; other verbs and other harness hooks are unchanged. Verified by tests/hermes-bin-signal-guard.test.ts (20 concurrent held-load children, 20 arbitrary-instant children, bin-level mid-wait, non-hook default disposition) and a by-hand negative control against origin/main's cli.js. docs/hermes-hook.md states the two layers (process guard here, Hermes-side shell_hooks patch for Node's bootstrap and SIGKILL).
<!-- SECTION:FINAL_SUMMARY:END -->
