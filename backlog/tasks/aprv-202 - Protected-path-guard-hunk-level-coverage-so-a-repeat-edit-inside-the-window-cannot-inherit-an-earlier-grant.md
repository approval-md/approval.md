---
id: APRV-202
title: >-
  Protected-path guard: hunk-level coverage, so a repeat edit inside the window
  cannot inherit an earlier grant
status: To Do
assignee: []
created_date: '2026-09-01 22:04'
labels:
  - security
  - ci
  - gate
dependencies:
  - APRV-151
priority: high
ordinal: 166000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-151 shipped the CI guard with a stated weakest joint: evidence is path-level plus a 7-day recency bound either side of the change commit, so a second edit to the same protected path inside the window inherits the first edit's grant. Observed on 2026-09-01 on the very PR that introduced the guard job (PR #187): its CI workflow and spec edits, granted at seq 7282 that afternoon, were passed by the guard on the strength of seq 2787 (2026-08-30, a different ci.yml edit in another worktree) and seq 4576 (2026-09-01 01:57, a different spec edit), because both sat within 7 days. The verdict was correct and the reason was wrong, and a grantless edit to either path this week would have passed the same way. Fix: trace every added or removed hunk of a protected path in base..head to the bound material of some grant (the after/content bytes of a file-tool grant, or the bytes a granted command wrote, where the payload store carries them), and pass a path only when its hunks are covered; keep attested (content-level) as is; keep the path-level match as diagnosis, never as a verdict. Interaction with the ordering rule (the log advance carrying the grant must merge before or with the PR) is unchanged.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A protected path passes only when every hunk in base..head is covered by the bound material of a grant in the committed log; a repeat edit inside the window with no grant of its own fails no-evidence, pinned by a test built through the real append path
- [ ] #2 Attested verdict unchanged; path-level matches appear in failure diagnosis only
- [ ] #3 Replayed against the real committed log, PR #187's changes pass only via seq 7282 (the granted script run) and fail if that grant is removed from the window
- [ ] #4 npm test passes; lint clean
<!-- AC:END -->
