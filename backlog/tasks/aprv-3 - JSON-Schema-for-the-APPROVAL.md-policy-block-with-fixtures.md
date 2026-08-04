---
id: APRV-3
title: 'JSON Schema for the APPROVAL.md policy block, with fixtures'
status: To Do
assignee: []
created_date: '2026-08-04 21:45'
labels: []
milestone: m-0
dependencies:
  - APRV-2
priority: high
type: feature
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The `yaml approval-policy` block in APPROVAL.md (SPEC.md section 5) is the machine-readable half of the policy file, and M2's policy engine can only fail closed correctly if there is a schema that says precisely what "parseable" means. This task defines `schema/policy.schema.json` covering the full section 5.1 shape — `version`, `defaults` (autonomy, channel, approval_ttl, on_expiry), `approvers`, `classes` (wildcard class keys, per-class autonomy/approvers/limits), `budgets`, `audit.supervised_sample_rate`, `channels` — plus fixtures exercising it through the APRV-2 harness. Autonomy values are exactly `manual`, `supervised`, `autonomous` (section 4). Schema only: no YAML extraction from markdown and no matching semantics here (that is M2).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 schema/policy.schema.json validates the canonical example from SPEC.md section 5.1, included verbatim as a valid fixture
- [ ] #2 Valid fixtures cover: minimal policy (version + defaults only), per-class approvers and limits, wildcard class keys (`read.*`, single-segment `*`), and global budgets
- [ ] #3 Invalid fixtures are rejected for at least: unknown autonomy level, missing version, negative or non-numeric budget limits, and supervised_sample_rate outside 0..1
- [ ] #4 All fixtures run through the APRV-2 harness in the test suite and `npm test` passes
- [ ] #5 Field-by-field constraints are documented (in the schema descriptions or an accompanying doc) with references back to SPEC.md section 5
<!-- AC:END -->
