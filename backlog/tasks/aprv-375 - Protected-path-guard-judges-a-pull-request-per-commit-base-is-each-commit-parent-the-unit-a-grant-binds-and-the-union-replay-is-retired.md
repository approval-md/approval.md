---
id: APRV-375
title: >-
  Protected-path guard judges a pull request per commit: base is each commit
  parent, the unit a grant binds, and the union replay is retired
status: To Do
assignee: []
created_date: '2026-09-19 09:53'
labels:
  - guard
  - ci
  - spec
  - security
dependencies: []
priority: high
ordinal: 290000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter ruled option B on 2026-09-19 after the APRV-357 reproduction (PR 452): PR 427 SPEC.md diff was 671 of 798 lines because the lane merged origin/main into itself twice while four lanes were editing the file, so the guard was replaying what the branch absorbed, against before-states that no longer occur at the merge base. The doctor already replays per commit since APRV-369 (PR 450) and agrees with CI wherever CI can answer. Make the CI guard (scripts/protected-path-guard.mjs over src/core/protected-path-guard.ts) judge a pull request one commit at a time: for every non-merge commit in base..head, base is the commit parent, head is the commit, changedPaths are that commit guarded paths, timestamps are that commit own pair (APRV-339), and the commit passes or fails on its own records. Commits the branch absorbed by merging main are commits main already carries; they are excluded because they are reachable from base, which two-dot base..head does by construction. A merge commit on the branch is judged on the paths whose result differs from every parent (dense combined), against its first parent, or the task records why not (APRV-374 asks the same of the doctor). The PR verdict is the conjunction; the report lists each commit sha with its verdict and the records that covered it, in order. The security argument to write into the guard header and docs/git-evidence.md: every changed byte between base and head is in some commit of the range, so nothing goes unjudged; the guard stops asking about the combined diff because a grant binds one edit and the combined diff has no grant. The exact-replay byte budget stays as it is; per commit it is not reached in any case observed. Retires the union replay path once the per-commit path covers every fixture the old one did; APRV-357 closes as superseded when this lands, with a note. Related: APRV-357, APRV-369, APRV-374, APRV-338 (sign-off stays as the escape hatch), APRV-339, APRV-340, APRV-151, APRV-316.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 On the PR 427 fixture (base 6d1b2bbe1dde, head e66ba9e689a2, log at 42403) the guard passes SPEC.md by per-commit replay, naming each judged commit and its records, with no sign-off record present; the fixture is built through the real append path or replayed from the committed log
- [ ] #2 Exactness unchanged, each with a test: a commit missing its record fails uncovered-hunk naming that commit; a record whose after-state was later altered outside the log fails; a hunk that only appears in the combined diff and in no single commit cannot exist, and a test documents why (two-dot range covers every byte)
- [ ] #3 Absorbed commits (reachable from base after a merge of main into the branch) are not judged again, with a fixture that merges main into the branch and asserts those commits are neither listed nor failed
- [ ] #4 A merge commit on the branch whose result differs from every parent on a guarded path is judged against its first parent and fails when unevidenced; a clean merge is listed as skipped
- [ ] #5 The report and the doctor row name the same unit and the same verdict on the APRV-369 fixture; a shared helper builds the per-commit GuardInput for both, or the two are pinned equal by a test
- [ ] #6 Guard header, scripts/protected-path-guard.mjs header and docs/git-evidence.md state the unit of judgment and the security argument; SPEC section 11 or the guard section is amended in one commit if it describes the union replay, and the edit is called out
- [ ] #7 Runtime on the PR 427 fixture measured and recorded; build, typecheck, lint, guard, guard-script, dark-session and doctor suites pass
<!-- AC:END -->
