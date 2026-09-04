---
id: APRV-220.1
title: 'Event schema: the log.checkpoint record'
status: To Do
assignee: []
created_date: '2026-09-04 23:57'
labels:
  - core
  - log
  - schema
dependencies: []
references:
  - APRV-220
parent_task_id: APRV-220
type: enhancement
ordinal: 195000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The write-boundary half of APRV-220, split out because a schema change is its own task (CLAUDE.md). Add `log.checkpoint` to the closed event-type enum in src/core/log.ts and schema/event.schema.json, with a conditional block that requires a `^human:` actor (the same rule gate.opened carries: this is a human's signature, and an agent able to author one could vouch for a chain it wrote) and a payload of {seq, hash, alg, key_sha256, signature}. key_sha256 is a HINT and never the authority: the verifier looks the public key up in the policy, so a record naming a key nobody lists is a refusal rather than a self-signed pass. Fixtures both ways, and the event-schema and fixtures tests carry it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 log.checkpoint is in the EventType union and in event.schema.json's enum, and the enum description says what it is
- [ ] #2 The conditional block requires ^human: actor and the five payload fields with their formats; a record missing any of them fails at the write boundary
- [ ] #3 schema/fixtures/event/valid and /invalid gain cases (well-formed; agent actor; missing signature; malformed hash), and tests/event-schema.test.ts covers them
<!-- AC:END -->
