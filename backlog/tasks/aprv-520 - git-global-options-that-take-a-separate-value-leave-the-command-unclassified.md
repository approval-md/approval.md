---
id: APRV-520
title: >-
  git global options that take a separate value leave the command
  unclassified
status: Done
assignee:
  - '@claude-approval'
created_date: '2026-10-17 12:00'
updated_date: '2026-10-17 12:00'
labels:
  - classifier
  - security
dependencies: []
priority: high
ordinal: 398000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Live hole on main 5fd8a6f1 (and 0.4.5). The classifier reads a git subcommand as the first positional after `git` (`sub = positionals[0]` in classifySegment). A git global option that consumes the next argv word makes that first positional the option's value. `git -C status push --force origin main` is a force push run in the directory `status`, and it classified `read.shell`, autonomous under this repository's policy. `git -C commit reset --hard` classified `vcs.commit.branch`. Every separate-value global does the same: `-c`, `--config-env`, `--git-dir`, `--work-tree`, `--namespace`, `--super-prefix`, `--attr-source`, and the undocumented `--shallow-file`.

Found by the APRV-519 lane (PR B, paused); this task carries the fix alone, as PR A. The fix does not re-derive the subcommand: the command is refused as `unclassified`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every git global that takes a value, in its separate spelling and its `=`-joined long spelling where git accepts one, leaves the segment `unclassified`, whatever the value spells
- [x] #2 A flag in global position that the classifier does not know is `unclassified` too
- [x] #3 The zero-value globals and the options after the subcommand classify exactly as on main
- [x] #4 Classifier tests over every separate-value global alone and in combination, with subcommand-shaped values and dangerous subcommands after them; regressions for plain git subcommands
- [x] #5 A hook-level test under this repository's APPROVAL.md: the hook refuses and appends nothing to the log
- [x] #6 A stricter-only differential against main's classifier over a generated corpus, with counts
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/core/command-class.ts: tables of git 2.50.1's global options (value-taking separate, value-taking joined, zero-value, end-of-globals) and gitGlobalRefusal(args), which walks the leading flag words and names the first one that takes a value or is unknown.
2. classifySegment: for `git`, return `unclassified` with that detail right after the positionals are computed, ahead of the credential, table and refinement reads that would read the value as the subcommand.
3. tests/command-class-git-globals.test.ts: classifier cases, hook cases under the repository's own policy, and the differential gated on APPROVAL_DIFF_BASE.
4. CHANGELOG Unreleased Security entry. No SPEC text covers git globals, so no SPEC change; no conformance expectation moves.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Source of the option table: git(1) OPTIONS and SYNOPSIS for git 2.50.1 (Apple Git-155), and the option strings in that build's binary (`--git-dir`/`--git-dir=`, `--work-tree`/`--work-tree=`, `--namespace`/`--namespace=`, `--config-env`/`--config-env=`, `--attr-source`/`--attr-source=`, `--shallow-file`, "-c expects a configuration string", "no directory given for '%s' option"). git compares each global whole (no abbreviation), and `-C`/`-c` only as separate words, so `-Cdir` is an unknown option to git and to this table.

Decisions:
- `--exec-path=<path>` is treated as value-taking: it repoints where git finds its helpers and puts that directory first on PATH for hooks. A bare `--exec-path`, `--html-path`, `--man-path`, `--info-path` and `--list-cmds=` print and exit; they keep main's handling (skipped), which only ever answers stricter than git behaves.
- `-h`, `--help`, `-v`, `--version` end git's global parsing; they keep main's handling.
- `--super-prefix` is gone from git 2.50 and is kept as value-taking because an older git consumes its value.
- The check sits before the credential read, so `git -C x rm .approval/env` is now `unclassified` rather than `account.credential`. Both are refused by the hook; `unclassified` is refused in every mode, an open window included.

Differential (tests/command-class-git-globals.test.ts, APPROVAL_DIFF_BASE pointing at a build of the base): against 98d12562 (main after #649), depth 2, 41,355 lines: 19,305 unchanged, 18,118 moved from an answer to `unclassified`, 3,932 refused before and after, 0 loosened, 0 reclassified; depth 3, 2,150,475 lines: 907,170 unchanged, 997,840 answer to `unclassified`, 245,465 refused both, 0 loosened, 0 reclassified. Against 5fd8a6f1 (before #649) at depth 3: 1,113,378 answer to `unclassified`, 129,927 refused both, 0 loosened, 0 reclassified.

Merge with #649 (APRV-517): its push grammar reads the globals in front of `push` itself. The APRV-520 check runs first, so five of its pins move to `unclassified`: `--git-dir=`, `--work-tree=`, `--config-env=` (were `vcs.history.rewrite`), `--exec-path=` (was `opaque`) and `--namespace=` (was `vcs.push.branch`). tests/git-push-argv.test.ts is updated to match. Its global table leaves out `--no-literal-pathspecs`, so `git --no-literal-pathspecs push` stays `opaque` there, which is stricter and was left alone.

Usability cost: the `=`-joined spellings (`git --git-dir=.git status`) used to classify as their subcommand and now refuse. The separate spellings with a path value (`git -C ~/repo status`) were already `unclassified` on main, because the path was read as the subcommand.

No conformance vector moved and none was added (no version bump claimed).
<!-- SECTION:NOTES:END -->
