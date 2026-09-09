---
id: APRV-308
title: approval --version prints the package version
status: Done
assignee:
  - '@codex-sol'
created_date: '2026-09-08 06:30'
updated_date: '2026-09-09 01:32'
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
- [x] #1 approval --version and approval -v print the version from package.json and exit 0; approval version does the same
- [x] #2 tests/cli.test.ts covers both spellings; docs/cli-reference.md lists the flag
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reuse the package-version source already used by the CLI. 2. Handle top-level --version, -v and version consistently before command dispatch without changing nested command flags. 3. Test exact package version stdout and exit0 for all aliases plus unknown/nested controls. 4. Document aliases and deliver reviewed source with focused/full verification and Codex co-author credit.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented ca341c260f9c72a0952d805ba153de22418f70d1; PR350 merged69c4e12a44a0b2360c40fb1339fb7e8c2827a94d. Exact top-level aliases return package version and exit0, nested flags unchanged. Focused classifier/CLI472/472 exit0, full env-clean suite3973pass/1skip/0fail exit0, lint/typecheck0, required GitHub checks passed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Top-level --version, -v and version print the package version and exit0. Tests and CLI documentation delivered in merged PR350.
<!-- SECTION:FINAL_SUMMARY:END -->
