---
id: APRV-231
title: >-
  Conformance vectors drift from schema fixtures without a test failing:
  regenerate for the APRV-214 gate-window fixtures and pin the check
status: In Progress
assignee:
  - 'agent:opus-lane-h'
created_date: '2026-09-02 19:18'
updated_date: '2026-09-05 08:15'
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

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Refactor scripts/regen-conformance-vectors.mjs: the authored inputs stay module-level; the schema suite's vectors become a function of a fixtures root; export generateConformance({ fixturesRoot }) returning the bytes of every vector file and of the manifest, writing nothing and printing nothing; the CLI entry (guarded on import.meta.url === argv[1]) keeps the writing and the log lines. conformance/run.mjs is untouched.
2. Add tests/conformance-regen.test.ts: regenerate in memory from the current fixtures and compare with the committed files and manifest digests. vectors_version is excluded from the comparison (a fixture change needs a human-chosen bump, per the ritual in conformance/README.md), except that content drift under an UNCHANGED version is reported distinctly. Every failure message names 'node scripts/regen-conformance-vectors.mjs'.
3. Cover both drift directions: a fixture added without a regen (generate from a scratch copy of schema/fixtures carrying one extra fixture, assert the drift is reported and names the new vector), and a vector edited by hand (compare the real generation with a mutated snapshot of the committed bytes).
4. AC1 is already delivered: APRV-235's merge (PR #266) regenerated schema-validation to 1.6.0 with the six APRV-214 gate fixtures. Check it on that evidence with a note.
5. npm test green, npx oxlint clean, node conformance/run.mjs still exits 0.
<!-- SECTION:PLAN:END -->

## Comments

<!-- COMMENTS:BEGIN -->
author: @fable
created: 2026-09-02 22:04
---
APRV-237's conformance regen (branch claude/approval-signals-human-values-f0cf71) swept in the six APRV-214 gate fixtures this task names, so the drift half is fixed there. The 'pin the check' half (a test that fails when schema fixtures and schema-validation.v1.json disagree) is still open and stays with this task.
---
<!-- COMMENTS:END -->
