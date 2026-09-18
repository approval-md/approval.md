---
id: APRV-369
title: >-
  doctor dark-sessions disagrees with the CI guard that passed the same SPEC
  edit, and attributes a synced lane commit to the primary
status: To Do
assignee: []
created_date: '2026-09-18 02:09'
labels:
  - doctor
  - guard
  - bug
dependencies: []
priority: medium
ordinal: 286000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-18 02:08Z in the primary, daemon up, right after approval log sync brought main level: dark-sessions FAIL, primary [no-evidence], SPEC.md 1 line(s) trace to no authorized material, 25 evidence records covered part of it. The commit is ea7427a (fix: a harness launch resolves only under an explicit rule, APRV-354, PR 432), a one-line SPEC.md edit made in a lane worktree and merged 2026-09-17T10:00Z; the protected paths (grant cross-check) job on PR 432 PASSED. Two things to settle. First, the disagreement: the doctor row and the CI guard replay the same records against the same bytes and reach different verdicts, so one of them is wrong about coverage (the guard is the enforcement path, the doctor row is the health view; a health view stricter than enforcement is noise, one looser is a hole). Compare the two code paths (src/core/protected-path-guard.ts versus the dark-sessions replay in src/cli/doctor.ts) on ea7427a and make them one function or document the intended difference. Second, the attribution: the primary made no edit; the commit arrived by fast-forward. The row should attribute a change to the checkout that authored it (commit author and the lane branch it came from) or say it cannot, rather than naming the checkout that synced it. Related: APRV-357 (guard replay budget), APRV-192 (the detector).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 On ea7427a the doctor row and the CI guard give the same verdict, with a test pinning the shared replay on that fixture
- [ ] #2 A commit that reached a checkout by fast-forward is not attributed to that checkout as its own dark activity
- [ ] #3 The row detail names the commit hash it judged
<!-- AC:END -->
