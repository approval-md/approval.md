---
id: APRV-355
title: >-
  Audit event for a refused gesture that is not a decision, so an unmapped
  checkpoint or review tap leaves a record
status: To Do
assignee: []
created_date: '2026-09-17 20:09'
labels:
  - audit
  - schema
  - channels
dependencies: []
priority: low
ordinal: 272000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found while landing APRV-324 (PR #427, 2026-09-17). When the policy maps Telegram senders, an unmapped or unattested-policy tap on a CHECKPOINT signature or a REVIEW is refused and records nothing: the only refusal record today, audit.decision_refused, requires a record-level action_key and a payload.decision of grant, reject or revoke, and a signature or review gesture has neither, so writing one would mean manufacturing both (Lane D declined to, correctly). The cost is that attention spent and an attempt made by an account the operator did not map leave no trace in the log, only a terminal line and a chat answer. Add an audit event type for a refused gesture that is not a decision (name to settle, for example audit.gesture_refused) carrying the gesture kind (checkpoint-signature, review, review-note), the refusal code, the channel, the observed payload.sender, and a human actor only when one was resolved, on the same conditional terms audit.decision_refused uses since APRV-324. It authorizes nothing and no enforcement path reads it. Carter approved filing on 2026-09-18. Related: APRV-324, APRV-235 (audit.decision_refused), APRV-257 (checkpoint tap), APRV-299 (reviews).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A new audit event type for a refused non-decision gesture is defined in schema/event.schema.json and SPEC 8, validated at the write boundary, with the gesture kind and refusal code closed enums, payload.sender optional, and actor required only when no sender is present
- [ ] #2 An unmapped, ambiguous or unattested-policy checkpoint tap and review tap each append exactly one such record and nothing else; a no-mapping policy appends none; tests run through the real append path and the mock Telegram server
- [ ] #3 No enforcement path reads the record (a test or a module-graph assertion pins that), approval audit or approval status can list them, and docs/cli-reference.md describes the record
- [ ] #4 Conformance vectors cover the new event; build, typecheck, lint and the channel and schema suites pass; the SPEC amendment is called out
<!-- AC:END -->
