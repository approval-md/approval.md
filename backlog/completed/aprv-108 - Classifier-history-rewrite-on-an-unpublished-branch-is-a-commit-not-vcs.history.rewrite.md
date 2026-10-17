---
id: APRV-108
title: >-
  Classifier: history rewrite on an unpublished branch is a commit, not
  vcs.history.rewrite
status: Done
assignee:
  - '@fable'
created_date: '2026-08-19 17:15'
updated_date: '2026-08-19 18:42'
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
- [x] #1 amend/rebase/reset on a branch with no upstream or with unpushed-only history classify vcs.commit.branch with a named rule; with a reached upstream, on main, detached, or when git cannot answer they stay vcs.history.rewrite
- [x] #2 Force pushes and any push-side rewrite stay vcs.history.rewrite; the rule table in docs/claude-code-hook.md is updated; tests with a real temp repo cover every branch of the rule
- [x] #3 npm test and lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree on top of aprv-106-withdrawn. 2. classifyCommand stays pure (text says rewrite); the hook adds an impure refinement after classification for local rewrite verbs only: detached or default branch stays rewrite; no upstream downgrades to vcs.commit.branch (rewrite-unpublished); amend with HEAD not reachable from the upstream downgrades; rebase/reset with an upstream stay rewrite; any git failure stays rewrite; push-side rewrites untouched. 3. hook classify prints the refined class and rule. 4. Real temp-repo tests for every branch of the rule; docs rule table. 5. PR by branch, auto-merge; records here.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build on top of aprv-106-withdrawn, PR by branch aprv-108-rewrite-unpublished (#89). classifyCommand unchanged and pure. New hook-side refineRewrite(result, cwd), exported, acting only on segments classed vcs.history.rewrite with rule git-commit-amend, git-reset-hard or git-rewrite (rebase, filter-branch, filter-repo); git-push-force excluded by construction; reflog is read.shell already. rewriteReach(cwd): git rev-parse --abbrev-ref HEAD (null, empty or HEAD = detached or no repo -> stay); default branch stays (main/master always, plus refs/remotes/origin/HEAD when set); upstream via git for-each-ref --format=%(upstream:short) refs/heads/branch, deliberately not rev-parse @{u} because @{u} exits non-zero both for no upstream and for unreadable repo and those must not collapse; empty -> no-upstream -> downgrade every local rewrite rule; merge-base --is-ancestor HEAD upstream read as three values, only exit 1 (head-unpushed) downgrades, and only for amend; rebase/reset with an upstream stay (base unresolvable from text). Downgrade: class vcs.commit.branch, rule rewrite-unpublished; classes rebuilt; notes appended to the decision reason; hook classify runs the same refinement in the same cwd. Uses the hook process cwd, not the harness-supplied input.cwd (self-reported fields must not steer the class, SPEC 11.1). Edge cases: unborn branch downgrades (nothing to publish); configured but never-fetched upstream stays (merge-base returns null). 10 real-repo tests in tests/cli-hook-rewrite.test.ts; docs rule table rows marked and a Rewriting unpublished history subsection. 1873 tests, lint and typecheck clean.

Merged at 6c2f7af (PR #89); primary dist rebuilt.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Hook-side refinement: amend/rebase/reset on a branch with no upstream, and amend of an unpushed HEAD, classify vcs.commit.branch (rewrite-unpublished); everything else, and every git failure, stays vcs.history.rewrite; push-side rewrites untouched. PR #89 merged at 6c2f7af; 10 real-repo tests, 1873 total, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
