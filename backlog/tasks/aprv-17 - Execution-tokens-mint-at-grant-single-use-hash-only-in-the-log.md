---
id: APRV-17
title: 'Execution tokens: mint at grant, single-use, hash-only in the log'
status: To Do
assignee: []
created_date: '2026-08-05 01:00'
labels: []
milestone: m-3
dependencies:
  - APRV-16
priority: high
type: feature
ordinal: 17000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The hard-enforcement primitive (SPEC section 10.4, human-settled point 3, 2026-08-06): a token is minted at grant, is single-use, and is bound to the specific request and its idempotency_key. The log records only the token's hash, never the token itself — possession is proven by presenting a preimage — and consumption is an event, so double-spend detection is chain-native: a second consumption attempt fails the transition check because the first consumption is already in the log. A token dies on execution, on revocation, or when its parent request's TTL lapses; there is no separate token TTL in v0.1. `approval token <action-key>` prints the token for a granted action (SPEC 10.1). Any SPEC section 10.4 clarification needed lands same-commit with drafted wording flagged for review.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Grant mints a cryptographically random single-use token bound to (request, idempotency_key); the log carries only its SHA-256, proven by a test scanning appended events for the raw token
- [ ] #2 verifyToken(presented, log) accepts exactly the unconsumed, unrevoked, unexpired granted token for that action and nothing else: wrong token, consumed token, revoked request, and TTL-lapsed parent each refuse with distinct machine-readable reasons
- [ ] #3 Consumption is a log event; a second consumption of the same token or a second execution under the same idempotency_key is refused at the write boundary (chain-native double-spend), covered by tests
- [ ] #4 Token death is complete: execution, revocation, and parent-request TTL each kill the token, each covered by a test; no separate token TTL exists
- [ ] #5 `approval token <action-key>` prints the token only for a granted, live action, refusing otherwise per the frozen exit-code conventions; the token is never logged by the CLI path either
<!-- AC:END -->
