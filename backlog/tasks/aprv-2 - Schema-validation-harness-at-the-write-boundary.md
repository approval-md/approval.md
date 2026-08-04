---
id: APRV-2
title: Schema validation harness at the write boundary
status: To Do
assignee: []
created_date: '2026-08-04 21:45'
updated_date: '2026-08-04 21:56'
labels: []
milestone: m-0
dependencies:
  - APRV-1
priority: high
type: feature
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC.md section 8 requires every event and envelope to validate against a JSON Schema before append — "validation at the write boundary is itself a control." The three schema families (policy, envelope, events) all need the same infrastructure: a deterministic validator that loads JSON Schemas from `schema/`, returns structured pass/fail results, and a fixture-driven test convention (valid fixtures must pass, invalid fixtures must fail with a reason). Building this once, before the schemas themselves, lets the policy/envelope/event schema tasks proceed independently and guarantees they are all enforced the same way. Fail-closed applies: an unloadable or unparseable schema must reject the document, never pass it. Note: the choice of validation library (e.g. ajv) is a new dependency and needs human approval before install.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A `validate(schemaId, document)` core function loads schemas from `schema/` and returns a deterministic pass/fail result with machine-readable error details
- [ ] #2 A missing, unreadable, or invalid schema file causes validation to fail (fail closed), covered by a test
- [ ] #3 The harness itself is pure and deterministic: no network access, no LLM involvement, same input always yields the same result
- [ ] #4 Tests cover at least one passing and one failing document against a sample schema
- [ ] #5 The fixture convention requires every schema to ship both valid and invalid fixtures: the test suite automatically discovers fixtures per schema, asserts valid ones pass and invalid ones are rejected (with a reason), and fails loudly for any schema that has zero invalid fixtures — proving inputs are rejected is as load-bearing as proving they pass
<!-- AC:END -->
