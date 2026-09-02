---
id: APRV-232
title: >-
  policy amend --commit: protection probe misses repository rulesets, so every
  ceremony first hits the GH013 wall before the branch flow
status: To Do
assignee: []
created_date: '2026-09-02 20:12'
labels:
  - cli
  - ceremony
dependencies: []
priority: medium
ordinal: 187000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Seen 2026-09-02 at the seq 13704 ceremony: approval policy amend --commit probed protection via gh api repos/{owner}/{repo}/branches/main/protection, got 404 (that endpoint describes classic branch protection only; this repository is governed by rulesets, which live under repos/{owner}/{repo}/rules/branches/{branch}), concluded main was unprotected, attempted the direct push, and printed the full GH013 remote rejection (required status check ci, changes must be made through the merge queue) before falling back to the branch flow, which then worked. The outcome was right; the transcript was a wall of red for a normal ceremony. Outcome: the probe also reads the rulesets endpoint (read-only, never fails the command, UNKNOWN when neither answers), and the verb goes straight to the branch flow when either says protected; the direct flow stays for unprotected repositories. Optionally remember the last ceremony's outcome in the approval home so a repository that refused once is not probed by push again. Why: the ceremony is the human's one hands-on moment and it should read as success, not as a rejection recovered from.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 On a repository whose default branch is governed by a ruleset requiring the merge queue, approval policy amend --commit prints no push rejection and goes directly to the branch flow (test with a stubbed gh answering 404 on branches/{branch}/protection and a ruleset on rules/branches/{branch})
- [ ] #2 A classic-protected repository, an unprotected one, and an unreachable gh each still resolve as before (protected, unprotected, UNKNOWN), covered by tests
- [ ] #3 docs/cli-reference.md policy amend section describes both probes
- [ ] #4 npm test passes; lint clean
<!-- AC:END -->
