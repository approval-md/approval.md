---
id: APRV-518
title: >-
  Mutating git remote and push HEAD/@ classify at least as strict as the push
  they enable
status: In Progress
assignee: []
created_date: '2026-10-17 06:49'
updated_date: '2026-10-17 07:19'
labels:
  - classifier
  - security
dependencies: []
priority: high
type: bug
ordinal: 396000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the APRV-517 build lane (lanes-approval/APRV-PUSH-DELETE-build.md, follow-ups F1 and F3), live on main and on #649. F1: every `git remote` subcommand classified `read.vcs.remote` through the git-remote-read row, so `git remote add --mirror=push m <url>` ran unasked, and the `git push m` after it read as an implicit vcs.push.main while it was a mirror push that deleted remote branches (verified on git 2.50.1): a two-step bypass of vcs.ref.delete and vcs.history.rewrite. The same family: a configured remote.<name>.push refspec can delete (`:refs/heads/x`) or force (`+...`), and a colon-less refspec on the command line takes the destination and force of the configured refspec that maps it, none of which the text shows. F3: `git push origin HEAD` and `git push origin @` classified vcs.push.branch even when the current branch is main.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Only a closed list of git remote forms stays read.vcs.remote (bare, -v/--verbose, show [-n], get-url [--push] [--all], update without --prune); every other git remote form is vcs.history.rewrite; git config writes of remote.* stay refused
- [x] #2 A git push whose refs its remote configuration decides (no refspec, or a colon-less refspec) is answered from the checkout: mirror remote rewrite, configured push refspecs by their class, local tag and push.followTags release.publish, submodule recursion vcs.push.main; unreadable configuration or an unfollowable cd is vcs.history.rewrite
- [x] #3 HEAD/@ resolve to the current branch: main/master/origin HEAD branch or detached is vcs.push.main; the pure classifier reads HEAD/@ as vcs.push.main
- [x] #4 Classifier, hook and real-git (bare local remote) tests; a differential against #649's head shows every verdict change is stricter
- [x] #5 command-class conformance vectors regenerated via scripts/regen-conformance-vectors.mjs (1.9.0); CHANGELOG Unreleased Security entry
- [x] #6 Steer (#649 refutation): any shell write whose target has a .git segment (redirect, tee, cp, mv, sed -i, rm, ln, curl -o, wget -O) is vcs.history.rewrite (git-dir-write); in the same command, earlier foreign code or a write to a shell-expanded path makes a push's configuration unreadable
- [x] #7 Steer: push destinations resolve through git's ref DWIM (heads/main, refs/heads/main, case-insensitive, tags/x a tag, the origin/HEAD branch a trunk), so any destination that resolves to the default branch is vcs.push.main or stricter
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. refineGitRemote on the git-remote-read row: closed read list, everything else vcs.history.rewrite (git-remote-write). 2. pushFactsClass gains headAs; the pure reading treats a colon-less HEAD/@ as the trunk (git-push-head). 3. Pure gitPushSegmentClass(segmentText, facts[] | null) in command-class.ts re-reads one git push under repository facts; GIT_PUSH_RULES exported. 4. Impure src/cli/push-repo.ts: readPushRepoFacts per directory (rev-parse, symbolic-ref, config --get-regexp, for-each-ref, legacy dirs), cd tracking, refinePushRepo first in classifyForHook. 5. Tests: command-class-remote-config (pure + property), git-push-remote-config (real git), cli-hook-remote-config (hook). 6. Vectors 1.9.0, CHANGELOG, docs.

7. Steer from the #649 refuter: git-dir-write rule in classifySegment; earlier CODE_EXECUTING_RULES segments and expanded write paths make the push-repo read unreadable; destinationBranch/isTrunkBranch DWIM in pushFactsClass, tags/ prefix in isTagRef, defaultBranch in PushRepoFacts.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done in lane claude-approval@main/APRV-REMOTE-MIRROR (Opus 5.5 subagent), stacked on #649 (approval/push-delete-bundles @ ea147c55).
- Class choice: vcs.history.rewrite for every writing `git remote` form (rule git-remote-write) and for any write into a .git directory (git-dir-write). No existing class names remote or git-dir configuration; vcs.ref.delete is below the mirror push such a write can arm, and policy.* is the gate's own surface. A narrower class (for example vcs.remote.config) needs a SPEC §7 change and the human attest; not made.
- git config has no row, so remote.*/push.*/include.* writes stay unclassified (refused outright), which is stricter than any class; `git -c remote.x=y push` stays refused. Unchanged and pinned by tests.
- Pure layer: closed git remote read list; colon-less HEAD/@ (any case: `head` resolves on case-insensitive filesystems) reads vcs.push.main (git-push-head); DWIM destinations (heads/main, MAIN, tags/x).
- Impure layer src/cli/push-repo.ts, first in classifyForHook: per directory the push may run in (hook cwd + every literal cd, union), reads current branch, origin/HEAD, remote.*.mirror, remote.*.push, push.followTags, push.recurseSubmodules/submodule.recurse, local tags, legacy remotes/branches dirs. Strictest answer wins. Unreadable checkout, unfollowable cd, legacy remotes file, earlier CODE_EXECUTING_RULES segment or an expanded write path => vcs.history.rewrite (git-push-config-unreadable) for a push its configuration decides (no refspec or a colon-less refspec); explicit src:dst keeps its class. A non-repository directory adds nothing (git refuses there). push.default is not read: none of its values forces or deletes, and an implicit push is already vcs.push.main.
- The only lowering vs the pure layer is HEAD/@ resolved to a non-trunk branch => vcs.push.branch, which equals #649's answer.
- Verified on git 2.50.1: a colon-less refspec takes force AND destination from a mapping remote.*.push; HEAD takes no mapping; mirror config applies with --tags/--all/--repo; `lane:heads/main` moves main.
- Evidence: tsc 0, lint 0, build 0, conformance 693/693 (0), regen no drift; targeted 28 files exit 0 (1789 tests, 1787 pass, 2 machine skips). Differential vs #649 head: pure 24,689 lines 0 looser (6,887 stricter); hook 3,627 lines in 9 checkout states 0 looser (1,003 stricter). command-class 1.9.0 (#649 has 1.8.0; #639 also claims 1.8.0).
- Touches global invariant "fail closed" only in the strict direction.
<!-- SECTION:NOTES:END -->
