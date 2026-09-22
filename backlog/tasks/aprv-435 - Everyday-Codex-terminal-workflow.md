---
id: APRV-435
title: Everyday Codex terminal workflow
status: To Do
assignee: []
created_date: '2026-09-22 06:44'
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
