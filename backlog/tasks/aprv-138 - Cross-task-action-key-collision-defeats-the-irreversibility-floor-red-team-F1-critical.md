---
id: APRV-138
title: >-
  Cross-task action-key collision defeats the irreversibility floor (red-team
  F1, critical)
status: In Progress
assignee: []
created_date: '2026-08-25 13:40'
updated_date: '2026-08-25 17:51'
labels:
  - security
  - gate
  - cleanroom-review
dependencies: []
references:
  - ../approval-md-redteam (findings-report.md
  - F1)
  - src/core/gate.ts
  - src/core/execute.ts
  - src/core/policy-match.ts
  - src/core/audit.ts
  - src/adapters/contract.ts
priority: high
type: bug
ordinal: 125000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
CONFIRMED critical gate bypass found by the red-team review of the runtime export and independently verified against source.

Root cause: an action idempotency_key is free-form (schema/envelope.schema.json: string minLength 1), not derived from content or scoped to a task. register (src/core/gate.ts ~749-756) dedupes only by task id, so the same key can be declared under two task ids with different class and reversible. findDeclaration (src/core/execute.ts ~325-355) then resolves a key globally, last-registration-wins, unscoped by task (its comment says the later declaration governs). The non-manual execute path feeds the winning record class and reversible into resolve(), and the irreversibility floor (src/core/policy-match.ts ~283-292) fires only when reversible === false. So an agent re-declares an existing key with reversible:true under a new task id and the floor that was forcing manual is disabled; approval run <key> -- <cmd> executes with no token, no human, floorApplied:false.

Fix (both levers, existing refusal codes, fail closed):
Lever a, write boundary: register refuses a task.registered whose action key collides with a key already registered under a different task, reusing task-already-registered (message names the colliding key, prior task, seq). All-or-nothing for multi-action envelopes.
Lever b, execute boundary: findDeclaration fails closed (ambiguity result) when more than one distinct task declares a key; startExecution refuses action-not-registered; audit skips the row; the adapter contract refuses. Deletes last-wins.

Out of scope here (tracked separately as F3): binding payload_hash on the non-manual execute path. This task closes the reversible-flip escalation; the fresh-autonomous-key plus arbitrary-argv hole stays open until F3, pinned by a test.

No frozen refusal-union change, so no SPEC section 11.1 amendment. One SPEC section 7 clarification (an idempotency_key is globally unique across task.registered records; a second declaration under a different task is refused) is flagged for human sign-off.

Backward compat: the committed .approval/log/events.jsonl has zero cross-task key collisions, so neither lever rejects historical records and verify/replay is unaffected.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 register refuses a registration that reuses an idempotency_key already registered under a different task, via task-already-registered, before any append; multi-action envelope with any collision is refused whole
- [x] #2 findDeclaration returns an explicit ambiguity result when more than one distinct task declares a key; startExecution refuses action-not-registered with nothing appended
- [x] #3 audit sampling skips an ambiguous key and the adapter contract refuses it, neither taking last-wins
- [x] #4 Test reproduces the reversible-flip exploit and asserts the second registration is refused
- [x] #5 Test with a pre-existing two-record collision log asserts execute refuses and no floor bypass occurs
- [x] #6 Residual fresh-autonomous-key plus arbitrary-argv behavior is pinned by a test as unchanged, with a comment pointing at the F3 task
- [x] #7 Legitimate cases still work: distinct keys under distinct tasks resolve; same-task re-registration still refuses task-already-registered
- [x] #8 verify and reindex over a collision log still verify; committed log still verifies
- [x] #9 SPEC section 7 clarification on global key uniqueness written and marked for human sign-off
- [x] #10 npm test passes; lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented both levers. Lever a (write boundary): src/core/gate.ts register now hoists actions/incomingKeys above the dedupe loop and, for every prior task.registered under a DIFFERENT task, refuses (task-already-registered) if any of that record's idempotency_keys is in the incoming set. All-or-nothing for multi-action envelopes; returns before append. Lever b (execute boundary): added declaringTasks(records, actionKey) to src/core/execute.ts; startExecution refuses action-not-registered when >1 distinct task declares the key, before findDeclaration. Updated the two other findDeclaration callers to guard the same way: src/core/audit.ts (skip an ambiguous key) and src/adapters/contract.ts (refuse action-not-registered). No frozen refusal-union change (reused task-already-registered and action-not-registered). SPEC section 6.2 idempotency_key row amended to state global uniqueness, marked "(Amended APRV-138, pending sign-off.)" for human review.

Deliberately out of scope (tracked as APRV-140 / F3): binding payload_hash on the non-manual execute path. The reversible-flip escalation is closed; the fresh-autonomous-key + arbitrary-argv hole remains, pinned by the RESIDUAL test in tests/execute.test.ts.

Tests: 3 in tests/gate.test.ts (cross-task reuse incl. floor-flip refused; multi-action partial collision refused whole; distinct key under a different task still admitted) and 3 in tests/execute.test.ts (declaringTasks one-vs-many; startExecution refuses a collision-shadowed key; RESIDUAL F3 pin). Full suite 2035 pass / 0 fail; lint clean. Backward compat: committed .approval/log/events.jsonl has no cross-task key collisions, so neither lever rejects historical records and verify stays clean.
<!-- SECTION:NOTES:END -->
