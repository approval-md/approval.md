---
id: APRV-433
title: >-
  Policy observation for the human: vcs.history.rewrite is human-only for an
  unshared lane branch too, and it stopped two lanes in one session
status: To Do
assignee: []
created_date: '2026-09-22 03:09'
labels:
  - policy
  - dogfood
dependencies: []
priority: low
ordinal: 331000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Proposed policy change for Carter's sign-off; agents do not edit APPROVAL.md. On 2026-09-22 the class vcs.history.rewrite (APPROVAL.md line 50, human-only) refused Lane C a force-push of its own unshared lane branch after dropping two commits, and refused Lane B git rebase --continue and git rebase --abort after a conflict, leaving that worktree with a rebase in progress only a human can clear (git rebase --quit). The rule's comment says a person rewrites SHARED history; the class as written covers every branch. Both lanes found allowed routes (a fresh branch and a replacement PR; a merge commit instead of a rebase) so nothing was lost, but each cost a round trip and a stale PR. Options: (a) keep as is and document the two allowed routes in CLAUDE.md; (b) split the class so a rewrite of a branch that no other ref or PR shares is supervised while main and records branches stay human-only, which needs the classifier to know whether a branch is shared (a remote-tracking ref check) and a SPEC row; (c) allow only git rebase --abort and --quit, which restore the pre-rebase state. This task records the observation and the options; the decision is Carter's.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Carter has chosen an option and recorded it in this task
- [ ] #2 If (a): CLAUDE.md names the two allowed routes under the dogfooding section (policy.edit, one tap). If (b) or (c): a follow-up task carries the classifier change, its SPEC row and the APPROVAL.md amendment through the amend ceremony
<!-- AC:END -->
