---
id: APRV-251
title: >-
  execution.completed carries the provider reference: AgentMail message_id
  on-chain so coverage joins by id, not by window
status: To Do
assignee: []
created_date: '2026-09-04 21:13'
labels: []
dependencies:
  - APRV-245
references:
  - src/adapters/agentmail.ts
  - src/core/coverage.ts
priority: medium
ordinal: 196000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-245 joins AgentMail sent messages to verified records by class and time window, because the message_id the adapter receives on send lands only in the CLI result (the receipt detail), never in the execution.completed record, which carries exit_code alone. An id-level join is stronger: it names the exact message a grant produced and makes a same-class send inside the window distinguishable from the gated one. This is a schema change (SPEC 8 event payloads, schema/), so it is its own task: an optional `provider_ref` object on execution.completed (adapter name plus an opaque id), written by the adapter contract from the act detail, validated at the write boundary, redacted like the rest of the detail, and read by the coverage join as exact evidence ahead of the window rule. No existing record changes; readers treat absence as the pre-amendment behaviour.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 SPEC.md 8 amendment marked pending sign-off: execution.completed MAY carry provider_ref {adapter, id}; the schema in schema/ admits it and rejects other shapes
- [ ] #2 executeThroughAdapter writes provider_ref when the adapter detail names one, through the same redaction sweep as the detail
- [ ] #3 The AgentMail adapter surfaces message_id as the provider reference for direct and draft sends; the mock and conformance suite cover it
- [ ] #4 src/core/coverage.ts prefers an exact provider_ref match as evidence and reports it distinctly from the class-and-window match; docs/cli-reference.md coverage section updated
- [ ] #5 npm test, lint, typecheck pass
<!-- AC:END -->
