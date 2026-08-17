---
id: APRV-67
title: 'Adapter contract: the token-gated executor interface and its conformance suite'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-17 21:39'
updated_date: '2026-08-17 22:14'
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
- [x] #1 Adapter interface and mock adapter exist; conformance suite asserts token verify+consume via core, payload-mismatch refusal, idempotency refusal, execution.started before act and completed/failed after, no credential in any log or output
- [x] #2 The shared executor path is factored so approval run and adapters use one implementation
- [x] #3 Adapter refusal codes are an additive pinned union; SPEC 10.4 names the interface
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, isolated worktree from main. 2. src/adapters/contract.ts: Adapter interface (name, classes it serves, execute(request) -> result) where request = {actionKey, token, payload bytes, actor, log/policy paths}; the contract module (not the adapter) performs the gate sequence around adapter.act: startExecution (which verifies+consumes the token via core, refusing payload-mismatch after recomputing the hash from the bytes handed to the adapter), then adapter.act(payload, credentials-provider), then finishExecution with completed/failed. Adapters never call token or log functions themselves; the contract does, so the sequence is one implementation for run and adapters (approval run keeps startExecution/finishExecution; document that both are callers of the same core path). 3. Credential seam: a CredentialProvider interface (get(name) -> secret) handed to act only inside the verified-token window; the mock provider for tests; APRV-68 implements the vault one. 4. Adapter refusal codes additive pinned union. 5. src/adapters/conformance.ts + tests: runAdapterConformance(t, factory, harness) asserting token verify+consume via core, payload-mismatch before act, idempotency refusal (second spend), execution.started before act observed by a spy, completed/failed after, no credential in any log line or output, act never invoked when refused. Mock adapter under tests. 6. SPEC 10.4 interface sentence drafted for review. PR, auto-merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR #31. Adapter = one method act over (payload the grant bound to, credential provider scoped to the call). The CONTRACT owns the sequence: recompute payload hash from the bytes handed in (presentedPayloadHash from options is deliberately ignored, pinned) -> class check against the verified log via findDeclaration BEFORE startExecution (a misroute appends nothing, spends no token) -> startExecution (existing core path; already takes presentedPayloadHash so no extension needed; verifies+consumes the token, refuses payload-mismatch/token-consumed/etc, appends execution.started) -> act -> finishExecution completed/failed. Credentials reach act only inside the token window: the provider is a closure over a boolean that refuses credential-window-closed after act returns (third code, deliberately distinct from credential-refused: asking at the wrong time is an adapter defect, not a vault verdict; flagged). Redaction as mechanism (invariant 3): every value the provider handed out is scanned for in the adapter code/message/detail (JSON walk incl. keys), replaced with [redacted], and counted in the result so a hit is never silent; replace-not-refuse because the side effect already happened and misreporting reality is worse; empty secrets skipped. Structural backstop: finishExecution writes only exit_code, so nothing adapter-authored reaches the log at all. Thrown errors: error.message only (stacks quote call args), recorded as execution.failed exit_code 1 (never a fabricated exit number: exit_code in the log means an observed process code); the returned code (adapter-act-threw vs adapter-failed) carries the distinction. REVIEWER-WEIGH: the log alone cannot distinguish a throw from a reported failure. approval run untouched (two callers of one core path; making run an adapter would change stdio/exit transparency; follow-up if someone holds behavior byte-identical). ADAPTER_REFUSAL_CODES = EXECUTE codes + adapter-class-mismatch, payload-unhashable (payloadHash throws on cycles/NaN; contract must never throw), adapter-failed, adapter-act-threw; pinned. CREDENTIAL_REFUSAL_CODES = unavailable, refused, window-closed. Failure to record after a successful act returns the core refusal with acted:true and leaves an honest dangling execution for approval execution resolve. Conformance suite (7 checks on fresh real grants, verify after each) mirrors channels/conformance; watched go RED against two broken adapters. SPEC 10.4 paragraph drafted for human review. Two verified reads (class check + startExecution) deliberate: core must not trust a caller snapshot. 1248 tests (+20).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Adapter contract: the token-gated executor sequence owned by the contract, credentials scoped to the verified-token window, mechanical redaction of adapter output, additive pinned refusal unions, conformance suite. SPEC 10.4 names the interface. PR #31, 1248 tests.
<!-- SECTION:FINAL_SUMMARY:END -->
