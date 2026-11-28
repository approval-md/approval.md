---
id: APRV-540
title: >-
  environment assignments in front of a reader fail closed (closed list, as in
  front of git)
status: In Progress
assignee: []
created_date: '2026-11-28 14:03'
updated_date: '2026-11-28 14:18'
labels:
  - classifier
  - security
dependencies:
  - APRV-539
priority: high
ordinal: 410000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Finding env-before-reader, verified on the published 0.4.9 with approval hook classify --json. The classifier reads past every leading NAME=value word and classifies the command by its verb alone, except in front of git (APRV-521). So an assignment that changes which program runs or what it loads rides a plain read unasked: PATH=. cat README.md, LD_PRELOAD=./x.so cat README.md, DYLD_INSERT_LIBRARIES=./x.dylib cat README.md and IFS=x cat README.md classify read.shell; GH_PAGER=./x gh pr diff 1 and BROWSER=./x gh pr view --web classify read.vcs.remote; NODE_OPTIONS=--require=./x npm --version is read.shell npm-version. A bare IFS=x; or GH_PAGER=./x && earlier on the line reaches the reader when the name is exported. Lead ruling (binding, gates the 0.4.10 tag): an assignment in front of a reader that changes which program runs or what it loads is not a read; classify by the assignment, not only the verb, over a closed list swept and named (PATH, LD_PRELOAD and DYLD_ forms, PAGER and every tool pager and editor variable, GIT_ variables that name a program, BASH_ENV and ENV, IFS); default for an unknown assignment before a reader is ask-first. Its own PR, after the readers PR (APRV-539). Built on branch build-2/env-before-reader (lane:claude-build-2@edge2).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 In front of a command whose class is read.* (read.shell, read.vcs.remote, read.web, and the read-scope class the hook derives), an assignment is admitted only from a closed named list of words that cannot change which program runs or what it loads; each entry is justified
- [x] #2 Any other assignment, on the named steering list or unknown, leaves the segment unclassified through the mechanism git's APRV-521 rule uses (code unclassified, the same wording style); the hook denies it under every policy, abstain included
- [x] #3 Several assignments (any one decides), the redirect, pipeline, subshell, substitution and sandbox-wrapper forms, and a bare assignment, printf -v or ${NAME:=v} of a steering name earlier on the line are covered; env, export, declare and exec forms keep the refusals they had
- [x] #4 No loosening: a before/after sweep of the conformance vectors, the overlay recipe corpus and expected.json, and every assignment-bearing string in tests/ lists every line that moves, each a tightening
- [x] #5 Tests committed failing before the fix: one per steering name and form, the unknown default, the admitted list (stays read), multi-assignment, env forms, same-line forms; through the pure classifier and the built hook; cost lines for a long assignment prefix and a long line of bare assignments under the existing bound
- [x] #6 Conformance command-class vectors: new vectors at a minor bump over the readers branch's 2.1.0, no expectation moved
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/core/command-class.ts: READER_HARMLESS_VALUES (name -> value pattern) and isHarmlessReaderAssignment (git's isHarmlessGitAssignment plus that table); READER_STEERING_NAMES with a prefix/suffix shape, isReaderSteeringName; readerAssignmentRefusal, worded as gitAssignmentRefusal. 2. gitEnvironmentWrite takes the name test and the harmless test as parameters (defaults: git's), so the line scan is reused for readers; ClassifierContext.readerEnvWrite carries the first steering name the line sets, as shellEnvWrite does. 3. restOfWalk: once the table's class is read.*, refuse on readerAssignmentRefusal, then on readerEnvWrite; before every protected, write and scope answer, so a refusal is never softened. 4. tests/command-class-env-before-reader.test.ts. 5. regen-conformance-vectors.mjs: command-class 2.2.0.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented on build-2/env-before-reader (lane:claude-build-2@edge2), stacked on the readers branch (APRV-539) and PR #715.

Mechanism reused: gitAssignmentRefusal's (code unclassified, wording 'no rule for NAME=… in front of <program>: …'); readerAssignmentRefusal sits beside it. The line scan is gitEnvironmentWrite itself, now taking its name test and harmless test as parameters (defaults are git's, so git's answers are unchanged); ClassifierContext.readerEnvWrite carries the first steering name the line sets, as shellEnvWrite does for git.

Where: restOfWalk, right after the table's class and refinement, when the class starts with read.; ahead of every protected, write, git-dir and scope answer, so nothing later softens it. Answers taken earlier (the credential tier, a protected redirect, opaque) keep theirs: each is already a refusal or a human-only class.

Admitted (closed): isHarmlessGitAssignment (GIT_TERMINAL_PROMPT=0, GIT_PAGER=cat, PAGER=cat, GIT_EDITOR/EDITOR/VISUAL=true or :, LANG/LC_* plain locale, TZ zone) plus READER_HARMLESS_VALUES: NO_COLOR, CLICOLOR, CLICOLOR_FORCE, FORCE_COLOR, CI, GH_PROMPT_DISABLED, GH_NO_UPDATE_NOTIFIER, GH_SPINNER_DISABLED (letters and digits, 0-16), COLUMNS, LINES (1-5 digits), TERM (a name, no slash), GH_PAGER (cat or empty), GH_REPO (OWNER/REPO, no host).

Steering (named, for the wording and the line scan): READER_STEERING_NAMES plus the shape LD_, DYLD_, BASH_, XDG_, GH_, GIT_, OPENSSL_, LESS, LC_, PYTHON, PERL, RUBY, NODE_, npm_config_, NPM_CONFIG_, BUN_, DENO_ prefixes and PAGER, EDITOR, BROWSER, ASKPASS suffixes, plus git's isGitInheritedName.

Unknown default: unclassified too. The hook has no ask for a segment it cannot classify: unclassified is a deny under every policy, and abstain applies only to a no-rule segment with no = word, so it never abstains here (tests: both policies). 'Ask-first' as the ruling words it is not reachable without a new class; left as an open question to the lead.

Decisions: a bare cd is exempt (POSIX intrinsic, runs nothing; CDPATH and HOME already modelled by the landing rules, and the credential fix M-B test needs that answer). The line scan reads the steering names only, as git's does: a bare unknown name (f=README.md; cat "$f") reaches the reader only if already exported, and refusing it would refuse ordinary script variables. export/declare/local lines were already refused (no rule for export). Builtins echo and printf are not exempt (PATH=. echo hi is refused; a tightening).

Sweep (before 5b04a6bd, after this branch) over the 472 command-class vectors, the 63-recipe overlay corpus (filled and raw), expected.json and every assignment-bearing string literal in tests/: 1,553 commands, no vector, corpus or expected.json line moved; overlay-recipes-check.mjs --json output identical for both cores. Test pins moved (each a tightening): command-class-git-env (n=5 cat README.md; GIT_PAGER=evil echo hi; git log), command-class-quoted-name (n=5 ls and its quoted-value forms), cli-hook-home-var-assigned (HERMES_HOME=… echo x >> …). Lines that moved in tests that already accepted a refusal: X=sub true; echo x > $X/y, X=dist true; rm -rf ../$X, A=..; B=x true; rm -rf "$A/$B".

Global invariants: touches 'refusals are machine-readable and distinct' (reuses unclassified with a distinct detail) and 'fail closed' (unknown names refuse); weakens none.
<!-- SECTION:NOTES:END -->
