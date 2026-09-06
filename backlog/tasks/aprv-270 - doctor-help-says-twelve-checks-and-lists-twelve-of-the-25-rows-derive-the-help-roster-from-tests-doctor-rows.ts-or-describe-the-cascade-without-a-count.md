---
id: APRV-270
title: >-
  doctor --help says twelve checks and lists twelve of the 25 rows: derive the
  help roster from tests/doctor-rows.ts or describe the cascade without a count
status: In Progress
assignee:
  - '@opus-doctor'
created_date: '2026-09-05 16:16'
updated_date: '2026-09-06 08:09'
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
- [x] #1 DOCTOR_HELP carries no stale count and stays under the 25-line cap; a test pins that any number of rows it states equals the roster length, or that it states none
- [x] #2 docs/cli-reference.md doctor section lists the 25 rows in roster order
- [ ] #3 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read src/cli/help.ts DOCTOR_HELP, tests/cli-long-help.test.ts, tests/doctor-rows.ts and the docs/cli-reference.md doctor section. 2. Rewrite DOCTOR_HELP's roster paragraph so it carries no count at all: describe the cascade by shape (build, identity, attestation, log and drift, channels, store, sampling, envelopes, vault, environment, harness hooks, evidence sweeps, daemon health, values, checkpoints) and point at docs/cli-reference.md#doctor for the row-by-row list, staying under the 25-line cap. 3. Add a test to tests/cli-long-help.test.ts that scans DOCTOR_HELP for any stated row or check count (digits and number words) and pins each to DOCTOR_ROW_ORDER.length, so a stated count can only be the true one and stating none passes. 4. Bring the docs/cli-reference.md doctor section up to the full roster: add the rows it never gained (log-drift, reconciliation, harness-hook-outcomes, log-advance-cadence, dark-sessions, values-block, checkpoint, gate-organs) and move keychain-scope after harness-hook-wiring so the bullets run in DOCTOR_ROW_ORDER order. 5. Add a test pinning the reference bullets to the roster, every row named in roster order, so the section cannot go stale again. 6. Build, run the doctor, long-help and docs-guard suites, lint and typecheck.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
DOCTOR_HELP's roster paragraph no longer counts anything. It now describes the cascade by shape (the build, identity, the policy, the log, channels, the store, sampling, the vault, the environment, harness hooks, evidence sweeps, daemon health, values, checkpoints) and points at docs/cli-reference.md#doctor for the row-by-row list. The paragraph is still five lines, so the constant is still exactly 25 lines and the cap test's margin is unchanged.

Why no count rather than a derived one: DOCTOR_HELP is a template literal that would have to interpolate DOCTOR_ROW_ORDER.length, and tests/doctor-rows.ts is a TEST module. Importing it from src/cli/help.ts would put a test fixture on the shipped import graph to print a number nobody acts on. The guard goes the other way instead: tests/cli-long-help.test.ts scans the help for any '<n> checks' or '<n> rows' claim, in digits or in words, and pins each to the roster length. Stating none passes; stating the true one passes; stating a stale one fails. 'One row per check' is exempted by a lookahead on 'per', because that is a claim about shape rather than about how many there are, and the self-check in the test asserts all three cases.

The roster is 26 rows, not the 25 the task title says: APRV-272 appended gate-organs after this task was filed. The docs guard already derives the README's counts from DOCTOR_ROW_ORDER.length, so nothing else needed changing.

docs/cli-reference.md's doctor section had drifted further than the help had. It documented 18 of the 26 rows and had keychain-scope before harness-hook-wiring, the reverse of the emitted order. Added: log-drift, reconciliation, harness-hook-outcomes, log-advance-cadence, dark-sessions, values-block, checkpoint, gate-organs, each written from the row's own implementation and rationale in src/cli/doctor.ts; moved keychain-scope after harness-hook-wiring. A second new test reads the section's bold bullets back and deepEquals them against DOCTOR_ROW_ORDER, so an appended row that never gets written up here now fails the suite rather than leaving doctor printing a line the documentation has never heard of.

Touches no global invariant: help text and reference prose only, no runtime behaviour, no schema, no log path.

Validation: npm run build; node --test on cli-long-help (23 pass, 0 fail) and docs-guard (16 pass, 0 fail); the doctor suite green at this state (57 pass); npm run lint and npm run typecheck clean. AC3's 'npm test passes' is left unchecked until a full-suite run lands; the targeted suites above are what has actually been observed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Removed the stale 'Twelve checks' roster from DOCTOR_HELP in favour of a shape description plus a pointer to docs/cli-reference.md#doctor, and pinned the absence with a test that fails on any row count in the help that is not DOCTOR_ROW_ORDER.length. Completed the reference's doctor section to all 26 rows in roster order (eight were missing, two were out of order) and added a test that deepEquals its bullets against the roster. Verified with the cli-long-help (23) and docs-guard (16) suites, the doctor suite (57), lint and typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
