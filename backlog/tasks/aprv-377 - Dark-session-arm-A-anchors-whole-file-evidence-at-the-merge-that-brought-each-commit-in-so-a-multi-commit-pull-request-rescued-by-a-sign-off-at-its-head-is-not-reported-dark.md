---
id: APRV-377
title: >-
  Dark-session arm A anchors whole-file evidence at the merge that brought each
  commit in, so a multi-commit pull request rescued by a sign-off at its head is
  not reported dark
status: To Do
assignee: []
created_date: '2026-09-19 13:19'
updated_date: '2026-09-19 13:19'
labels:
  - doctor
  - guard
  - bug
dependencies:
  - APRV-374
priority: medium
ordinal: 292000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Residual of APRV-369 and APRV-374, split out of APRV-374 on the orchestrator ruling (2026-09-19) because it needs a different git traversal from the one APRV-374 implements and it changes non-merge commits too.

THE GAP. A MULTI-COMMIT pull request whose earlier commits were rescued by a sign-off at its head merges into main as several commits, and arm A credits none of them, because no in-window commit blob equals the ratified bytes. CI passed that pull request; the sweep reports it dark. It is a false alarm in a health report and never a hole in the gate, and it is the same shape of disagreement APRV-369 and APRV-375 removed. Arm A anchors whole-file evidence (a sign-off, APRV-338; an organ attestation, APRV-272; the policy attestation) at the COMMIT, because arm A has no range, while the CI guard anchors it at the range head (src/core/commit-guard.ts, digestsAt).

THE GIT QUESTION, in the orchestrator words. For each commit off the first-parent path, the merge that brought it in is the first-parent commit whose second parent reaches it, and that merge second parent is the commit range head for whole-file evidence. Arm A already asks git for the first-parent spine (commitsOf, APRV-369), so the extra call is one rev-list per failing commit rather than a new traversal. A commit that reached the checkout with no such merge (a fast-forward) keeps the commit own anchor, which is what it has today.

GRANTS ARE UNCHANGED and stay per commit: a grant binds one edit, and widening what a grant covers is not what this task is about. Only the whole-file anchors move, and only for a commit that failed on its own.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 For a failing commit that is not on the checkout first-parent path, arm A finds the merge that brought it in (the first-parent commit whose second parent reaches it) and matches whole-file evidence against the digests at that merge second parent, not at the commit
- [ ] #2 A multi-commit pull request whose first commit has no grant and whose head carries a sign-off passes arm A, pinned by a real-git fixture built through the real append path, and the same fixture without the sign-off still fails dark
- [ ] #3 A commit with no such merge (a fast-forward, or a commit on the first-parent path) keeps the commit own anchor and nothing about its verdict changes
- [ ] #4 Grants stay per commit; the header of src/core/dark-session.ts and docs/git-evidence.md say which anchor moved and which did not
- [ ] #5 build, typecheck, lint, dark-session and doctor suites pass
<!-- AC:END -->
