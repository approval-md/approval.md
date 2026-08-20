---
id: APRV-123
title: 'Invariant: a gate verdict whose event cannot be appended is a refusal'
status: To Do
assignee: []
created_date: '2026-08-20 14:48'
labels:
  - gate
  - invariants
  - emilia-review
dependencies: []
priority: medium
ordinal: 115000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Emilia states it as doctrine: an evidence-log write failure downgrades an allow into a refusal ("never authorize an action we cannot account for"), enforced at the boundary so the mutation is blocked when the event write fails. Our compare-and-append discipline (§11.1 invariant 5) very likely gives us this implicitly on every current path, but nothing states it, no test injects an append failure to prove it, and a future path that computes a verdict before appending could return the allow while the append fails without violating any pinned invariant.

Outcome: the property is promoted to a §11.1 global invariant with its own pinned test file, per the CLAUDE.md rule that new cross-cutting safety properties are added to §11 and to the CLAUDE.md list rather than living in one task. Tests inject append failure (lock contention, disk error, schema refusal at the write boundary) at each gate surface that returns proceed:true or mints a token (request admission of supervised/autonomous classes, grant recording, token minting, approval run, the hook allow path) and assert the caller receives a refusal with a stable machine-readable code, never a success whose event is missing. Audit the existing surfaces for any compute-verdict-then-append ordering and fix what is found.

SPEC §11.1 and the CLAUDE.md invariant list both gain the entry (CLAUDE.md is policy.edit: the task delivers the proposed wording and the human commits it). Touches §11.1 invariants 5 and 6 by construction; implementation notes must say so.

Reference: emiliaprotocol/emilia-protocol packages/gate/src/index.ts (allow downgraded to refusal with reason evidence_log_failed), lib/handshake/events.js requireHandshakeEvent (event written before the state change; failed append blocks the mutation).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Fault-injection tests exist for every surface returning proceed:true or minting a token, asserting refusal with a stable code when the append fails; the code joins a pinned union
- [ ] #2 No gate surface returns success before its event is durably appended (ordering audited; any violation found is fixed in this task)
- [ ] #3 SPEC §11.1 gains the invariant naming its test file, marked for human sign-off; proposed CLAUDE.md list line delivered for the human to commit
- [ ] #4 npm test passes; lint clean
<!-- AC:END -->
