---
id: APRV-540
title: >-
  environment assignments in front of a reader fail closed (closed list, as in
  front of git)
status: In Progress
assignee: []
created_date: '2026-11-28 14:03'
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
- [ ] #1 In front of a command whose class is read.* (read.shell, read.vcs.remote, read.web, and the read-scope class the hook derives), an assignment is admitted only from a closed named list of words that cannot change which program runs or what it loads; each entry is justified
- [ ] #2 Any other assignment, on the named steering list or unknown, leaves the segment unclassified through the mechanism git's APRV-521 rule uses (code unclassified, the same wording style); the hook denies it under every policy, abstain included
- [ ] #3 Several assignments (any one decides), the redirect, pipeline, subshell, substitution and sandbox-wrapper forms, and a bare assignment, printf -v or ${NAME:=v} of a steering name earlier on the line are covered; env, export, declare and exec forms keep the refusals they had
- [ ] #4 No loosening: a before/after sweep of the conformance vectors, the overlay recipe corpus and expected.json, and every assignment-bearing string in tests/ lists every line that moves, each a tightening
- [ ] #5 Tests committed failing before the fix: one per steering name and form, the unknown default, the admitted list (stays read), multi-assignment, env forms, same-line forms; through the pure classifier and the built hook; cost lines for a long assignment prefix and a long line of bare assignments under the existing bound
- [ ] #6 Conformance command-class vectors: new vectors at a minor bump over the readers branch's 2.1.0, no expectation moved
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/core/command-class.ts: READER_HARMLESS_VALUES (name -> value pattern) and isHarmlessReaderAssignment (git's isHarmlessGitAssignment plus that table); READER_STEERING_NAMES with a prefix/suffix shape, isReaderSteeringName; readerAssignmentRefusal, worded as gitAssignmentRefusal. 2. gitEnvironmentWrite takes the name test and the harmless test as parameters (defaults: git's), so the line scan is reused for readers; ClassifierContext.readerEnvWrite carries the first steering name the line sets, as shellEnvWrite does. 3. restOfWalk: once the table's class is read.*, refuse on readerAssignmentRefusal, then on readerEnvWrite; before every protected, write and scope answer, so a refusal is never softened. 4. tests/command-class-env-before-reader.test.ts. 5. regen-conformance-vectors.mjs: command-class 2.2.0.
<!-- SECTION:PLAN:END -->
