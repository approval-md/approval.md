---
id: APRV-374
title: >-
  Dark-session arm A judges an evil merge: a merge commit whose result differs
  from every parent on a guarded path is replayed, not dropped
status: To Do
assignee: []
created_date: '2026-09-19 09:46'
labels:
  - doctor
  - guard
  - bug
dependencies: []
priority: medium
ordinal: 289000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Residual of APRV-369 (PR 450). Arm A of src/core/dark-session.ts now replays one commit at a time, parent to commit, which is the unit the CI guard judges and a grant binds. commitsOf lists a commit changed paths with git log --name-only, and git shows no paths for a merge commit under that form, so every merge commit drops out of the replay with the comment that it should not be judged for what its parents did. That is right for a clean merge. It is wrong for a merge whose result differs from every parent on a guarded path: a conflict resolution or a hand edit made while resolving, the classic evil merge. Such an edit is the merge commit own work, it happened in the checkout that made the merge, and today neither arm A nor the CI guard (which replays a pull request range, never the merge-queue commit on main) looks at it. Before PR 450 the union span happened to include those bytes by accident. Decide the base for judging a merge commit (dense-combined, git log --cc --name-only, lists exactly the paths whose result differs from all parents; the replay then needs a before-state, and the first parent is the checkout own history) and make arm A replay those paths for merge commits with the same exactness rule as any other commit. Related: APRV-369, APRV-357 (unit of judgment ruling), APRV-192.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A merge commit whose SPEC.md result differs from both parents is listed with that path by commitsOf (git log --cc --name-only or equivalent), and a clean merge still lists no paths, each pinned by a real-git fixture built through the real append path
- [ ] #2 Arm A replays such a commit against a documented base (first parent by default) with the same exact-replay rule, and an unevidenced evil merge fails dark under its own code or the existing no-evidence code with the merge sha named
- [ ] #3 Header of src/core/dark-session.ts and docs/git-evidence.md say what unit a merge commit is judged on and why
- [ ] #4 build, typecheck, lint, dark-session and doctor suites pass
<!-- AC:END -->
