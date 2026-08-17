---
id: APRV-67
title: 'Adapter contract: the token-gated executor interface and its conformance suite'
status: To Do
assignee: []
created_date: '2026-08-17 21:39'
labels: []
milestone: m-9
dependencies: []
priority: high
type: feature
ordinal: 66000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC 10.4 names adapters as the hard boundary (hold credentials, refuse without a valid single-use token bound to idempotency_key and payload_hash) but defines no interface. This task defines it, the way APRV-21/22 defined the channel contract before any channel was built: an Adapter exposes execute(request) where request carries action_key, token, payload (bytes or reference), and identity; the adapter MUST verify and consume the token through core/token (never re-implement), recompute the payload hash from the bytes it is about to act on and refuse payload-mismatch, refuse a repeated idempotency_key (chain-native via consumed tokens), append execution.started before acting and execution.completed/failed after (through the real gate paths that approval run already uses; factor the shared executor out of cli/execute or core/execute rather than duplicate). Credentials are held by the adapter process only, never passed in the request, never logged. Ship a conformance suite (tests/adapters-contract.test.ts + a mock adapter) asserting every MUST, mirroring channels/conformance.ts, so the email adapter and every later one is checked by the same code. Design decisions to settle and record: in-process library vs separate process; how an adapter is invoked by approval run or by the daemon; the refusal-code union for adapters (additive, pinned). SPEC 10.4 gains the interface sentence(s) same-commit, drafted for review.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Adapter interface and mock adapter exist; conformance suite asserts token verify+consume via core, payload-mismatch refusal, idempotency refusal, execution.started before act and completed/failed after, no credential in any log or output
- [ ] #2 The shared executor path is factored so approval run and adapters use one implementation
- [ ] #3 Adapter refusal codes are an additive pinned union; SPEC 10.4 names the interface
<!-- AC:END -->
