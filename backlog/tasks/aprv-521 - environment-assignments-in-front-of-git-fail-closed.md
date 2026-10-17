---
id: APRV-521
title: environment assignments in front of git fail closed (allow-list)
status: Done
assignee:
  - '@claude-approval'
created_date: '2026-10-17 14:00'
updated_date: '2026-10-17 11:24'
labels:
  - classifier
  - security
dependencies:
  - APRV-520
priority: high
ordinal: 399000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Live hole on main (and 0.4.5), found by the APRV-520 lane. classifySegment skips every leading `NAME=value` word and classifies `git` by its subcommand alone. git(1)'s ENVIRONMENT section is mostly variables that run a program, repoint the repository or its configuration, or write a file, so `GIT_PAGER=<cmd> git log` classified `read.shell` and ran `<cmd>` autonomously, and `GIT_DIR=x git status` read another repository under the same answer. The same holds for GIT_WORK_TREE, GIT_CONFIG_* (COUNT/KEY_n/VALUE_n/PARAMETERS/GLOBAL/SYSTEM/NOSYSTEM), GIT_EXEC_PATH, GIT_SSH, GIT_SSH_COMMAND, GIT_EDITOR, GIT_SEQUENCE_EDITOR, GIT_ASKPASS, GIT_EXTERNAL_DIFF, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_NAMESPACE, GIT_CEILING_DIRECTORIES, GIT_DISCOVERY_ACROSS_FILESYSTEM, GIT_TRACE*=<path>, PAGER, EDITOR, VISUAL, LESS/LESSOPEN, HOME and XDG_CONFIG_HOME. A bare `GIT_PAGER=x;`, `printf -v GIT_PAGER` or `${GIT_PAGER:=x}` earlier on the line reaches git too when the name is already exported.

