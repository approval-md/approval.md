---
id: APRV-56
title: 'Event schema: audit.reviewed requires a human: actor'
status: To Do
assignee: []
created_date: '2026-08-17 15:51'
labels: []
dependencies: []
priority: medium
type: chore
ordinal: 55000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-40 enforces in core that approval audit review is human-only, but schema/event.schema.json carries no per-type conditional for audit.reviewed the way it does for approval.granted. Validation at the write boundary is itself a control (SPEC 8), so the schema should say what core enforces. Additive conditional plus valid and invalid fixtures.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 event.schema.json requires actor matching ^human: on audit.reviewed
- [ ] #2 Fixtures both ways; frozen-shape suites updated additively
<!-- AC:END -->
