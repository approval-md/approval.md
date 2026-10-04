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
updated_date: '2026-10-04 23:01'
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
1. cli.js: when argv names the hermes hook, register SIGTERM/SIGINT listeners as the first statements of the body (only node:fs is imported statically), before the dynamic import of dist/src/cli/main.js. The listener prints the runtime's hook-interrupted block (byte-identical) with writeSync(1) when nothing is on stdout yet, and exits 2; after main has answered it exits with that answer.
2. Ownership: hermesFailClosed raises globalThis[Symbol.for('approval-md.hermes-signal-owner')] (exported as HERMES_SIGNAL_OWNER) while its guards are registered; the bin's listener steps aside while it is true, so the two never both print.
3. src/cli/hook.ts: export hermesInterruptedDirective(signal), the single source hermesFailClosed prints from; the test compares the bin's spawned bytes against it.
4. Tests (new file): a stand-in dist/src/cli/main.js with a top-level await beside a copy of the real cli.js holds the load open with the event loop free; 20 concurrent children must exit 2 with the runtime's bytes. A stand-in that raises the owner flag proves the bin steps aside. A bin-level signal held through the wait ends with the run's own single verdict. Non-hook verbs and the other five harness hooks still die by SIGTERM. An arbitrary-instant smoke run.
5. Other harness hooks are not covered: the runtime answers a signal with a directive only for hermes.
6. docs/hermes-hook.md two-layers section stating what is measured (the CLI run is synchronous; whether the load yields depends on the Node release); CHANGELOG Unreleased; implementation notes naming SPEC 11.1 invariant 6 and the fail-closed rule.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
What was done
- cli.js: when argv names the Hermes hook (`hook hermes`, `--no-color` stripped the way main dispatches), the body's first statements register SIGTERM and SIGINT listeners before the dynamic import of dist/src/cli/main.js. Only node:fs is imported statically, so the stretch left uncovered is Node's own bootstrap before cli.js's first statement.
- The listener prints the runtime's hook-interrupted directive when nothing is on stdout yet (writeSync(1), since process.exit follows) and exits 2; after main has answered, it exits with that answer; with something printed and no answer yet, exit 2 without a second object.
- src/cli/hook.ts: `hermesInterruptedDirective(signal)` is the single source hermesFailClosed's guard prints from; cli.js spells the same bytes by hand (it runs before that module can load) and tests/hermes-bin-signal-guard.test.ts compares the bin's spawned stdout with the export. `HERMES_SIGNAL_OWNER` (Symbol.for('approval-md.hermes-signal-owner')) is raised on globalThis while hermesFailClosed's guards are registered (CLI only, restored in its finally); the bin steps aside while it is true.

What the diff alone does not show (refuter round, confirmed)
- On the CLI the Hermes hook run is synchronous end to end (readFileSync on stdin, Atomics.wait in the wait), and a JS signal listener runs only when the event loop turns. So hermesFailClosed's guard and the wait's withdrawing handler NEVER get a turn on the CLI: a signal during the run is held and dispatched after it returns, to the bin's guard, which exits with the run's own verdict. The first draft of this change handed over by listener count on the premise that the runtime answers; that premise was false, the docs said so, and it was corrected before merge. The owner flag replaces the listener count (an unrelated listener that does not exit can no longer switch the bin's guard off) and matters only if the run ever yields.
- Whether a cold dist/ load turns the event loop depends on the Node release (refuter measured ~30 turns on Node 24, 0 on Node 26). Where it turns, the bin prints hook-interrupted; where it does not, the signal is held into the run and the hook's own verdict answers. Both are fail-closed for a pre event (`{}` at 0 or a block at 2, never empty stdout); before this change both were a death by signal with an empty stdout.
- A --import resolve hook cannot hold the load open for a test (the main thread waits on the hooks thread synchronously), so the regression test uses a stand-in main.js with a top-level await beside a copy of the real cli.js. Negative control by hand: origin/main's cli.js with that stand-in dies by SIGTERM with empty stdout.
- Pre-existing defect surfaced by the refuter, NOT fixed here (older than this task, APRV-445): a SIGTERM during the wait does not withdraw the question; if a human grants before the wait ends, the hook answers `{}` and records execution.started for a call Hermes may already have abandoned. Needs a wait that yields to the event loop. Stated in docs/hermes-hook.md; proposed as a follow-up task for the orchestrator to file.
- A post event signalled during the load now gets a block at exit 2 (the bin cannot read stdin to tell post from pre). Hermes applies the blocking exit code to pre_tool_call only.
- Other harness hooks are NOT covered, on purpose: the runtime answers a signal with a directive only for hermes. The test pins --version, status and hook claude-code/cursor/codex/grok/muse still die by SIGTERM.

Invariants touched
- SPEC 11.1 invariant 6 (refusals machine-readable and distinct): the bin's answer is the existing hook-interrupted code in Hermes's {action, message} dialect, byte-identical, no new code and no second spelling.
- Fail closed (CLAUDE.md engineering invariants): an interrupted Hermes hook resolves to a verdict or the block, never to an empty-stdout death, from cli.js's first statement on. The bootstrap window and SIGKILL remain the Hermes-side layer (the gated image's shell_hooks patch, HOSTED-32).

Validation
- tests/hermes-bin-signal-guard.test.ts with cli-hook-hermes-rules, propose-recheck (L-d, the --version guard case still exits 1) and cli-hook-hermes run concurrently: 73/73, exit 0. docs-guard, serve-hook, serve: 72/72, exit 0. typecheck exit 0, lint exit 0.
- Full suite on the first commit (npm test -- --baseline): exit 1, 5593 tests, 5591 pass, 1 skip, 1 fail = gloss-codex 'Codex runner kills the process group on timeout and removes its empty cwd' (ENOENT on its capture file under load; untouched by this diff), rerun alone 5/5 exit 0. CI on the first commit: green (node 22 shards 1-3, protected paths, ci).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The approval bin (cli.js) now registers a SIGTERM/SIGINT guard in its first statements for `approval hook hermes`, so a signal while dist/ is loading no longer kills the hook with an empty stdout (a stock Hermes reads that as an allow): a signal heard during the load gets the runtime's own hook-interrupted directive (byte-identical, via the new hermesInterruptedDirective export) at exit 2, and a signal held until the synchronous hook run returns ends the process with that run's verdict. The runtime raises HERMES_SIGNAL_OWNER while its guards are registered and the bin steps aside, so they never both print; other verbs and the other five harness hooks are unchanged. Verified by tests/hermes-bin-signal-guard.test.ts (20 concurrent held-load children, owner-flag handover, held-through-wait, non-hook default disposition, arbitrary-instant smoke) and a by-hand negative control against origin/main's cli.js. docs/hermes-hook.md states the two layers and what is measured; the pre-existing no-withdraw-on-signal defect in the wait is documented and proposed as a follow-up.
<!-- SECTION:FINAL_SUMMARY:END -->
