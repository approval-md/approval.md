---
id: APRV-160
title: 'CLAUDE.md amendment: related task stacks may share one PR (human sign-off)'
status: Done
assignee: []
created_date: '2026-08-30 20:58'
updated_date: '2026-09-01 02:46'
labels:
  - workflow
dependencies: []
ordinal: 144000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Approved in principle by Carter 2026-08-30 while diagnosing landing latency (~17-19 min serial CI+queue per task even after APRV-149). Proposal: amend CLAUDE.md workflow rules so a stack of related tasks may land as ONE PR with per-task commits, keeping 'one task = one context window = one reviewable unit' for authoring and review while decoupling it from the merge unit. Constraints to encode: tasks in a stack must be same-milestone/same-feature and reviewed per commit; records/log commits keep their existing separate path; the stack's PR description lists the task IDs. Agents must not edit CLAUDE.md, so this task delivers the proposed diff text for Carter to apply by hand. First application (pre-blessed by Carter as a one-off regardless): the APRV-154..158 web-agent-demo stack.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Proposed CLAUDE.md diff text drafted and attached in task notes, scoped to the workflow section, following the repo prose style
- [x] #2 Carter has applied (or amended and applied) the CLAUDE.md change by hand, or explicitly declined it
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Proposed CLAUDE.md text, for Carter to apply by hand inside the Workflow section, directly after the 'One task = one context window = one reviewable unit' bullet:

**Task stacks may share one PR.** Related tasks in the same milestone or feature may land as a single pull request when each task remains its own commit (or contiguous run of commits) and its own reviewable unit. The PR description lists every task ID it carries, and review happens per commit. Records and log commits keep their existing separate paths. A task that turns out to be unrelated to its stack moves to its own PR rather than riding along. (Adopted 2026-08-30: with the merge queue at 10-14 minutes per candidate, one candidate per task was the dominant landing cost; one candidate per stack keeps the gate and drops the waste.)

Rationale and measurements are in APRV-159's description (queue candidates 11.7/14.5/14/10 min on 2026-08-29/30). First application: the APRV-154..158 web-agent-demo stack, pre-approved by Carter as a one-off on 2026-08-30.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Landed through APRV-182 instead of by hand: the stack-rule wording was drafted in APRV-182's notes, applied to CLAUDE.md under policy.edit grant seq 4179 (human:carter tap, the sign-off this task's AC 2 wanted), and merged via PR #159.
<!-- SECTION:FINAL_SUMMARY:END -->
