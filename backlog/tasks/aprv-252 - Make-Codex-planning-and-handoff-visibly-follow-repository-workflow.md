---
id: APRV-252
title: Make Codex planning and handoff visibly follow repository workflow
status: In Progress
assignee:
  - '@codex'
created_date: '2026-09-04 21:58'
labels: []
dependencies: []
type: docs
ordinal: 194000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
This session treated Backlog decomposition and batched delivery as an afterthought despite explicit instructions. Add observable startup, planning, concurrency and handoff checkpoints without replacing existing policy or other harness guidance. References APRV-160 and merged APRV-250. User also authorizes a separate personal memory note pointing to authoritative repo guidance.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Codex checkpoint requires instruction, SPEC, Backlog and concurrent ownership inspection before substantive planning.
- [ ] #2 Feature plans identify tasks, acceptance criteria, dependencies, ownership, validation and related-task PR batching; Plan Mode distinguishes proposed records from created records.
- [ ] #3 Handoff checks instruction compliance and actual delivery; existing policy, Cursor guidance and other sessions changes remain intact.
- [ ] #4 Scenario review covers feature work, backlog-only delivery, Plan Mode and concurrent Claude work; memory note points to repo instructions without volatile state.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Inspect current instructions, completed APRV-160 and APRV-250, active worktrees and conflicts. 2. Draft a narrow Codex checkpoint addition against refreshed main. 3. Route exact protected-file edit through the primary approval hook before applying. 4. Review scenarios and run required checks. 5. Record evidence through Backlog, commit on isolated branch, push one workflow PR and arm and verify merge.
<!-- SECTION:PLAN:END -->
