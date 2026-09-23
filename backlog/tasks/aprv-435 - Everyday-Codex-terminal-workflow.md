---
id: APRV-435
title: Everyday Codex terminal workflow
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-22 06:44'
updated_date: '2026-09-23 00:26'
labels: []
dependencies:
  - APRV-434
priority: high
type: feature
ordinal: 333000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the approved continuing terminal bridge using one owned app-server child and thread; desktop integration remains separately tracked.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Interactive mode runs sequential prompts after one preflight and shows agent responses and approval progress.
- [ ] #2 EOF, quit and interruption terminate honestly; one-shot mode stays compatible and interactive JSON is refused.
- [ ] #3 Onboarding and diagnostics distinguish configuration, observed operation and limited coverage; multi-turn regression tests pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Preserve one-shot mode and add explicit interactive TTY mode, refusing JSON. 2. Keep one owned app-server child and thread with one preflight and sequential turn starts. 3. Render agent output and approval progress; make EOF, quit and interruption honest. 4. Add multi-turn and lifecycle fixtures/tests, help and onboarding; validate and parent review.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Continuation checkpoint: terminal lifecycle/output/runbook implemented and focused-tested, including one thread across turns, signals, child failure and silence. Independent review reproduced initial idle-prompt timeout from the remaining preflight timer; correction and regression are in progress. Exact rejection-then-new-approval sequence regression is being added. Full integrated CI and native acceptance remain outstanding; task stays In Progress.
<!-- SECTION:NOTES:END -->
