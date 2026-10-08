---
id: APRV-2
title: Schema validation harness at the write boundary
status: Done
assignee:
  - '@fable'
created_date: '2026-08-04 21:45'
updated_date: '2026-08-04 23:01'
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
- [x] #1 A `validate(schemaId, document)` core function loads schemas from `schema/` and returns a deterministic pass/fail result with machine-readable error details
- [x] #2 A missing, unreadable, or invalid schema file causes validation to fail (fail closed), covered by a test
- [x] #3 The harness itself is pure and deterministic: no network access, no LLM involvement, same input always yields the same result
- [x] #4 Tests cover at least one passing and one failing document against a sample schema
- [x] #5 The fixture convention requires every schema to ship both valid and invalid fixtures: the test suite automatically discovers fixtures per schema, asserts valid ones pass and invalid ones are rejected (with a reason), and fails loudly for any schema that has zero invalid fixtures — proving inputs are rejected is as load-bearing as proving they pass
- [x] #6 Validator is ajv + ajv-formats, pinned to exact versions, configured with strict mode on, draft 2020-12 dialect, and format validation actually enforced (a syntactically invalid date-time string is rejected, proven by a test) — any 2020-12 quirk requiring a workaround is documented in the harness, never silently downgraded
- [x] #7 A harness test proves fail-closed at the validator-config level: a sample record schema rejects a document carrying an unknown extra top-level field
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Install ajv + ajv-formats as the first runtime dependencies, exact-pinned (human-approved 2026-08-04 with conditions recorded as ACs 6-7).
2. src/core/validate.ts: load *.schema.json from schema/ by $id, compile once with Ajv2020 (strict: true, validateFormats: true, allErrors: true), return {ok} | {ok: false, errors} with instancePath/keyword/message; any load/compile failure returns a validation failure (fail closed), never a pass.
3. Fixture convention: tests discover schema/fixtures/<schema-name>/valid/*.json and invalid/*.json; every valid file must pass, every invalid file must fail with at least one error; suite fails loudly if a schema under schema/ has no fixture dir or zero invalid fixtures.
4. Sample schema under schema/ (e.g. sample-record.schema.json with additionalProperties: false and a date-time field) plus fixtures to exercise the harness end to end, including the unknown-top-level-field rejection and bad date-time rejection tests.
5. Determinism: pure function of (schemas on disk, document); no network, no clock, no randomness; same-input-same-output covered by a test.
6. Opus subagent implements; fable reviews diff, re-verifies npm test / lint / typecheck from clean, finalizes, commits, merges to main, pushes (standing cadence).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Runtime dependencies (first in the project, human-approved 2026-08-04 with exact pins): ajv@8.20.0 (draft 2020-12 validator, strict:true, allErrors, validateFormats:true), ajv-formats@3.0.1 (enforced date-time and friends; without it validateFormats has nothing to enforce).
NodeNext/CJS interop quirks, documented in validate.ts header (no strict flag relaxed, no dialect downgrade): (1) ajv 8.20 ships no exports map, so the 2020-12 class is deep-imported as { Ajv2020 } from "ajv/dist/2020.js"; (2) ajv-formats is CJS with ESM-shaped types, narrowed once via its .default property.
Design: validate(schemaId, doc, {schemaDir?}) fails closed on every path (missing dir, unreadable/unparseable/corrupt schema, unknown id, compile failure, ajv throw) with harness pseudo-keywords in errors; schemas re-read and re-compiled per call for history-independence (performance revisit deferred to APRV-6 if the write path needs it); one corrupt sibling schema fails the whole load since a partial set could drop a $ref target. Fixture convention: schema/fixtures/<name>/{valid,invalid}/*.json auto-discovered; suite fails loudly on zero valid or zero invalid fixtures (verified by negative control with a fixtureless schema). Implemented by Opus subagent; fable review found nothing to override.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Built the write-boundary validation harness: src/core/validate.ts (Ajv 2020-12, strict, formats enforced, fail-closed on all load/compile/run paths), fixture auto-discovery in tests/fixtures.test.ts with a loud failure for any schema lacking invalid fixtures, sample-record schema + 6 fixtures proving unknown-top-level-field rejection and invalid date-time rejection. Verified from wiped node_modules/dist: npm install, npm test (26/26), npm run lint, npm run typecheck all exit 0.
<!-- SECTION:FINAL_SUMMARY:END -->
