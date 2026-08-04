---
id: APRV-5
title: 'JSON Schemas for event log records, one per event type, with fixtures'
status: To Do
assignee: []
created_date: '2026-08-04 21:45'
updated_date: '2026-08-04 22:00'
labels: []
milestone: m-0
dependencies:
  - APRV-2
priority: high
type: feature
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The event log is the source of truth (SPEC.md sections 3, 8), and section 8 mandates that events MUST validate against JSON Schemas in `schema/` before append — M1's append path cannot be built until these exist. This task defines a base event-record schema (seq, ts as RFC 3339 UTC, event, task, action_key, actor, channel, payload, prev, hash — matching the section 8 example) plus per-type schemas or payload constraints for all 16 v0.1 event types: task.registered, route.proposed, route.accepted, approval.requested, approval.granted, approval.rejected, approval.expired, approval.revoked, execution.started, execution.completed, execution.failed, budget.exceeded, policy.updated, envelope.drift, audit.sampled, audit.reviewed. Schema shape only — hash computation and chain verification are M1 (the schema constrains format, e.g. hex strings, not correctness of the chain).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A base event schema enforces the common record shape from the SPEC.md section 8 example: seq (positive integer), ts (RFC 3339 timestamp), event (one of the 16 v0.1 types), actor, prev and hash (hex string format; prev nullable/absent only for the first record), payload
- [ ] #2 All 16 v0.1 event types from SPEC.md section 8 are covered, each with at least one valid fixture
- [ ] #3 The example event record from SPEC.md section 8 (approval.granted) validates as a fixture (ellipsized hashes expanded to full length)
- [ ] #4 Invalid fixtures are rejected for at least: unknown event type, missing hash, non-integer seq, and a malformed timestamp
- [ ] #5 Approval and execution event types require the fields that make them meaningful (e.g. approval.granted requires task, action_key, and actor), verified by invalid fixtures
- [ ] #6 All fixtures run through the APRV-2 harness in the test suite and `npm test` passes
- [ ] #7 The base event schema requires an explicit hash-scheme identifier on every record (e.g. `alg: "sha256/jcs"` or an integer schema version), so a future hash or canonicalization migration can coexist in one log; an invalid fixture with the identifier missing, and one with an unknown identifier value, are both rejected
- [ ] #8 SPEC.md section 8 is amended in this task: the example record gains "alg":"sha256/jcs", and the human-approved paragraph defining alg (recorded verbatim in this task) is appended to the section
- [ ] #9 The SPEC.md section 8 amendment and the schema change land in the same commit so they cannot get out of sync
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Human approval recorded in advance (2026-08-04): the SPEC.md section 8 amendment adding the per-record alg identifier was explicitly approved by Carter before implementation, with the exact paragraph text supplied. This is not a silent spec edit.
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-08-04 21:56
---
Heads-up for the human reviewer: requiring an `alg`/version identifier on every record (AC #7) diverges from the SPEC.md section 8 example record, which has no such field. Per CLAUDE.md this needs a SPEC.md section 8 amendment (human-approved, never silent) adding the identifier to the canonical record shape — ideally landed alongside this task.
---

created: 2026-08-04 22:00
---
Approved SPEC.md section 8 amendment — append this paragraph verbatim: "Every record MUST carry an explicit hash-scheme identifier, alg. Version 0.1 defines exactly one value: sha256/jcs, meaning SHA-256 over the RFC 8785 (JCS) canonical serialization of the record with prev included. Verifiers MUST reject records whose alg is missing or unrecognized. Records with different alg values MAY coexist in one log, so a future scheme change is a migration, never a schism." Also add "alg":"sha256/jcs" to the section 8 example record. Spec edit and schema change must be one commit.
---
<!-- COMMENTS:END -->
