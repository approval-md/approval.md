---
id: APRV-378
title: >-
  Audit event for a question the gate exists to ask being answered by something
  else, starting with the Codex auto-reviewer
status: To Do
assignee: []
created_date: '2026-09-19 14:06'
updated_date: '2026-09-19 14:06'
labels:
  - audit
  - schema
  - codex
  - bridge
dependencies:
  - APRV-364
priority: medium
ordinal: 293000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Split out of APRV-364 on the orchestrator ruling (2026-09-19, option a). APRV-364 AC2 asked for an audit record when an autoApprovalReview notification arrives mid-session, and no event type fits: audit.dark_session is the sweep, audit.decision_refused is a human gesture the gate would not take, and audit.gesture_refused (APRV-355) is a gesture that is not a decision. The fact with no record is a DIFFERENT one, and it is the one this project most wants written down: something other than the gate answered a question the gate exists to ask.

The Codex app-server auto-reviewer is the first instance (docs/codex-app-server-bridge.md, question 3): a server-side reviewer can resolve an approval with a model call before approval codex bridge sees the request, and tells the client afterwards through an item/autoApprovalReview notification. Zero were observed on 2026-09-18 under the operator configuration, which says nothing about other configurations. Under APRV-364 the bridge STOPS on such a notification and reports it; this task is what makes the stop leave a trace in the log.

Name it so it can carry the next instance as well as this one (for example audit.question_preempted, with a closed source enum whose first member is the Codex auto-reviewer). It authorizes nothing, no enforcement path reads it, and the actor is system: for the reason audit.dark_session and audit.decision_refused both give: a record of an event authored by either party to it is a record neither party can be held to.

SHAPE, from APRV-355 which did exactly this on 2026-09-19: one event type, the schema enum, an if/then block, the union and header count in src/core/log.ts, conformance vectors for the valid record and the invalid shapes, one SPEC section 8 bullet in ONE commit that no later commit touches, and a records advance before the protected-path guard can pass.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A new audit-tier event type for a question answered by something other than the gate is defined in schema/event.schema.json and in one SPEC section 8 bullet, validated at the write boundary, carrying a closed source enum (first member: the Codex app-server auto-reviewer), the question it answered as the server identified it, and the verdict that other party reached, with a system: actor required
- [ ] #2 approval codex bridge appends exactly one such record when an autoApprovalReview notification arrives, through the real append path, and appends none in a session where no such notification arrives; tests drive the real CLI against the stub server
- [ ] #3 No enforcement path reads the record (a test or a module-graph assertion pins that), it is visible in approval log tail and approval log export, and docs/cli-reference.md describes it where the other audit records are described
- [ ] #4 Conformance vectors cover the valid record and at least two invalid shapes; build, typecheck, lint, the schema, bridge and log suites pass, and the SPEC amendment is called out in the PR
<!-- AC:END -->
