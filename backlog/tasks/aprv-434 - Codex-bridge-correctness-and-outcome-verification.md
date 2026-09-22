---
id: APRV-434
title: Codex bridge correctness and outcome verification
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-22 06:44'
updated_date: '2026-09-22 06:44'
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
<!-- SECTION:PLAN:END -->
