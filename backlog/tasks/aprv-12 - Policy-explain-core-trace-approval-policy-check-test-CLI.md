---
id: APRV-12
title: 'Policy explain: core trace + approval policy check|test CLI'
status: To Do
assignee: []
created_date: '2026-08-05 00:23'
updated_date: '2026-08-05 00:30'
labels: []
milestone: m-2
dependencies:
  - APRV-11
priority: medium
type: feature
ordinal: 12000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC.md section 10.1 ships `approval policy check|test <class>`: explain what policy does with a class. Explainability is what makes fail-closed trustworthy — a human must be able to see why an action routes to manual. Core explain() produces a machine-readable decision trace (candidate rules with specificity, the winner and why it won, applied floors and defaults, final autonomy/approvers/limits); the CLI wraps it under the APRV-9 conventions: frozen exit codes, frozen --json shapes, --help documenting both. The explain trace must also answer honestly when the policy failed to load: the fail-closed manual answer carries explicit provenance (which load failure caused it) so a broken policy is visible, not silently strict.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 explain(policy, class, {reversible?}) returns a machine-readable trace: every candidate rule with its specificity, the winning rule and tie-break reasoning, floor and default applications, and the final resolution
- [ ] #2 `approval policy check <class>` and `approval policy test <class>` both work per SPEC section 10.1; --json shape and exit codes are frozen, documented in --help, and pinned by subprocess tests
- [ ] #3 With a missing or unparseable policy the CLI still answers (manual, fail-closed) and the output carries explicit provenance of the load failure, distinct from a successful parse — covered by tests
- [ ] #4 Exit codes follow the APRV-9 frozen table; any addition is documented in --help and pinned by tests
- [ ] #5 Human-readable output shows the decision path clearly enough that a policy author can see why a class resolves as it does
- [ ] #6 The trace distinguishes three manual provenances as separate machine-readable values: manual-because-matched-rule, manual-because-irreversibility-floor, and manual-because-load-failure (human-mandated; binds the section 7 floor amendment's trace requirement)
<!-- AC:END -->
