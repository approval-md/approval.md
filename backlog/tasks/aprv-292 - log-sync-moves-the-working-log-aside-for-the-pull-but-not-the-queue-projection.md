---
id: APRV-292
title: log sync moves the working log aside for the pull but not the queue projection
status: To Do
assignee: []
created_date: '2026-09-07 02:16'
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
