---
id: APRV-539
title: >-
  readers that run a program the line names are opaque (sort --compress-program,
  rg --pre, git grep -O, upload-pack, sed e, openssl -engine)
status: In Progress
assignee: []
created_date: '2026-11-28 14:02'
labels:
  - classifier
  - security
dependencies: []
priority: high
ordinal: 409000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Finding readers-run-code, found on 0.4.9 by claude-build-2@edge2. Five commands the classifier reads as plain reads take a word that names a program they then run, so the program ran under read.shell (or read.vcs.remote) with no ask: sort --compress-program, rg --pre / --hostname-bin and the flag file RIPGREP_CONFIG_PATH names, git grep -O / --open-files-in-pager, git ls-remote / git fetch --upload-pack (ls-remote -u), GNU sed's e command and the e flag of s (and a script from -f, which the classifier cannot read), and openssl dgst -engine / -provider / -provider-path and OPENSSL_CONF. Branch build-2/readers-run-program, stacked on PR #715. This task file is created on the stacked branch build-2/env-before-reader (lane:claude-build-2@edge2) because the readers branch had none; cherry-pick it onto the readers branch.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Each of the five readers with its program word refuses as opaque, the answer find -exec and xargs take, in every spelling GNU getopt_long accepts (prefixes, attached values, after an operand)
- [ ] #2 The same tools without a program word keep the answer they had (pinned controls), and every line asked or refused before stays so
- [ ] #3 Tests through the pure classifier and the built hook under a policy whose default and read.* are autonomous; cost lines at 100,000 characters stay inside the readers' bound
- [ ] #4 Conformance command-class vectors bumped 2.0.0 -> 2.1.0 (a minor bump: new vectors, no expectation moved)
<!-- AC:END -->
