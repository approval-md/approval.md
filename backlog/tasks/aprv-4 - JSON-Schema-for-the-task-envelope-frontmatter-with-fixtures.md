---
id: APRV-4
title: 'JSON Schema for the task envelope frontmatter, with fixtures'
status: To Do
assignee: []
created_date: '2026-08-04 21:45'
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
- [ ] #1 schema/envelope.schema.json validates the canonical example envelope from SPEC.md section 6.1, included verbatim as a valid fixture
- [ ] #2 MUST fields per section 6.2 are enforced: origin.app, origin.created_by, state; and for each entry in actions[]: class and idempotency_key
- [ ] #3 `state` is constrained to exactly the seven lifecycle values in section 6.3, and an invalid fixture with an unknown state is rejected
- [ ] #4 Invalid fixtures are rejected for at least: malformed created_by (not `human:<id>` or `agent:<id>`), route.confidence outside 0..1, and an action missing idempotency_key
- [ ] #5 A valid fixture exists for a minimal envelope with no actions and no budget (a task that cannot request execution, per section 6)
- [ ] #6 All fixtures run through the APRV-2 harness in the test suite and `npm test` passes
<!-- AC:END -->
