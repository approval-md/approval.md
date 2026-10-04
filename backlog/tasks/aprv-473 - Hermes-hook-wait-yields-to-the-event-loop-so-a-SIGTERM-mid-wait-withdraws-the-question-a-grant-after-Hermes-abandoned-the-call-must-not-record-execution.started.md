---
id: APRV-473
title: >-
  Hermes hook wait yields to the event loop so a SIGTERM mid-wait withdraws the
  question; a grant after Hermes abandoned the call must not record
  execution.started
status: To Do
assignee: []
created_date: '2026-10-04 23:18'
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
- [ ] #1 SIGTERM during the wait withdraws the request and answers the block directive within one event-loop turn; a later grant cannot start it; tests on the CLI path and the serve hook route
- [ ] #2 No execution.started is ever appended after the hook was interrupted; a test grants during the window and asserts the log
- [ ] #3 docs/hermes-hook.md states the withdraw-on-interrupt rule and the Node-version note; the hosted image's and checkpoint's Node versions are recorded in the notes
<!-- AC:END -->
