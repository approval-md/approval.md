---
id: APRV-58
title: Policy knob for the gate-ts skew threshold
status: To Do
assignee: []
created_date: '2026-08-17 15:51'
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
