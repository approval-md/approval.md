---
id: APRV-58
title: Policy knob for the gate-ts skew threshold
status: In Progress
assignee:
  - '@fable'
created_date: '2026-08-17 15:51'
updated_date: '2026-08-19 15:50'
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
- [ ] #1 audit.skew_tolerance accepted by the policy schema with the duration grammar; absent means 2s
- [ ] #2 verify() reads the configured value; anomalies stay report-only
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Same builder as APRV-57, second commit. 2. audit.skew_tolerance in the policy schema with the duration grammar (reuse the approval_ttl parser); absent means the 2s constant. 3. verify() reads the configured value; anomalies stay report-only; bad duration fails policy load (fail closed). 4. Fixtures both ways. 5. SPEC 8 sentence amended to name the key and default, flagged to the human. 6. PR by branch, auto-merge; records here.
<!-- SECTION:PLAN:END -->
