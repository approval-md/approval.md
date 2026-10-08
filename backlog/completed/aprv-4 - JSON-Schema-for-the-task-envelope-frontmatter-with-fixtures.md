---
id: APRV-4
title: 'JSON Schema for the task envelope frontmatter, with fixtures'
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
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The `approval:` frontmatter key (SPEC.md section 6) is the side-effect declaration this whole project exists to review, so its shape must be pinned down before the gate (M3) or Backlog.md round-trip (M6) can be built. This task defines `schema/envelope.schema.json` covering section 6.2: `origin` (app, created_by as `human:<id>`/`agent:<id>`), `route` (assignee, confidence 0.0-1.0, rationale), `state` (exactly the section 6.3 lifecycle values: proposed, awaiting, approved, executed, rejected, expired, revoked), `actions[]` (class, summary, reversible, est_cost_usd, idempotency_key — with class and idempotency_key required per action), and optional `budget`. Scope is the `approval:` key only — sibling Backlog.md frontmatter (id, title, status) is out of scope, as is any file rewriting or round-trip logic (M6).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 schema/envelope.schema.json validates the canonical example envelope from SPEC.md section 6.1, included verbatim as a valid fixture
- [x] #2 MUST fields per section 6.2 are enforced: origin.app, origin.created_by, state; and for each entry in actions[]: class and idempotency_key
- [x] #3 `state` is constrained to exactly the seven lifecycle values in section 6.3, and an invalid fixture with an unknown state is rejected
- [x] #4 Invalid fixtures are rejected for at least: malformed created_by (not `human:<id>` or `agent:<id>`), route.confidence outside 0..1, and an action missing idempotency_key
- [x] #5 A valid fixture exists for a minimal envelope with no actions and no budget (a task that cannot request execution, per section 6)
- [x] #6 All fixtures run through the APRV-2 harness in the test suite and `npm test` passes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. schema/envelope.schema.json, draft 2020-12, $id https://approval.md/schema/envelope.schema.json, validating the value of the approval: frontmatter key only.
2. Cover SPEC section 6.2: origin{app, created_by pattern ^(human|agent):.+}, route{assignee, confidence 0..1, rationale}, state enum of the seven 6.3 values, actions[] items{class, summary, reversible, est_cost_usd, idempotency_key; require class+idempotency_key}, budget{max_cost_usd, max_latency}. Required: origin, state. additionalProperties: false.
3. Fixtures via APRV-2 convention (schema/fixtures/envelope): canonical 6.1 envelope verbatim, minimal no-actions envelope; invalid: malformed created_by, confidence out of range, action missing idempotency_key, unknown state.
4. Opus subagent implements in isolated worktree; fable reviews, merges, verifies gates, finalizes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent in isolated worktree; fable review found nothing to override. Modeling decisions (documented in schema descriptions): assignee ^(human|agent:.+)$ vs created_by ^(human|agent):.+ — exactly as SPEC 6.2 words them, asymmetry deliberate; actions[] optional (MUST only for execution; per-item required = class + idempotency_key, with summary/reversible/est_cost_usd left to the token path in M3); class grammar ^[a-z0-9_-]+(\.[a-z0-9_-]+)*$; max_latency ^[0-9]+(ms|s|m|h|d)$; route.rationale kept (present in 6.1 example though absent from the 6.2 table); no state-transition constraints in the schema since state is a log projection. 4 valid + 10 invalid fixtures incl. canonical 6.1 envelope verbatim. Verified on the merged M0 tree: npm test 102/102, lint and typecheck clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
schema/envelope.schema.json validating the approval: frontmatter value per SPEC section 6 (seven-state enum, MUST fields enforced, additionalProperties closed) plus 14 fixtures through the APRV-2 harness including the canonical 6.1 example and a minimal no-actions envelope. Verified: 102/102 tests, lint, typecheck green on the merged tree.
<!-- SECTION:FINAL_SUMMARY:END -->
