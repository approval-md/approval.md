---
id: APRV-58
title: Policy knob for the gate-ts skew threshold
status: Done
assignee:
  - '@fable'
created_date: '2026-08-17 15:51'
updated_date: '2026-08-19 16:38'
labels: []
dependencies: []
priority: low
type: feature
ordinal: 57000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-40 shipped GATE_TS_SKEW_TOLERANCE_MS = 2000 as a pinned constant (human sign-off: report-only makes the threshold defensible rather than needing to be perfect). SPEC 8 says the allowance is implementation-defined. If operators on high-latency or badly disciplined clocks need a different value, expose it as policy vocabulary (audit.skew_tolerance, standard duration grammar) with the constant as the default. Vocabulary change: schema + SPEC same-commit, fixtures both ways.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 audit.skew_tolerance accepted by the policy schema with the duration grammar; absent means 2s
- [x] #2 verify() reads the configured value; anomalies stay report-only
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Same builder as APRV-57, second commit. 2. audit.skew_tolerance in the policy schema with the duration grammar (reuse the approval_ttl parser); absent means the 2s constant. 3. verify() reads the configured value; anomalies stay report-only; bad duration fails policy load (fail closed). 4. Fixtures both ways. 5. SPEC 8 sentence amended to name the key and default, flagged to the human. 6. PR by branch, auto-merge; records here.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Same builder, second commit, PR #84. audit.skew_tolerance is a $ref to the schema duration def (same grammar and parseDuration as approval_ttl); loadPolicy resolves durations.skewToleranceMs with the same fail-the-whole-policy backstop a bad approval_ttl gets (fail closed). chainAnomalies(records, toleranceMs?) stays pure; verify() gains policy and skewToleranceMs options resolved by exported skewToleranceMsOf, which fails closed to the shipped 2s (not zero: zero would report every healthy fleet). log verify and status pass their policy location. Report-only unchanged and asserted: verdict, exit code and health untouched. Fixtures: policy/valid/skew-tolerance.json (250ms) and policy/invalid/skew-tolerance-compound.json (1s500ms), picked up by the fixtures test. Five anomalies tests: tighten/widen, absent, unloadable, unparseable, report-only through both CLI surfaces, pure path. SPEC EDIT, FLAGGED FOR THE HUMAN: SPEC 8 sentence "The skew allowance is implementation-defined, stated in the implementation, and generous enough that ordinary clock disagreement between hosts is not reported (the reference runtime uses 2 seconds). (Amended APRV-40.)" became "The skew allowance is configured by audit.skew_tolerance, a policy duration in the 5.2 grammar, and MUST be generous enough that ordinary clock disagreement between hosts is not reported; when the key is absent the allowance is the implementation stated default, which in the reference runtime is 2 seconds. Because the allowance governs a report and never a verdict, an operator who widens it hides evidence from a human and permits nothing. (Amended APRV-40, APRV-58.)" The 5.1 canonical example was left alone (it shows only supervised_sample_rate). Schema and SPEC changed in the same commit as the task required. 1818 tests after merging main, lint and typecheck clean.

Merged at 3742d54 (PR #84). SPEC 8 amendment awaits the human's read (flagged in the notes above).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
audit.skew_tolerance policy knob with the duration grammar, default 2s, read by verify(); report-only unchanged; schema, fixtures and SPEC 8 amended in one commit (flagged). PR #84 merged at 3742d54; verified by five anomalies tests and the fixture suite, 1818 tests, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
