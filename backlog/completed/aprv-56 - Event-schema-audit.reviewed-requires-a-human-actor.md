---
id: APRV-56
title: 'Event schema: audit.reviewed requires a human: actor'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-17 15:51'
updated_date: '2026-08-17 19:05'
labels: []
milestone: m-8
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
- [x] #1 event.schema.json requires actor matching ^human: on audit.reviewed
- [x] #2 Fixtures both ways; frozen-shape suites updated additively
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent (combined with 59, one worktree, two commits). 2. event.schema.json: additive if/then requiring actor ^human: on audit.reviewed (mirror the approval.granted rule); valid + invalid fixtures; frozen-shape suites additive. 3. PR, auto-merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build (combined with 59), PR #26, merged. Additive allOf conditional requiring actor ^human: on audit.reviewed, styled on the approval.granted rule, $comment stating the self-review argument; two invalid fixtures (agent and system actors); the existing valid fixture already carried human:carter. No required-field additions, so EXTRA_REQUIRED unchanged.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Schema now says at the write boundary what core enforced: audit.reviewed carries a human: actor. Merged as PR #26.
<!-- SECTION:FINAL_SUMMARY:END -->
