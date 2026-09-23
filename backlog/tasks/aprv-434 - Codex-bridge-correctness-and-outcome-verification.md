---
id: APRV-434
title: Codex bridge correctness and outcome verification
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-22 06:44'
updated_date: '2026-09-23 00:25'
labels: []
dependencies: []
priority: high
type: bug
ordinal: 332000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the approved bridge correctness work. Preserve primary gate custody and distinguish native observations from fixture tests.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Failed turns and unexpected child exits return nonzero without fabricated success.
- [ ] #2 Native outcomes close only authorized calls with verified thread, turn and item correlation; unknown outcomes stay explicit.
- [ ] #3 Tests cover stale and duplicate frames, refusal, malformed input and crashes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Capture named-version command and file completion contracts without treating fixture output as native proof. 2. Repair failed-turn and child-exit reporting. 3. Bind thread, turn and item identities and close only verified authorized executions through existing gate outcome paths. 4. Add focused regressions and run required validation; parent reviews and delivers.

Resume refinement: the shared decision helper blocks synchronously while waiting. Move bridge decisions into a dedicated worker that calls the existing gate helper, add cooperative cancellation and wakeable wait to withdraw only its own pending requests, and await safe completion rather than terminate a worker during an append lock. Suspend protocol-silence deadlines during the human wait, fence late replies by live thread/turn/request identity, and independently test crash/interruption during manual waits. No duplicate gate or new reporter vocabulary.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-09-22 live probe preparation: user authorized one bounded primary-gate request for synthetic Codex app-server capture. Action aprv434-native-probe-20260922:run remains pending; no harness launched. Telegram startup was verified to skip the channel because its token/chat launch configuration was missing; human setup is in progress. Stub tests are not native completion evidence.

Pause checkpoint 2026-09-22: user requested stop at next natural point and handover. Primary gate query confirms aprv434-native-probe-20260922:run is granted, but no probe was launched before pause. Raw execution token is intentionally omitted from artifacts. Telegram delivered the request after human setup, but its decision tap was refused sender-key-unavailable; terminal decision subsequently granted it. Resume only on user instruction, recheck expiry and exact scratch payload/script hashes before approved execution.

Resumed on explicit user instruction. Baseline origin/main remains c88a6be; primary checkout preserved. Original unused probe token expired; identical scratch scripts and canonical payload were verified and a renewed bounded action aprv434-native-probe-20260922-renewed:run was requested at seq72890. Awaiting human decision; no native probe has run.

Continuation checkpoint: owned decision worker and cooperative cancellation implemented; focused bridge 65/65, shared hook 148/148, conformance 481 vectors/182 controls passed. Full CI was blocked by shared SQLite ABI mismatch; own Node24 pinned dependencies now installed. Independent Astra review found blocking file-item snapshot invalidation during approval, lifecycle timer rearming during human wait, and missing-thread completion acceptance. Fixes and explicit race regressions are in progress under gpt-6-sol. Native capture remains unrun: renewed primary request aprv434-native-probe-20260922-renewed:run is pending; accepted execution outcomes remain unknown.
<!-- SECTION:NOTES:END -->
