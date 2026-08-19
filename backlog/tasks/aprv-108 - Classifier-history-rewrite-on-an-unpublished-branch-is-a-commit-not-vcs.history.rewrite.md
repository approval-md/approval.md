---
id: APRV-108
title: >-
  Classifier: history rewrite on an unpublished branch is a commit, not
  vcs.history.rewrite
status: To Do
assignee: []
created_date: '2026-08-19 17:15'
labels:
  - hook
  - classifier
milestone: m-11
dependencies: []
priority: low
ordinal: 100000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-08-19: a builder subagent ran git commit --amend on its own worktree branch with no upstream and no push; the classifier named it vcs.history.rewrite (manual), the hook pinged the human, the wait timed out (APRV-106 covers the stale-grant half). Rewriting history nobody else holds is a commit: the danger vcs.history.rewrite guards against is rewriting SHARED history (force-push, rebase of a pushed branch, amend after push). DESIGN: the hook already runs git (APRV-101). For amend/rebase/reset/filter-branch/reflog-expire style commands, ask git whether the current branch has an upstream (git rev-parse --abbrev-ref --symbolic-full-name @{u}) and whether HEAD is an ancestor of it (git merge-base --is-ancestor HEAD @{u}); if there is no upstream, or HEAD is not yet pushed there, classify vcs.commit.branch; if git cannot answer, the branch is main, or the upstream is reached, stay vcs.history.rewrite (fail closed). git push --force and friends stay vcs.history.rewrite regardless. hook classify prints the reason in its rule column (e.g. rewrite-unpublished). Tests with a real temp repo: no upstream, pushed upstream, ahead of upstream, detached HEAD, main.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 amend/rebase/reset on a branch with no upstream or with unpushed-only history classify vcs.commit.branch with a named rule; with a reached upstream, on main, detached, or when git cannot answer they stay vcs.history.rewrite
- [ ] #2 Force pushes and any push-side rewrite stay vcs.history.rewrite; the rule table in docs/claude-code-hook.md is updated; tests with a real temp repo cover every branch of the rule
- [ ] #3 npm test and lint clean
<!-- AC:END -->