Stacked on APRV-520 (PR #651), which touches the same spot in classifySegment.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A git segment with any assignment in front of it is `unclassified`, except a closed allow-list of words that cannot run a program, redirect configuration or the repository, or write a file; each entry is justified from git(1)'s ENVIRONMENT section
- [x] #2 The `env NAME=val git`, `env -i git`, `command git`, `exec git` wrapper forms are refused
- [x] #3 `export NAME=val; git ...` (and declare/typeset/readonly/local, a bare assignment, `printf -v`, `${NAME:=val}`) of a non-allowed variable git reads leaves the git segments on the line `unclassified`
- [x] #4 Classifier tests: every listed variable alone and combined, before read subcommands (log, status, diff, show) and write subcommands; near misses of the allow-list; the allow-list still passes
- [x] #5 A hook-level test under this repository's APPROVAL.md: the hook refuses and appends nothing to the log
- [x] #6 A stricter-only differential against PR #651's head over a generated corpus, with counts
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/core/command-class.ts: GIT_HARMLESS_ASSIGNMENTS (exact words), GIT_LOCALE_NAMES with a plain-value test and TZ through date-argv's isZoneValue, isHarmlessGitAssignment and gitAssignmentRefusal.
2. isGitInheritedName and gitEnvironmentWrite: a scan of the line's segments for a variable git could inherit that the line's own shell sets. classifyCommand runs it and carries the name in ClassifierContext.shellEnvWrite, so substitutions and unwrapped scripts see it.
3. classifySegment: for `git`, refuse an assignment off the list, then a line-scoped write, ahead of APRV-520's globals check, the credential read and the table. The bare-assignment rule refuses a git-read name off the list, as it refuses PATH.
4. tests/command-class-git-env.test.ts; tests/git-push-argv.test.ts pins move.
5. CHANGELOG Unreleased Security entry. No SPEC text covers environment assignments in front of git; no conformance expectation moves.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Source: git 2.50.1 (Apple Git-155) git(1) "ENVIRONMENT VARIABLES" and git-config(1) "ENVIRONMENT" (GIT_CONFIG_COUNT/KEY_<n>/VALUE_<n>, GIT_CONFIG). GIT_CONFIG_PARAMETERS is not documented; it is the carrier git uses to pass `-c` to its children. Nothing was learned by running git with these variables.

Allow-list (exact words), each able only to remove a program git would run or swap it for a no-op:
- GIT_TERMINAL_PROMPT=0: git(1) "If this Boolean environment variable is set to false, git will not prompt on the terminal".
- GIT_PAGER=cat: git(1) "If it is set to an empty string or to the value "cat", Git will not launch a pager".
- PAGER=cat: git(1) GIT_PAGER "overrides $PAGER"; the same `cat` test applies to the pager whichever source named it, and a configured core.pager or GIT_PAGER runs with or without the word.
- GIT_EDITOR=true, GIT_EDITOR=:: git(1) GIT_EDITOR "overrides $EDITOR and $VISUAL"; git skips the editor for `:` and runs the no-op `true` otherwise. GIT_SEQUENCE_EDITOR still outranks it for a rebase todo list, as without the word.
- EDITOR=true, EDITOR=:, VISUAL=true, VISUAL=:: the fallbacks below GIT_EDITOR and core.editor, set to the same no-ops. With the two above, this is APRV-433's (#648) HARMLESS_ASSIGNMENTS list exactly, kept equal so a spelling #648 judges local is not refused here first.
- LANG and LC_ALL, LC_COLLATE, LC_CTYPE, LC_MESSAGES, LC_MONETARY, LC_NUMERIC, LC_TIME (and glibc's LC_ADDRESS, LC_IDENTIFICATION, LC_MEASUREMENT, LC_NAME, LC_PAPER, LC_TELEPHONE) with a value matching `^[A-Za-z][A-Za-z0-9_@.-]*$` and no `..`; TZ through isZoneValue (a zone database name or a POSIX rule, never a path). git(1) names neither; git reads them through the C library only, and a value with no `/` and no `..` names no file the agent chose.
Left out: GIT_PAGER= (empty; harmless per git(1), but left out as a spelling), GIT_TERMINAL_PROMPT=false and other Boolean spellings, LANGUAGE (a gettext colon list), TZDIR, and every other variable.

Decisions:
- A word carrying a command substitution is never harmless; a backtick is refused earlier as opaque.
- The line scan (gitEnvironmentWrite) is bounded to names git or the programs it starts read (GIT_*, XDG_*, LESS*, LC_*, LD_*, DYLD_*, PAGER, EDITOR, VISUAL, LV, HOME, PATH, TMPDIR, SSH_ASKPASS, BASH_ENV, ENV, LANG, LANGUAGE, TZ, TZDIR, LOCPATH). A bare assignment reaches git only if the name is already exported, so an ordinary script variable (`b=$(git branch --show-current); git push origin "$b"`) is left alone. In front of `git` itself the list is closed: any name off it refuses.
- The scan reads the whole line, not just the part before git (a loop body runs again after its own later assignment), and counts subshells and pipeline stages that would keep the assignment to themselves. Both only refuse more.
- An assignment in front of a POSIX special builtin persists in sh and bash's POSIX mode, so it is counted as a line write.
- The check sits before APRV-520's globals check, the credential read and the table, like APRV-520's. A protected redirect still answers first (`GIT_PAGER=x git log > APPROVAL.md` is policy.core, a human class), as for every other binary.
- The push grammar (APRV-517) still reads every GIT_* assignment as steering, so `GIT_TERMINAL_PROMPT=0 git push origin lane` stays vcs.history.rewrite (git-push-unreadable), stricter and unchanged.

tests/git-push-argv.test.ts pins moved: GIT_CONFIG_PARAMETERS=, GIT_CONFIG_COUNT=, HOME=, XDG_CONFIG_HOME= in front of push (were vcs.history.rewrite) and FOO=1 (was vcs.push.branch) are now unclassified.

Differential (tests/command-class-git-env.test.ts, APPROVAL_DIFF_BASE = a build of f62dd57e, PR #651's head): depth 2, 232,239 lines: 19,320 unchanged, 180,544 answer to unclassified, 32,375 refused both, 0 loosened, 0 reclassified; depth 3, 21,868,560 lines: 242,928 unchanged, 18,534,298 answer to unclassified, 3,091,334 refused both, 0 loosened, 0 reclassified.

Usability cost: any assignment off the list in front of git (`FOO=1 git status`, `GIT_AUTHOR_NAME=x git commit`) now needs a person, and a bare `GIT_*=` or `PAGER=` assignment on its own is refused like a bare `PATH=`.

Out of scope, not fixed: other binaries that honor PAGER/EDITOR or run git underneath (`PAGER=evil gh pr view 1` is read.vcs.remote; `GIT_SSH_COMMAND=evil npm install` is deps.install). No conformance vector moved and none was added (no version claimed).

Fold of review-b M1 (T2 read at 9c31383b). The assignment cursor read only the plain `NAME=value` spelling, so an append-operator word, or a subscripted name, in front of git was taken for the program and the APRV-521 check never ran; this was equally open on main. `ASSIGNMENT` now reads every bash assignment-word spelling (name, optional subscript, `=` or `+=`), so every cursor in the module (classifySegment, the line scan, movesNameResolution, commandSegmentShapes/Words) agrees with bash. Only the plain spelling is judged by the rules: an append or subscripted word leaves the segment `unclassified` in front of any program and on its own, a command word that opens like a subscripted assignment the tokenizer cannot read in full is `unclassified`, and the tokenizer refuses the compound array form as `unparseable`. Folded one-liners: N2 (subscripted default-assignment in the line scan), N4 and N5 (`GCONV_PATH`, `GNUPGHOME` join `isGitInheritedName`). Left for follow-up: N3 (heredoc body default-assignment), N6 (network and trust names), N9 (shell differential `/` filter and bash 4), N10 (the generic prefix rule for non-git programs), and a quoted-name word that bash takes for a command while this classifier takes it for an assignment (pre-existing, plain spelling included). Differential depth 2 against main 2179e128 with the new spellings in the alphabet: 1,533,105 lines, 272,300 ok to refused, 0 loosened, 0 reclassified.
<!-- SECTION:NOTES:END -->
