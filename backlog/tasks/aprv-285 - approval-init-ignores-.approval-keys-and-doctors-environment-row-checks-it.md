---
id: APRV-285
title: approval init ignores .approval/keys/ and doctor's environment row checks it
status: To Do
assignee: []
created_date: '2026-09-06 08:17'
labels:
  - safety
  - cli
  - doctor
dependencies: []
type: bug
ordinal: 211000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found 2026-09-06 while preparing policy amendment proposals: .gitignore ignores .approval/daemon/, .approval/env, .approval/vault.enc and .approval/log/verified-head.json, and .approval/payloads/ is deliberately tracked, but .approval/keys/ (the X25519 private halves for sealed token delivery, 0600 in a 0700 dir, unlinked at consume/expiry/revocation) has no entry. A `git add .approval/` during a records or ceremony commit could sweep a live key into a public repo, and a committed key opens that action's token_sealed for anyone holding the log. The repo's own .gitignore gains the line in the overnight wave; this task makes it structural: src/cli/scaffold.ts GITIGNORE_ENTRIES adds .approval/keys/ so `approval init` and `mergeGitignore` write it, tests/cli-init.test.ts pins it, and doctor's environment row (or a sibling) fails when a .approval/keys/ file is tracked or unignored, with the fix line.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `approval init` writes .approval/keys/ into .gitignore; mergeGitignore adds it to an existing file; tests/cli-init.test.ts pins both
- [ ] #2 doctor reports a tracked or unignored .approval/keys/ entry as a failure naming the fix; test covers ignored, unignored and tracked
- [ ] #3 docs/cli-reference.md init and doctor sections mention it
<!-- AC:END -->
