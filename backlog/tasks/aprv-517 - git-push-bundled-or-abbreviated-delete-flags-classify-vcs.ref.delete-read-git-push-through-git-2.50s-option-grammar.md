---
id: APRV-517
title: >-
  git push bundled or abbreviated delete flags classify vcs.ref.delete: read git
  push through git 2.50's option grammar
status: In Progress
assignee: []
created_date: '2026-10-17 05:09'
updated_date: '2026-10-17 05:34'
labels:
  - classifier
  - security
dependencies: []
priority: high
type: bug
ordinal: 395000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the APRV-648 refutation (finding S2, lanes-approval/APRV-648-refute.md), pre-existing and live on main 2b8aeb33: `git push -ud origin lane`, `-du`, `--del`, `--de` delete the remote branch on git 2.50 but classify as a plain push. Under this repository APPROVAL.md that is `vcs.push.branch` (autonomous) for a branch and `vcs.push.main` (supervised-retro, proceeds) for the trunk, so `vcs.ref.delete` (manual, line 51) is never asked. Cause: refineGitPush matched flags by exact spelling (hasFlag `--delete`/`-d`), and git parse-options also accepts short bundles and any unique long-option prefix. The same family was open: `--prune` (deletes remote refs a pattern no longer matches) was never read, `--m`/`--mirr` (mirror) and `-uf`/`--force-w` read as plain pushes, a value-taking option (`-o x`, `--repo x`) or a global option in front of push (`git --no-pager push origin`) shifted the positionals, and an expandable word (`$B`, `{a,:main}`) could hold `:main` or `+main` while reading as a trunk push.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every short option bundle and every unique long-option abbreviation git 2.50 accepts for git push classifies at least as strictly as the spelled-out option; a deletion in any form (flag, empty-source refspec, --prune) is vcs.ref.delete or stricter
- [x] #2 What the grammar cannot walk fails closed: unknown option, ambiguous abbreviation, value where none is taken, missing value, unknown global option and --exec/--receive-pack are opaque; an expandable word, a substitution or a GIT_*/HOME/XDG_CONFIG_HOME assignment is vcs.history.rewrite (git-push-unreadable)
- [x] #3 Classifier and hook-level tests pin every spelling; a real-git test proves each deleting spelling deletes the branch on a bare local remote and that every admitted argv in a generated corpus is classified at least as strictly as its observed effect
- [x] #4 A differential over a generated corpus against origin/main shows every verdict change is stricter, under the class order and under this repository APPROVAL.md
- [x] #5 command-class conformance vectors regenerated via scripts/regen-conformance-vectors.mjs with a minor bump; CHANGELOG Unreleased Security entry
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. New pure module src/core/git-push-argv.ts: the git 2.50 builtin/push.c option table and parse_long_opt / short-bundle walk. 2. refineGitPush reads the argv twice (grammar, and the old word scan as a floor) and keeps the stricter class. 3. RuleContext carries the assignments. 4. Tests: tests/git-push-argv.test.ts (pure), tests/git-push-delete-spellings.test.ts (real git, sampled; APPROVAL_DIFF_GIT_FULL=1 for the whole corpus), tests/cli-hook-push-delete.test.ts (hook). 5. Vectors, CHANGELOG.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done in lane claude-approval@main/APRV-PUSH-DELETE (Opus 5.5 subagent), base 2b8aeb33 rebased onto origin/main.
- New pure module src/core/git-push-argv.ts: the git 2.50 builtin/push.c option table and a walk that follows parse-options.c (exact long name wins; otherwise unique prefix, positive or through no-; OPT_ALIAS branches/all not ambiguous; short bundles, -o takes the rest of the bundle or the next word; -- and --end-of-options end options). Agreement check against the real binary: 598 of 600 long/short spellings (incl. =value and negations) accepted or refused exactly as git 2.50.1 does; the two others are -h and a completion helper, both print-and-exit.
- refineGitPush reads twice: the grammar, and the old exact-spelling word scan kept as a floor; the stricter class wins (order rewrite > release.publish > ref.delete > push.main > push.branch), grammar answer kept on a tie. New rules: git-push-prune (vcs.ref.delete, nothing bound), git-push-unreadable (vcs.history.rewrite). Refusals are opaque. RuleContext gained `assignments`. Steering globals (--git-dir=, --work-tree=, --config-env=) read unreadable; --exec-path is opaque.
- Decision for the orchestrator: an expandable word ($B, "$B", $(...), glob, brace) now reads vcs.history.rewrite (human-only here). This moves two pinned expectations stricter: `git push origin $BRANCH` (was vcs.push.main) and `git push origin --delete $BRANCH` (was vcs.ref.delete with $BRANCH bound). The log holds no git push with `$`, so the cost here is nil.
- SPEC §7 (APRV-352 paragraph) wording would need "every spelling the git option parser accepts, and --prune" and "a deletion whose refs the text cannot read stays in the class or a stricter one". Not edited (protected).
- Evidence: tsc --noEmit 0, lint 0, build 0, conformance/run.mjs 0 (681/681), targeted tests 0; real-git oracle full corpus 6595 argvs, 5480 admitted and run, 0 under-classified; classifier differential vs 2b8aeb33 over 29215 commands, 15207 stricter, 0 looser (class order and this APPROVAL.md). Report: agentvillage/private/handover/lanes-approval/APRV-PUSH-DELETE-build.md.
<!-- SECTION:NOTES:END -->
