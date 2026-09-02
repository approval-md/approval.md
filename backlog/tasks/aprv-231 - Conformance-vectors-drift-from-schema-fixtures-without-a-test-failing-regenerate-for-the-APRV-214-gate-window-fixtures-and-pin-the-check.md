---
id: APRV-231
title: >-
  Conformance vectors drift from schema fixtures without a test failing:
  regenerate for the APRV-214 gate-window fixtures and pin the check
status: To Do
assignee: []
created_date: '2026-09-02 19:18'
labels:
  - conformance
  - test
dependencies: []
priority: medium
ordinal: 186000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the APRV-211 lane on 2026-09-02: APRV-214 (PR #223) added six schema/fixtures/event/* gate-window fixtures without regenerating conformance/vectors/schema-validation.v1.json (the regen script adds about 201 lines), and nothing in npm test fails when fixtures and vectors disagree, so the frozen conformance surface can silently lag the fixtures it is meant to pin. Outcome: the schema-validation vector is regenerated for the 214 fixtures under the documented ritual (manifest version bump), and a test asserts that regenerating the vectors from the current fixtures is a no-op, so any future fixture added without the ritual fails CI with a message naming the regen command. Why: the conformance vectors are the contract other implementations test against; a vector that lags the fixtures is a contract nobody is checking.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 conformance/vectors/schema-validation.v1.json covers every fixture under schema/fixtures/event including the six APRV-214 gate-window fixtures, with the manifest version bumped per the documented ritual
- [ ] #2 A test regenerates the vectors in memory from the current fixtures and fails with the regen command in its message when the committed file differs
- [ ] #3 npm test passes; lint clean
<!-- AC:END -->
