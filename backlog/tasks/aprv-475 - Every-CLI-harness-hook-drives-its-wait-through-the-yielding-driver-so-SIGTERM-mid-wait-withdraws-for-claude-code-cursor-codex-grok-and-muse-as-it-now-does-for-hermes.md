---
id: APRV-475
title: >-
  Every CLI harness hook drives its wait through the yielding driver, so SIGTERM
  mid-wait withdraws for claude-code, cursor, codex, grok and muse as it now
  does for hermes
status: Done
assignee:
  - '@claude-c17'
created_date: '2026-10-05 01:55'
updated_date: '2026-10-05 03:13'
labels:
  - security
dependencies:
  - APRV-473
priority: medium
ordinal: 362000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From APRV-473 (PR #608, 2026-10-05): the gate path is now one generator chain with two drivers; approval hook hermes runs through the yielding driver (timers), so a signal during the wait reaches the withdrawing handler within one pause and no execution.started is appended after an interruption. The other CLI harness verbs (claude-code, cursor, codex, grok, muse) still run the synchronous driver, so their wait handlers never run mid-wait and a grant after the harness abandoned the call can still record a start for a tool that never ran. The change is a one-line switch per verb in src/cli/main.ts plus the per-harness directive each prints on interruption (those harnesses exit 1 with nothing on stdout today: decide and document what each harness reads as a block, since claude-code reads exit 2 plus a JSON decision and the others differ). Keep commandHook's synchronous API for the Codex bridge and the serve worker. Tests: the hermes-wait-interrupt cases parameterised over the harnesses; the 20x concurrent race; docs/claude-code-hook.md and the other harness docs updated. Also fold in the SPEC section 10.1 interrupt rule drafted in APRV-473's notes for the next attestation batch.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 All five CLI harness verbs use the yielding driver; a SIGTERM mid-wait withdraws and prints that harness's block form; tests per harness including the grant race
- [x] #2 No execution.started after an interruption on any harness; the pause-before-spend is shared, not copied
- [x] #3 Docs per harness state the interrupt rule; SPEC 10.1 hunk recorded for the batch
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. main.ts: every `approval hook` subcommand runs through commandHookYielding (the hermes try/catch stays for Hermes only); commandHook stays synchronous for the serve worker, the Codex bridge (decideHarnessCall) and in-process callers.
2. hook.ts wait handler (gateHarnessSteps onSignal): one harness-agnostic answer. After the withdrawal it writes harnessBlockDirective('hook-interrupted', 'the hook received <SIG> while waiting for a decision; nothing authorizes this call', run.harness) with writeSync and exits with that directive's own exit code (0 for claude-code, cursor, codex, muse; 2 for grok, hermes). If stdout cannot take the whole directive it exits 2, the empty-stdout code these harnesses read as a block. The hermes-only branch and the EXIT_USAGE-with-nothing-printed branch both go.
3. BEFORE_SPEND and the two drivers are untouched: the pause before every execution.started/gate.bypassed append is already in the one generator chain, so switching the driver makes it effective for every harness with no per-harness code. Update the comments and docstrings that say only Hermes yields.
4. Pre-wait stretch on the non-Hermes harnesses: no JS listener is registered there, so a signal takes the default disposition at once (death, nothing spent, nothing printed); pinned by a test, documented, and an early guard for those harnesses filed as a follow-up rather than built here.
5. Tests: tests/harness-wait-interrupt.test.ts parameterised over claude-code, cursor, codex (apply_patch, files.write.workspace manual), grok, muse: SIGTERM through the bin and SIGINT through the entry mid-wait (withdrawn, the harness's own deny bytes and exit code, later grant refused request-withdrawn, no start); the grant-then-signal race (no withdrawal over the grant, no start); the 20x concurrent race per harness; the signal held through the stdin read (default disposition, no start); the quiet wait still times out. Regression proof on the synchronous driver.
6. Docs: claude-code-hook.md, cursor-hook.md, codex-hook.md, grok-hook.md, muse-hook.md each state the interrupt rule in that harness's block form. CHANGELOG Unreleased. The SPEC §10.1 interrupt hunk (folded from APRV-473's draft, generalised to every adapter) goes in the notes as pending sign-off for the next attestation batch; SPEC.md, APPROVAL.md and .approval/ untouched.
7. typecheck, lint, targeted files on Node 24 and the default Node, full suite with --baseline; notes, ACs, PR, refuter, CI, arm.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Approach. src/cli/main.ts routes every `approval hook <subcommand>` through commandHookYielding (the APRV-473 yielding driver); Hermes keeps its own try/catch for a module that fails to load. commandHook stays synchronous (driveSync) for the in-process callers, the serve worker and the Codex bridge (decideHarnessCall), so their behaviour is unchanged. `hook classify` also runs through the yielding driver; it never pauses, so it returns on the first step.

The wait's signal handler (gateHarnessSteps onSignal) is now harness-agnostic: after its withdrawal it calls exitInterruptedWait(signal, run.harness), which writes interruptedWaitDirective(signal, harness) with writeSync(1) and exits with that directive's own exit code. interruptedWaitDirective is harnessBlockDirective('hook-interrupted', 'the hook received <SIG> while waiting for a decision; nothing authorizes this call', harness), so it renders through deny(): one construction site per harness, the same bytes every other refusal of that harness gets. Per harness: nested hookSpecificOutput deny at exit 0 (claude-code, codex, muse), {permission,user_message,agent_message} deny at exit 0 (cursor), {decision:deny,reason} at exit 2 (grok), {action:block,message} at exit 2 (hermes, byte-identical to before). Before this the five non-Hermes harnesses exited 2 (EXIT_USAGE) with nothing on stdout.

Decision: the interrupted answer is each harness's ORDINARY deny rather than a bare exit 2. Reasons: it is the form each adapter already documents and tests as a block (Muse: nested-at-0 is the measured form that carries a reason; Codex: the observed-version deny is nested-at-0, and how Codex reads exit 2 with an empty stdout is not recorded); it gives the model the reason; and it keeps one dialect per harness. Fallback: a writeSync that throws or comes up short exits INTERRUPTED_BARE_EXIT = 2, the one code these harnesses read as a block on an empty stdout (Claude Code blocking error, Grok deny, Hermes unconditional, Muse measured, Cursor failClosed on any non-zero). Residue stated in the Muse doc: a TORN line at exit 2 is unparseable on Muse and fails open there; the directive is a few hundred bytes, under PIPE_BUF, so a short pipe write is not expected.

Shared pause: BEFORE_SPEND is a yield inside the one gate chain, untouched here; switching the driver made it effective for all six harnesses with no per-harness copy. The only per-harness code is the directive, and it comes from the existing per-harness renderer.

Pre-wait stretch (decided, not built): the five non-Hermes harnesses register no SIGTERM/SIGINT listener outside the wait, so a signal there takes the default disposition at once: the process dies with nothing printed, and nothing can be appended after the signal. A request already appended but not yet waited on (the microseconds between the request append and the listener registration) stays open as a timed-out one does. Safe for the log, but Claude Code, Codex, Grok and Muse read a dead hook as no opinion and run the call (Cursor with failClosed blocks). Filed APRV-477 for an early guard on those harnesses; pinned today's behaviour with a test so APRV-477 has to change it deliberately.

After the wait: the listener is removed in the wait's finally, so a signal landing between that and the verdict print takes the default disposition; the start was already recorded before the signal. The 20x race sees this ('ended after the spend', 0 to 1 per 20 runs) and the test asserts exactly one start and never a block in that branch.

Not changed: docs/hermes-hook.md (still accurate); serve (no signals in a worker thread; departure is callerGone, APRV-427); the Codex bridge (driveSync; its handler can never be dispatched there, so it never writes into the bridge's JSON-RPC stdout; comment says so); the agent SDK shim (it kills with SIGKILL at its deadline, which no handler sees: nothing is spent and the question stays open for the retry grace).

Proposed SPEC.md §10.1 hunk, PENDING SIGN-OFF for the next attestation batch (folded from APRV-473's draft and generalised; not applied, SPEC.md untouched). Place it after the paragraph 'A harness wait that expires, and the question it leaves behind':

**A harness wait that is interrupted.** An adapter whose process receives a termination signal (SIGTERM or SIGINT) while it waits on a human MUST end the wait within one poll interval, MUST withdraw the requests it opened (`approval.withdrawn`, reason `cancelled`), and MUST answer a block in its harness's own dialect, at the exit code that harness reads as one, before it exits; when its output cannot be written whole it MUST exit with the code that harness reads as a block on an empty output. It MUST NOT record `execution.started` for that tool call afterwards: the harness that sent the signal has abandoned the call. A grant recorded before the signal is dispatched is left standing and unspent, since the withdrawal is refused `already-decided` and nothing is written over a decision. A request the adapter adopted from an earlier call is left alone, since a withdrawal is the requester's own. A wait that cannot observe a signal until it returns, such as a synchronous sleep, does not meet this rule. Before every spend the adapter gives a pending signal one chance to be observed, so a signal held through the synchronous stretch before a spend blocks it; a signal that lands inside the spend's own append is answered by the verdict already reached. (Amended APRV-475, pending sign-off.)

§11.1 invariants touched: 5 (compare-and-append) unchanged, withdraw and consumeHarnessGrant still compare-and-append; 6 (distinct refusals) unchanged codes, hook-interrupted on the block and request-withdrawn / already-decided from the state machine; 1 (verified reads) unchanged, the poll reads only the verified log and the interruption is decided by the OS signal, never by a harness field; 2 (no caller timestamps) untouched, the withdrawal's ts is assigned at the write boundary; 8 (a verdict whose event cannot be appended is a refusal) unchanged, the interrupted path is a block either way.

Validation (pre-PR). Regression proof: with main.ts reverted to the synchronous commandHook for the five harnesses, grok and muse mid-wait tests hit the 120 s backstop and the race tests fail with the hook exiting 0 on an ALLOW after the signal (the grant spent on an abandoned call); restored. tests/harness-wait-interrupt.test.ts 30/30 exit 0 on Node 26.8.2; with hermes-wait-interrupt 38/38 exit 0 on Node 24 (homebrew node@24). Related hook files (cli-hook*, hermes-*, serve-hook, agent-sdk-hook, harness-*, hook-module-graph, command-class-harness-launch) 530/530 exit 0. typecheck exit 0, lint exit 0. Full suite under the CLAIMS lock 03:02Z-03:13Z: node scripts/run-tests.mjs --baseline exit 0, 5640 tests, 5639 pass, 1 skip, 0 fail; ci-baseline 0 failing.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Every CLI harness hook (claude-code, cursor, codex, grok, muse, as hermes already did) now drives its wait through the yielding driver: a SIGTERM or SIGINT mid-wait withdraws the question this invocation opened, prints that harness's ordinary deny under hook-interrupted at its own deny exit code (exit 2 if the write fails), and a later grant is refused request-withdrawn; a grant that landed first stays unspent. The pause before every spend is the one shared yield in the gate chain. Verified by tests/harness-wait-interrupt.test.ts (30 tests, fails on the old driver), Node 24 and 26 runs, full suite exit 0 (5639 pass). Docs per harness, CHANGELOG, SPEC §10.1 hunk recorded in notes pending sign-off; APRV-477 filed for the pre-wait stretch.
<!-- SECTION:FINAL_SUMMARY:END -->
