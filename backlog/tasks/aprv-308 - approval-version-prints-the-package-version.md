---
id: APRV-308
title: approval --version prints the package version
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-08 06:30'
updated_date: '2026-09-08 23:00'
labels:
  - cli
dependencies: []
ordinal: 227000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
npx -y approval-md@0.1.0 --version on 2026-09-08 printed the usage banner with unknown command --version. Every CLI a stranger installs is asked its version first; this one answers with a usage lecture.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval --version and approval -v print the version from package.json and exit 0; approval version does the same
- [ ] #2 tests/cli.test.ts covers both spellings; docs/cli-reference.md lists the flag
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reuse the package-version source already used by the CLI. 2. Handle top-level --version, -v and version consistently before command dispatch without changing nested command flags. 3. Test exact package version stdout and exit0 for all aliases plus unknown/nested controls. 4. Document aliases and deliver reviewed source with focused/full verification and Codex co-author credit.
<!-- SECTION:PLAN:END -->
