---
id: APRV-182
title: >-
  CLAUDE.md amendment: agent-authored gated edits replace hand-applied drafts,
  and PR-open always arms the merge
status: In Progress
assignee:
  - 'agent:fable'
created_date: '2026-08-31 23:24'
updated_date: '2026-08-31 23:58'
labels:
  - policy
  - process
dependencies: []
priority: medium
ordinal: 158000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
2026-08-31, from the human: 'for claude.md i'd prefer it to be edited by you and i sign off by telegram'. Two convention changes to CLAUDE.md, drafted for the human to approve via the gate rather than paste by hand (this task is the last hand-off-shaped one).

(1) Replace the convention that agents draft CLAUDE.md amendments for the human to apply by hand (dogfood-cutover 'Drafts for the human's hands', APRV-160 precedent). New convention: agents edit CLAUDE.md directly; the edit classifies policy.edit through the Claude Code hook, and the human's Telegram tap IS the sign-off. No APPROVAL.md change is needed: tap-before-apply is what manual already does. Note the vocabulary trap that prompted this task: 'supervised' means proceed-now-sample-later, which is NOT what the human asked for. If tap volume grows, the already-built supervised-live mode (APRV-127) with a live_rate on policy.edit is the pressure valve, and is the human's amendment to make.

(2) Add to the workflow section: after opening a PR, the session runs 'gh pr merge <n> --merge' itself, so the vcs.push.main prompt reaches the human on the phone and the merge queue is armed on their tap. Context: PRs were sitting at CLEAN with autoMergeRequest null until the human clicked merge in the GitHub UI, because sessions stopped at PR-open (observed on PR #162, 2026-08-31).

The batched APRV-160 amendment (stacked-PR rule) is still pending hand-application; whoever picks this up should check whether it has landed and, if not, propose batching all three in one gated edit.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Exact CLAUDE.md wording for both changes drafted in this task before any edit
- [ ] #2 CLAUDE.md edited through the gate: hook prompt fired, human tap recorded in the log, seq noted in implementation notes
- [ ] #3 Hand-application convention references (dogfood-cutover drafts section pointer, if any remain in CLAUDE.md prose) reconciled so the two documents do not disagree
- [ ] #4 APRV-160 pending amendment checked and either confirmed landed or batched into the same gated edit
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Confirm APRV-160 amendment not yet applied (checked: still To Do, no stack language in CLAUDE.md) and batch its wording here per AC 4.
2. Draft exact wording for three CLAUDE.md changes in task notes (AC 1): gated-edit convention in Dogfooding, arm-the-merge rule in Workflow, stacked-PR rule amending the one-task-one-unit bullet.
3. Edit CLAUDE.md in the session worktree on demo-polish-records; the Edit classifies policy.edit via the hook and the human's Telegram tap is the sign-off (AC 2). On hook-timeout, retry the identical edit after the tap (APRV-117 carryover). A silent apply with no prompt is an APRV-151 incident: revert and escalate.
4. Commit, push the branch, open the PR listing contents, and arm the merge per the very rule being added.
5. Reconcile docs/dogfood-cutover.md 'Drafts for the human's hands' pointer (AC 3).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Drafted wording (AC 1). Three changes to CLAUDE.md:

A. Workflow bullet 2 gains the APRV-160 stack rule. New text: 'One task = one context window = one reviewable unit. If a task won't fit, split it in Backlog.md first. Related tasks in one milestone may land as a single PR with one commit per task (APRV-160): authoring and review stay per-task, the merge unit is the stack, the PR description lists the task IDs, and records/log commits keep their separate path.'

B. New workflow item 7: 'A PR is not shipped until the merge is armed. After opening or updating a PR, the session itself runs gh pr merge <n> --merge. The hook classifies it vcs.push.main, the prompt reaches the human's phone, and the tap queues the merge. A PR sitting at CLEAN waiting for a hand click in the GitHub UI is the failure mode this rule removes (APRV-182).'

C. Dogfooding MUST NOT bullet gains: 'CLAUDE.md is different since APRV-182: agents edit it directly, the edit classifies policy.edit through the hook, and the human's tap is the sign-off; hand-applied drafts are retired.'
<!-- SECTION:NOTES:END -->
