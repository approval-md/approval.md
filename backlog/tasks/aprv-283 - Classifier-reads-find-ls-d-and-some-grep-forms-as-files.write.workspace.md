---
id: APRV-283
title: 'Classifier reads find, ls -d and some grep forms as files.write.workspace'
status: To Do
assignee: []
created_date: '2026-09-06 07:19'
labels:
  - hook
  - classifier
dependencies: []
type: bug
ordinal: 209000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Reported by an agent lane on 2026-09-06: `find …`, `ls -d <path>/*` and grep variants classified as files.write.workspace by `approval hook classify`. They are reads. A false write classification costs nothing in policy today (both are autonomous) but it feeds the execution.failed streak of the loop-escalation rule and misreports the session in coverage. Reproduce with `approval hook classify -- "<cmd>"` for each shape, fix the classifier table in src/core/command-class.ts, and add the shapes to tests/command-class.test.ts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 find, ls -d with a glob, and grep -r/-l/-o forms classify read.shell (or read.files) and the tests pin each shape
- [ ] #2 No previously write-classified command becomes a read: the table diff is reviewed against the existing write fixtures
<!-- AC:END -->
