---
id: APRV-292
title: log sync moves the working log aside for the pull but not the queue projection
status: To Do
assignee: []
created_date: '2026-09-07 02:16'
updated_date: '2026-09-07 06:03'
labels:
  - daemon
  - log
dependencies: []
priority: medium
ordinal: 217000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
2026-09-07: after the records PR #309 merged (it carries .approval/QUEUE.md as well as the log), approval log sync refused twice with git's 'local changes to .approval/QUEUE.md would be overwritten' even right after git checkout -- .approval/QUEUE.md, because the running daemon rewrites the projection between the checkout and the fast-forward. The working log itself was handled (sync snapshots and restores it), so the refusal is purely the projection: a file that is rebuilt from the log on every sync and carries no truth of its own. Workaround used: stop the daemon, checkout QUEUE.md, sync, restart. APRV-215 says a dirty working log plus an upstream change is sync's job, always; the same has to hold for the projection sync itself rebuilds.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval log sync treats .approval/QUEUE.md (and the index projection when present) as disposable: it discards the working copy before the fast-forward and rebuilds it after, so an upstream records commit that touches the queue never refuses the sync
- [ ] #2 A test drives the real append path with an upstream commit that changes both the log and QUEUE.md, with a concurrent projection rewrite between snapshot and merge, and asserts the sync succeeds and the rebuilt queue matches the merged log
- [ ] #3 SPEC log sync paragraph names the projection rule; docs/dogfood-cutover.md and docs/cli-reference.md log sync sections updated; CHANGELOG entry
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Keep the working LOG path exactly as APRV-215 left it: snapshot, baseline to HEAD bytes, restore on every failure. Nothing in this task changes it.
2. Treat the projections as disposable. QUEUE.md keeps its snapshot (a refusal still leaves the tree as found) but leaves the baseline loop; the index is not snapshotted at all.
3. Discard immediately before the merge rather than at the baseline. The append lock covers appends, so the log cannot be dirtied mid-sync; writeQueue takes no lock, so the projection can be, and the baseline-to-merge window is where the records PR refused twice. Right before git merge --ff-only, each disposable projection that HEAD or FETCH_HEAD carries is set to its HEAD bytes (removed when only the incoming tree has it). A projection git does not carry (the gitignored index.sqlite) is left alone: it blocks no merge and it is a cache.
4. Bounded retry inside the merge step: when the merge fails and git status still reports a disposable path dirty, discard again and merge once more. A second failure refuses log-sync-git-failed as it does today.
5. Step names unchanged. LOG_SYNC_STEPS is public and the injected-failure table pins it, so the discard rides inside the merge step, after the failBefore check.
6. New test seam hooks.interfere: run this callback just before a named step, as a concurrent writer would. A parameter of the function, never a CLI flag, same discipline as failBefore.
7. Test: a peer appends two records through the real append path and rewrites QUEUE.md, and pushes both in one commit; interfere at merge rewrites QUEUE.md in the primary between the snapshot and the merge; assert the sync succeeds, adopts the longer chain, and the rebuilt QUEUE.md equals a fresh renderQueue over the merged log modulo the evaluated-at line.
8. Docs: the cli-reference log sync steps, the dogfood-cutover sync section, a CHANGELOG entry under 0.1.0. The SPEC amendment sentence goes into the implementation notes for the human to apply by hand.
<!-- SECTION:PLAN:END -->
