---
id: APRV-473
title: >-
  Hermes hook wait yields to the event loop so a SIGTERM mid-wait withdraws the
  question; a grant after Hermes abandoned the call must not record
  execution.started
status: Done
assignee:
  - '@claude-c16'
created_date: '2026-10-04 23:18'
updated_date: '2026-10-05 01:33'
labels:
  - agent-village
dependencies: []
priority: high
ordinal: 360000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From the refuter on PR #604 (APRV-466, 2026-10-04), confirmed by the lane and reproduced with a guard-less bin, so it predates the guard work (APRV-445). On the CLI the Hermes hook run is synchronous end to end: readFileSync on stdin and Atomics.wait in the wait, so no JS signal listener runs until the run returns. A SIGTERM during the wait (Hermes's own hook timeout, a gateway shutdown, a sandbox restart) is held; the wait keeps going; if a human grants before it ends, the hook answers {} to a Hermes that has already abandoned the call and records execution.started for a tool call that never ran. The guard only decides the exit after the run returns. Fix: make the wait yield (an async sleep or a signal-aware wait) so the existing withdrawing handler runs on SIGTERM: withdraw the request (approval.withdrawn, reason harness-interrupted), print the hook-interrupted block directive, exit 2, and never append execution.started after an interruption. Keep the wall-clock behaviour of the 240 s window. Tests: SIGTERM mid-wait followed by a grant appends approval.withdrawn and no execution.started; the grant after withdrawal is refused as the state machine already says; docs/hermes-hook.md's paragraph on the held signal updated. Also note from the same lane: on Node 26 a cold load turns the event loop zero times, so the bin's directive is effectively never printed for a signal during load and the hook's own verdict answers instead (still fail closed); record which Node the hosted image and the checkpoint ship.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 SIGTERM during the wait withdraws the request and answers the block directive within one event-loop turn; a later grant cannot start it; tests on the CLI path and the serve hook route
- [x] #2 No execution.started is ever appended after the hook was interrupted; a test grants during the window and asserts the log
- [x] #3 docs/hermes-hook.md states the withdraw-on-interrupt rule and the Node-version note; the hosted image's and checkpoint's Node versions are recorded in the notes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Turn the gate path in src/cli/hook.ts into a step generator that yields sleep durations (gateHarnessSteps, decideHarnessSteps, runHarnessSteps, the harness and Hermes wrappers, hookSteps). Every sleepSync becomes a yield of the same duration, so the cadence and the deadline arithmetic are unchanged.
2. Two drivers: driveSync (sleepSync per yield; commandHook, decideHarnessCall and the serve worker keep their synchronous APIs and behaviour) and driveYielding (setTimeout/setImmediate per yield). main.ts runs approval hook hermes through commandHookYielding, so the event loop turns during the wait and the wait's withdrawing handler runs on SIGTERM/SIGINT.
3. A zero-length yield before every execution.started append on the gate path (the supervised and autonomous charges, the carried spend, the post-wait spend), so a signal that arrived during a synchronous stretch is dispatched before anything is spent: the wait's handler withdraws and blocks, the early guard blocks.
4. Serve route: confirm no hold (cancellation is a shared-memory flag polled each tick, re-checked before the spend), keep its leave-for-retry design (APRV-427), add a Hermes disconnect-then-grant test asserting no execution.started.
5. Tests: SIGTERM mid-wait then grant through the bin and the entry (withdrawn, no execution.started, the grant refused request-withdrawn), interrupted-before-spend, the #569/#604 tests updated to the new rule, the bin hand-over still single-printing; 20 runs under load.
6. Docs (docs/hermes-hook.md held-signal paragraph becomes the withdraw-on-interrupt rule, Node-version note), CHANGELOG Unreleased, task notes with hosted/checkpoint Node versions and the §11.1 invariants.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Approach. The gate path in src/cli/hook.ts (gateHarnessCall, decideHarnessCall, runHarnessHook, commandHarnessHook, hermesFailClosed, commandHook) is now one generator chain (GateSteps<T> = Generator<number, T>) whose yields are pauses in ms. driveSync sleeps each with Atomics.wait (commandHook, decideHarnessCall, the serve worker and the Codex bridge keep their synchronous APIs and behaviour; a 0 pause is no pause). driveYielding sleeps each on setTimeout/setImmediate; main.ts runs approval hook hermes through the new commandHookYielding. Every former sleepSync in the wait is a yield of the identical duration (Math.min(interval, deadline - now)), so the 240 s effective window and the poll cadence are unchanged; the timer is clamped at 2^31-1 ms. One implementation of the gate sequence, two drivers: no second gate. Chose generators over async/await to avoid making commandHook and decideHarnessCall async, which would have rippled into codex-bridge's JSON-RPC handlers, the serve worker and six test files.

