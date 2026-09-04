---
id: APRV-252
title: Make Codex planning and handoff visibly follow repository workflow
status: In Progress
assignee:
  - '@codex'
created_date: '2026-09-04 21:58'
updated_date: '2026-09-04 22:59'
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
- [x] #1 Codex checkpoint requires instruction, SPEC, Backlog and concurrent ownership inspection before substantive planning.
- [x] #2 Feature plans identify tasks, acceptance criteria, dependencies, ownership, validation and related-task PR batching; Plan Mode distinguishes proposed records from created records.
- [x] #3 Handoff checks instruction compliance and actual delivery; existing policy, Cursor guidance and other sessions changes remain intact.
- [x] #4 Scenario review covers feature work, backlog-only delivery, Plan Mode and concurrent Claude work; memory note points to repo instructions without volatile state.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Inspect current instructions, completed APRV-160 and APRV-250, active worktrees and conflicts. 2. Draft a narrow Codex checkpoint addition against refreshed main. 3. Route exact protected-file edit through the primary approval hook before applying. 4. Review scenarios and run required checks. 5. Record evidence through Backlog, commit on isolated branch, push one workflow PR and arm and verify merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
APRV-250 verified merged in GitHub PR #252 at 2026-09-04T21:48:25Z. Isolated branch based on 3445577; primary and Claude worktrees untouched. Exact AGENTS edit submitted via primary hook as hook:codex-aprv252:aprv252-checkpoint:policy.edit; timed out awaiting decision, request remains open and edit has not been applied. User-authorized memory note written at /Users/carter/.codex/memories/extensions/ad_hoc/notes/2026-09-04T220200Z-approval-md-workflow-checkpoint.md. No volatile task state copied into memory.

Checkpoint: workflow worktree /private/tmp/approval-workflow-checkpoint, branch codex/workflow-checkpoint, scaffold commit 5bffe37. AGENTS insertion remains unapplied because exact hook request codex-aprv252/aprv252-checkpoint is pending. User reports Telegram queue text with no buttons; read-only source review confirms queue is summary-only and skip forgets cached delivery, then next poll re-sends a card (gloss may add 20s). No service restart or other session changes. Host npm test session 60884 remains running with test runner PID76004 and remaining child PID29196 in daemon-advance-adopt.test.js; likely missing failure cleanup after a timing assertion, not a passing result. Earlier observed cli-setup Telegram timing failure matches APRV-248. Next: recover visible card and verified gate grant, apply exact reviewed edit, resolve own test diagnostics, then deliver PR. Feature worktree /private/tmp/approval-codex-gloss has reviewed local commits b030cc2 (APRV-253) and 439c05a (APRV-254), with APRV-255 helper and task notes uncommitted. Focused runner tests 5/5, lint/typecheck exit 0. Shared CLI/docs integration awaits overlapping Claude delivery; live smoke awaits gate. No PR opened and nothing claimed merged.

Update after user recovered Telegram cards: exact PreToolUse retry returned allow/granted carryover for codex-aprv252/aprv252-checkpoint. Applied only the reviewed insertion to /private/tmp/approval-workflow-checkpoint/AGENTS.md. PostToolUse first encountered a head-moved refusal with nothing appended; identical retry reported completed and appended one outcome. Primary AGENTS and other sessions remain untouched. APRV-256 now separately tracks the misleading Telegram /queue wording as user-requested future work, To Do; no wording implementation was added to this task.

Parent review and independent Sol scenario review passed: additive 12-line checkpoint preserves all current origin/main policy, Cursor routing, delivery and dogfood rules. Feature, backlog-only, Plan Mode and concurrent Claude scenarios all require observable actions, and the stable memory pointer explicitly cannot guarantee compliance. Demonstrated current reads, isolated worktrees, per-task A/B commits, disjoint delegation, deferred overlapping edits and exact gate receipt. Build, lint, typecheck and diff check exit 0. Bounded isolated daemon-advance-adopt retry passed 7/7, exit 0 with normal cleanup. Isolated APRV-248 setup Telegram timing case still fails its more-than-one-poll assertion (192ms startup versus fixed message delay), exit 1; no unrelated source fix was made. Full-suite baseline limitation remains disclosed; no all-tests-pass claim.
<!-- SECTION:NOTES:END -->
