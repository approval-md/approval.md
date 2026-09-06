---
id: APRV-284
title: The daemon's records PR arms its own merge
status: To Do
assignee: []
created_date: '2026-09-06 07:19'
labels:
  - daemon
  - records
dependencies: []
type: enhancement
ordinal: 210000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
approval log advance --pr and the daemon's advance cadence open or update a records-log-<date> PR and stop there; it sits at CLEAN until a person clicks or a session runs gh pr merge --auto. Records commits carry only the log, queue and payloads, are exempt from the protected-path guard, and are the one PR shape that never needs review, so arm auto-merge when the PR is created (gh pr merge <n> --auto --merge, or the API equivalent), classified vcs.push.main exactly as a session's arm is. The advance verb's output names whether the merge was armed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval log advance --pr arms auto-merge on the PR it opens or updates, and says so; a flag disables it
- [ ] #2 The daemon advance path does the same; tests cover the armed and the disabled cases against a mocked gh
- [ ] #3 docs/cli-reference.md log advance section and CLAUDE.md workflow item 7 mention it
<!-- AC:END -->