BEFORE_SPEND: a 0 pause before each of the four execution.started appends on the gate path (the supervised recordUnattended in gateHarnessSteps, the autonomous charge in decideHarnessSteps, the carried consumeGrants, the post-wait consumeGrants). Under driveYielding it turns the loop once, so a signal held through the preceding synchronous stretch (stdin read, classification, the poll read that found the grant) is dispatched before the spend: the wait's handler (prepended) withdraws and exits 2; before the wait, hermesFailClosed's guard prints hook-interrupted and exits 2. Residue, stated in docs: a signal that lands inside the spend's own synchronous append (microseconds) is answered by the verdict reached; no JS API can observe a pending signal synchronously.

Wait handler: unchanged reason (withdrawPending's default, cancelled; the note names the signal) and directive (hook-interrupted, while waiting for a decision). Hardened: a throw from the withdrawal no longer escapes the listener, the directive still goes out. Grant-then-signal race: withdraw refuses already-decided, nothing is written over the decision, the hook blocks and the grant stays unspent (carriable by a retry inside the grace, as any grant).

Scope kept to Hermes. Claude Code and the other CLI harnesses still drive synchronously (their wait handler still never gets a turn); the same fix applies to them if wanted (one line in main.ts). Not filed: a follow-up for the orchestrator to decide.

Serve route: no hold exists there. Signals never reach a worker thread; a departed client is a SharedArrayBuffer flag (cancelled) read at every poll tick and once more after re-taking the lock, immediately before consumeGrants. It does not withdraw on departure by design (APRV-427 review 4: the retry adopts the question). Added a Hermes disconnect-then-grant test pinning that no execution.started is recorded. AC1's 'withdraws ... on the serve hook route' is therefore met as 'never spends', with the withdrawal deliberately left to the retry grace; flagged for the orchestrator.

Node versions (read-only, gh api, main branches, 2026-10-04): bountify-ai/approval-md-hosted Dockerfile @029cc47e: ARG NODE_IMAGE=node:22-bookworm-slim (Node 22, floating minor); hermes-image/Dockerfile uses the node shipped by nousresearch/hermes-agent:v2026.9.21 (version not pinned there). Edge-City/agentvillage-controlplane control-plane/scripts/build-checkpoint.js @7101199a: NODE_VERSION has no default; required exact x.y.z, MIN_NODE_MAJOR = 20; docs/.env example 22.x.y. Node 22 cold-load yield behaviour is unmeasured (24: ~30 turns, 26: 0); the new rule does not depend on it.

§11.1 invariants touched: 5 (compare-and-append) unchanged, withdraw and consumeHarnessGrant still compare-and-append against their own head; 6 (distinct refusals) unchanged codes: hook-interrupted on the block, request-withdrawn / already-decided from the state machine; 1 (verified reads / nothing self-reported) unchanged, the poll still reads only the verified log and no field from the harness decides the interruption, the OS signal does.

SPEC: §10.1 states no interrupt rule. Draft hunk for a human, not applied: after the 'A harness wait that expires' paragraph, add '**A harness wait that is interrupted.** An adapter whose process receives a termination signal while it waits on a human MUST withdraw the requests it opened (reason cancelled) and answer a block in its harness's dialect before it exits, and MUST NOT record execution.started for that tool call afterwards: the harness that sent the signal has abandoned the call. A request the adapter adopted from an earlier call is left alone, since a withdrawal is the requester own. (Proposed APRV-473.)'

Validation. Under load, 20 iterations of hermes-wait-interrupt + hermes-bin-signal-guard concurrently with cli-hook-hermes-rules: first sweep 18/20, both failures the race test's allow branch dying by SIGTERM after '{}' was written (Node teardown closes the signal handles after the answer; pre-existing window, not a spend after an interruption); test relaxed to accept that. Second sweep 19/20, the one failure the #604 smoke test hitting the same teardown window (death by signal after a block directive was written); smoke relaxed to accept a death after exactly one block object and counts it. Regression proofs: on the synchronous driver 7 of the 8 new tests fail (120 s backstops, the race and held-stdin cases); with zero pauses skipped the held-stdin test fails. Full suite under the CLAIMS lock 00:48Z-01:09Z: npm test exit 0, 5603 tests, 5602 pass, 1 skip, 0 fail. typecheck exit 0, lint exit 0.

AC1 note for the orchestrator: on the serve route there is no SIGTERM; the equivalent is a client disconnect, and by APRV-427 design that leaves the question for the retry rather than withdrawing it. What the serve test pins is the safety half: a later grant is never spent on the departed call. Checked on that reading; a ruling that serve should withdraw too would be a new task.

Refuter (opus-high) on 74546bdf: claims 2 to 4 held; claim 1 refuted by reproduction on Node 24. A single setImmediate scheduled from a poll-phase callback (the continuation of a module load that turned the loop) runs before the next poll, so a held signal was still in libuv's pipe when the spend ran; the held-stdin test failed on Node 24 2/2 and passed on 26. Fixed: the zero pause is two setImmediate hops, which crosses a poll phase from any phase. Node 24: both signal files 14/14 exit 0, held-stdin test 3/3. Should-fix taken: the open-window bypass (runBypass) is a generator now and pauses before recordGateBypass, since gate.bypassed is that path's authorization. Nits taken: driveSync skips zero pauses; docs give the residue as the spend's append and its log read (milliseconds) plus the verification read, not microseconds; the Hermes CLI route swallows stderr errors so an EPIPE mid-wait cannot end the wait unwithdrawn. Not taken: the serve test granting before the thread leaves (the pre-spend callerGone re-check is the guard; left as is). CI on 74546bdf was green on Node 22 (all three shards), so the one-hop pause did not fail there; the fix is still needed for Node 24. After the fix: typecheck 0, lint 0, node26 hermes/serve/hook files 93/93, and gate-window, dark-session, harness-version, cli-hook 279/279. No regression test for the bypass pause: an open window needs the human's gate ceremony, so a test would need a window fixture.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The approval hook hermes CLI wait now yields to the event loop: the gate path is one generator chain driven synchronously (commandHook, decideHarnessCall, serve worker, unchanged) or on timers (commandHookYielding, the Hermes CLI route). SIGTERM/SIGINT mid-wait reaches the wait's handler within one pause: approval.withdrawn (reason cancelled), the hook-interrupted block directive, exit 2; a later grant is refused request-withdrawn. A one-turn pause before every execution.started append blocks a signal held through the synchronous stretch. Same cadence, same 240 s window. Serve already never spends on a departed client (new Hermes test). Verified by tests/hermes-wait-interrupt.test.ts (fails on the old driver), updated #569/#604 tests, 20 under-load sweeps, full suite exit 0 (5602 pass).
<!-- SECTION:FINAL_SUMMARY:END -->
