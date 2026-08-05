---
id: APRV-17
title: 'Execution tokens: mint at grant, single-use, hash-only in the log'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 01:00'
updated_date: '2026-08-05 15:31'
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
The hard-enforcement primitive (SPEC section 10.4, human-settled point 3, 2026-08-05): a token is minted at grant, is single-use, and is bound to the specific request and its idempotency_key. The log records only the token's hash, never the token itself — possession is proven by presenting a preimage — and consumption is an event, so double-spend detection is chain-native: a second consumption attempt fails the transition check because the first consumption is already in the log. A token dies on execution, on revocation, or when its parent request's TTL lapses; there is no separate token TTL in v0.1. `approval token <action-key>` prints the token for a granted action (SPEC 10.1). Any SPEC section 10.4 clarification needed lands same-commit with drafted wording flagged for review.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Grant mints a cryptographically random single-use token bound to (request, idempotency_key); the log carries only its SHA-256, proven by a test scanning appended events for the raw token
- [x] #2 verifyToken(presented, log) accepts exactly the unconsumed, unrevoked, unexpired granted token for that action and nothing else: wrong token, consumed token, revoked request, and TTL-lapsed parent each refuse with distinct machine-readable reasons
- [x] #3 Consumption is a log event; a second consumption of the same token or a second execution under the same idempotency_key is refused at the write boundary (chain-native double-spend), covered by tests
- [x] #4 Token death is complete: execution, revocation, and parent-request TTL each kill the token, each covered by a test; no separate token TTL exists
- [x] #5 `approval token <action-key>` prints the token only for a granted, live action, refusing otherwise per the frozen exit-code conventions; the token is never logged by the CLI path either
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent; fable review found nothing to override. gate.ts integration is 5 small pieces at the documented seam; mint happens only after attestation, transition, and budget checks pass. Raw token never logged — asserted by whole-file and per-line scans after complete flows. Constant-time digest comparison (timingSafeEqual with format guard). Strictness calls accepted: a grant with no usable token_sha256 authorizes nothing (pre-token grants fail closed as token-mismatch); ANY execution.started on the action key spends it, matching-digest or not (single-use idempotency key per SPEC section 7). Justified signature deviation: verifyToken takes ttlMs — requestState stops applying TTL after a decision lands, so death-by-parent-TTL is only computable with defaults.approval_ttl passed in; keeps the function pure. Design flagged for human review: approval grant prints the raw token ONCE (nothing else can — only the hash exists anywhere); approval token reports status and writes nothing; approval consume is the internal plumbing verb and the only sanctioned appender of execution.started on the manual path, closing APRV-16's flagged gap. Suggested one-line SPEC 10.1 comment fix drafted but NOT applied, awaiting human approval at the M3 report. Two existing frozen-shape tests widened only to require digest == sha256(returned token). Budget double-count guard proven end-to-end (grant+consume = 1 charge). Verified: 576/576, lint, typecheck.

Date corrected in place per the 2026-08-05 human ruling (log-is-authoritative, applied to all APRV-46 findings): prose previously claimed 2026-08-06; this task's own created_date (2026-08-05) is the cited source. The wrong date was orchestrator confabulation, part of the systematic drift reported in APRV-46.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
src/core/token.ts + token/consume CLI and the grant-path mint: single-use tokens bound to request + idempotency_key, hash-only in the log (scan-proven), chain-native double-spend refusal from a fresh log read, death by execution/revocation/parent-TTL with no separate token TTL, constant-time verification. 35 tests. Verified: 576/576, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
