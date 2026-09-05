---
id: APRV-270
title: >-
  doctor --help says twelve checks and lists twelve of the 25 rows: derive the
  help roster from tests/doctor-rows.ts or describe the cascade without a count
status: To Do
assignee: []
created_date: '2026-09-05 16:16'
labels:
  - cli
  - docs
dependencies: []
priority: low
ordinal: 201000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the APRV-269 lane on 2026-09-06: src/cli/help.ts DOCTOR_HELP still says 'Twelve checks' and lists twelve rows, while the doctor prints 25 (tests/doctor-rows.ts holds the ordered roster since APRV-269). Help is a source string under the 25-line cap (tests/cli-long-help.test.ts) and cannot list 25 rows. Outcome: the help describes the cascade by shape (build, identity, policy, log, channels, store, sampling, hooks, git evidence, daemon health, values, checkpoint) without a number, or names the count from the roster constant so it cannot drift, and points at docs/cli-reference.md for the full list; cli-help tests updated.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 DOCTOR_HELP carries no stale count and stays under the 25-line cap; a test pins that any number of rows it states equals the roster length, or that it states none
- [ ] #2 docs/cli-reference.md doctor section lists the 25 rows in roster order
- [ ] #3 npm test passes; lint clean
<!-- AC:END -->
