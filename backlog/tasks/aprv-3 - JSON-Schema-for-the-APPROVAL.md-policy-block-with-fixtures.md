---
id: APRV-3
title: 'JSON Schema for the APPROVAL.md policy block, with fixtures'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-04 21:45'
updated_date: '2026-08-04 23:08'
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
- [x] #1 schema/policy.schema.json validates the canonical example from SPEC.md section 5.1, included verbatim as a valid fixture
- [x] #2 Valid fixtures cover: minimal policy (version + defaults only), per-class approvers and limits, wildcard class keys (`read.*`, single-segment `*`), and global budgets
- [x] #3 Invalid fixtures are rejected for at least: unknown autonomy level, missing version, negative or non-numeric budget limits, and supervised_sample_rate outside 0..1
- [x] #4 All fixtures run through the APRV-2 harness in the test suite and `npm test` passes
- [x] #5 Field-by-field constraints are documented (in the schema descriptions or an accompanying doc) with references back to SPEC.md section 5
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. schema/policy.schema.json, draft 2020-12, $id https://approval.md/schema/policy.schema.json, strict-compatible with the APRV-2 harness (compiles under Ajv strict:true).
2. Cover SPEC section 5.1 shape: version (required), defaults (autonomy enum manual|supervised|autonomous, channel, approval_ttl duration string, on_expiry), approvers map, classes map keyed by dotted class patterns incl. wildcards (patternProperties), per-class {autonomy, approvers, limits}, budgets, audit.supervised_sample_rate 0..1, channels. additionalProperties: false at every level the spec closes.
3. Fixtures via the APRV-2 convention (schema/fixtures/policy/{valid,invalid}): canonical 5.1 example verbatim, minimal policy, per-class approvers+limits, wildcard keys, global budgets; invalid: unknown autonomy, missing version, negative/non-numeric limits, sample_rate out of range.
4. Constraints documented in schema description fields with SPEC section 5 references.
5. Opus subagent implements in isolated worktree; fable reviews, merges, verifies gates, finalizes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent in isolated worktree; fable review found nothing to override. Ambiguities resolved fail-closed and documented in schema descriptions: on_expiry enum closed to ["reject"] (widening = spec amendment); approval_ttl/durations as ^[1-9][0-9]*(ms|s|m|h|d|w)$ (no compound/fractional forms); class-key grammar enforced via propertyNames+patternProperties (interior * allowed, e.g. calendar.*.own); one class-rule shape with autonomy required; limit names open but values strictly positive; unknown channel names accepted as bare objects so a third-party transport cannot invalidate the whole policy. 5 valid + 14 invalid fixtures; canonical.json is the SPEC 5.1 example translated 1:1. Verified on the merged M0 tree: npm test 102/102, lint and typecheck clean, from wiped node_modules/dist.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
schema/policy.schema.json (draft 2020-12, Ajv-strict-clean, every constraint documented with SPEC section 5 citations) plus 19 fixtures through the APRV-2 harness, including the canonical 5.1 example verbatim. Verified: 102/102 tests, lint, typecheck all green on the merged tree.
<!-- SECTION:FINAL_SUMMARY:END -->
