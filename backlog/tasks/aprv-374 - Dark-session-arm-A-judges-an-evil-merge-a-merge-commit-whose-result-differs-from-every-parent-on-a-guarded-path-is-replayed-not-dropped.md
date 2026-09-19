---
id: APRV-374
title: >-
  Dark-session arm A judges an evil merge: a merge commit whose result differs
  from every parent on a guarded path is replayed, not dropped
status: To Do
assignee: []
created_date: '2026-09-19 09:46'
updated_date: '2026-09-19 10:43'
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Residual from APRV-375 (PR #455), recorded here at the orchestrator request on 2026-09-19.

PR #455 made the CI guard judge a pull request one commit at a time and, in its second commit, anchored WHOLE-FILE evidence (gate.path.signed_off, gate.organ.attested, the policy attestation) at the RANGE HEAD while grants stay per commit. Arm A of the dark-session sweep kept the per-commit anchor, because it has no range: it judges commits that are already merged, each of which passed its own pull request and was ratified, if at all, at that pull request head.

The gap that leaves: a MULTI-COMMIT pull request whose earlier commits were rescued by a sign-off at its head merges into main as several commits, and arm A credits none of them, because no in-window commit blob equals the ratified bytes. CI passed that pull request; the sweep would report it dark. It is a false alarm in a health report and never a hole in the gate, and it is the same shape of disagreement APRV-369 removed.

The fix belongs with this task because it needs the same git question: ask which merge on the checkout first-parent spine brought each commit in, and use THAT merge second parent (the pull request head) as the commit range head for whole-file evidence. Arm A already asks git for the first-parent spine (commitsOf, APRV-369), so the extra call is one rev-list per failing commit rather than a new traversal.
<!-- SECTION:NOTES:END -->
