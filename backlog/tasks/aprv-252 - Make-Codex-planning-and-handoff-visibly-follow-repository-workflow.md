---
id: APRV-252
title: Make Codex planning and handoff visibly follow repository workflow
status: Done
assignee:
  - '@codex'
created_date: '2026-09-04 21:58'
updated_date: '2026-09-05 09:44'
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

Delivery checkpoint: /private/tmp/approval-workflow-checkpoint, codex/workflow-checkpoint; reviewed amendment and task evidence committed as 87c281b and pushed in PR https://github.com/approval-md/approval.md/pull/261. A subsequent local merge of main a27c812 remains unpushed. PR is OPEN, not merged. Protected-path CI requires the granted edit to reach committed main through the separate records path; hook:codex-aprv252:aprv252-records-advance:log.advance is awaiting its human gate decision. CI full shards 2 and 3 passed; shard 1 failed an upstream daemon-advance-finish append-race assertion. Isolated daemon-adopt diagnostic passed 7/7 exit 0; existing cli-setup timing diagnostic failed exit 1. Scenario review, build, lint, typecheck and diff checks passed. Next: after the exact records-advance grant, run the frozen primary-checkout command, complete its separate records PR, refresh this branch, push and re-arm PR 261, then verify checks and actual merge. No live service restart. Authorized personal memory note was written separately. The feature integrated suite subsequently passed 3187 tests with 1 skip on main a27c812; that is feature evidence, not a claim that this PR CI has passed.

2026-09-05 resumed delivery: primary hook confirmed the existing log.advance grant. Ran the exact approved command approval log advance --pr, exit 0, publishing records commit 67eba0a800c4 in separate PR https://github.com/approval-md/approval.md/pull/269. PostToolUse recorded completion successfully. Armed its merge with gh pr merge 269 --merge; GitHub checks and merge remain pending. No primary checkout, daemon or listener changes. Next: once GitHub confirms records merged, refresh this isolated branch, push updated task notes and baseline, and re-arm PR 261. Summarizer draft PR 262 CI is fully successful, but live smoke still rejects output and remains incomplete.

Records PR 269 passed its PR checks, then merge-group run 33938030791 failed the existing daemon-advance-finish test assertion that the concurrent record must land between read and append. The same candidate passed that shard on Node 20. GitHub removed the merge-queue entry; re-armed the records merge once after verifying this exact failure. No daemon source/test modifications and no gh run rerun performed. Workflow worktree HEAD 4010456 remains local ahead of PR 261; next step is still wait for records merge, refresh the baseline and push/re-arm the workflow PR. Feature runner correction 94f7e14 now has successful gated live evidence; shared docs coordination remains pending.

Final validation after integration: worktree /private/tmp/approval-workflow-checkpoint, branch codex/workflow-checkpoint. Current main contains records PR269, delivered Claude instruction updates, and the upstream timing-test fixes. The protected-path guard passes with granted-file evidence at seq17411; build, lint, typecheck and diff check exit0. Refreshed PR261 CI run33958151201 passed all required checks. Independent final review approves all four workflow scenarios and preservation of Cursor/Codex instructions. Actual three-dot PR diff contains only AGENTS.md and this task; newer unrelated main changes are excluded. The user-authorized stable memory note was written previously. Final task metadata is being committed before merge-queue completion; actual merge will be verified separately.

Delivery verified: PR261 merged at 2026-09-05T09:40:41Z, merge commit a8f8360. GitHub had locked the queued branch before the final Done metadata could be pushed. The granted dequeue attempt failed schema validation and made no change; the runtime recorded failure, and the PR was already merged, so no retry was needed. This final task record is carried separately on codex/completion-records in /private/tmp/approval-codex-completion; source delivery remains the original workflow PR. No policy, daemon, listener or concurrent session edits were added.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added the observable Codex startup, planning, delegation, per-task review and delivery checkpoint while preserving existing policies and concurrent edits. Demonstrated Backlog-first task work, isolated branches, ownership checks and exact protected-edit approval; four-scenario review, protected-path guard, build/lint/typecheck and refreshed full CI passed. Authorized memory note points future sessions to current repository instructions.
<!-- SECTION:FINAL_SUMMARY:END -->
