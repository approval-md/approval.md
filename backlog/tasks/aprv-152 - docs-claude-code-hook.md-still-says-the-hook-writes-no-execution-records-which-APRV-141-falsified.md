---
id: APRV-152
title: >-
  docs/claude-code-hook.md still says the hook writes no execution records,
  which APRV-141 falsified
status: To Do
assignee: []
created_date: '2026-08-29 20:42'
labels:
  - docs
  - hook
dependencies: []
priority: low
ordinal: 137000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found 2026-08-29 during the APRV-145 design review: docs/claude-code-hook.md around lines 406-410 asserts the hook appends no execution.* records, but since APRV-141 the hook calls startHarnessExecution (src/cli/hook.ts ~line 1062) and appends execution.started with execution: harness for allowed gated commands, and since APRV-146 those records also bind payload_hash. Small documentation-only fix: correct the paragraph to describe the delegated execution.started record, its harness marker and binding, and the fact that it is terminal by design (no outcome is ever written over it by this runtime). Rides the light docs CI tier.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The paragraph describes the APRV-141 delegated start record accurately, including the harness marker, the payload_hash binding, and terminal-by-design custody
- [ ] #2 No other stale claims about hook-written records remain in the file (sweep it once)
<!-- AC:END -->
