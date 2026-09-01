---
id: APRV-173
title: 'Enforce intake limits: queue-full and rate-limited at request intake'
status: To Do
assignee: []
created_date: '2026-08-31 01:15'
labels:
  - core
  - gate
dependencies: []
ordinal: 152000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Closes the SPEC 5.2 deferred-enforcement gap: limits.max_pending (per class and budgets.global.max_pending) and limits.requests_per_hour are validated policy vocabulary that no runtime reads. New pure module src/core/intake-limits.ts in the budgets.ts style (no I/O, injected evaluationTs, exhaustive tests): pendingCount derives simultaneously-pending from verified records (an approval.requested with no terminal event for its action_key and not TTL-lapsed; withdrawn excluded), class attribution via the winning rule's pattern exactly as budgets attribute; requestsInWindow counts approval.requested by origin over a rolling 1h half-open window. APPROVED SPEC READINGS (Carter, 2026-08-31): origin = the record's actor (runtime-assigned, unspoofable through MCP since --as is appended last; per-guest actors make it per-client) — state in the module header as the v0.1 reading of 'per origin'; refusals are machine-readable only, appending NO new event type (no schema 8 change). Wire into request() in src/core/gate.ts after legality checks (duplicate-request, already-executed) and before budget evaluation: these protect attention, not budget. Add queue-full and rate-limited to GATE_REFUSAL_CODES — a frozen-union addition SPEC 5.2 already promised by name; the notes must flag it and conformance vectors regenerate per the established pattern. Refused requests append nothing and do not count toward the window. Fail closed on malformed limits.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 pendingCount and requestsInWindow deterministic over fixture logs including TTL-lapsed, withdrawn, and terminal-state requests; window edges tested half-open on both sides
- [ ] #2 request() refuses queue-full / rate-limited machine-readably, appends nothing, and refused requests do not consume window or budget
- [ ] #3 Unset limits enforce nothing; malformed limits fail closed with a stated note
- [ ] #4 GATE_REFUSAL_CODES gains both codes with conformance vectors regenerated and version-bumped per the refusal-union rules; implementation notes flag the union change and the origin=actor SPEC reading
<!-- AC:END -->
