---
id: APRV-16
title: 'Gate core: request lifecycle, write-boundary transition enforcement'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 01:00'
updated_date: '2026-08-05 15:31'
labels: []
milestone: m-3
dependencies:
  - APRV-14
  - APRV-15
priority: high
type: feature
ordinal: 16000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The gate itself (SPEC sections 6.3, 10.1, amended 6.3 manual-path rule): derive each request's state purely from the log, and enforce legality at the write boundary — an illegal transition is refused before any byte lands (human-settled point 4, 2026-08-05). Covers intake (`approval register` validating the envelope and appending task.registered; `approval request` appending approval.requested for manual-resolving actions only — supervised/autonomous proceed toward execution with no approval events, per amended section 6.3) and decisions (grant/reject/revoke as human verbs, expire on TTL). TTL is judged from the request's own timestamp: a late grant is refused even if no approval.expired event has been observed yet; expiry events carry a system: actor. Intake and grant both refuse on attestation failure (APRV-15 codes) and budget failure (APRV-14 verdicts, budget.exceeded logged). Refusals are structured results with machine-readable reasons; every state transition appended is schema-valid and every test log is built through the real append path.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Request state (proposed/awaiting/approved/executed/rejected/expired/revoked) is derived purely from the log by a projection function with tests for every reachable path
- [x] #2 Illegal transitions are refused before append, each with a distinct machine-readable reason: grant/reject after expiry (judged from the request's own ts + policy TTL, no approval.expired event required), grant on a rejected/revoked request, second decision on a decided request, execution events without a grant
- [x] #3 `approval request` appends approval.requested only for actions resolving to manual (via the real APRV-11 resolver incl. the irreversibility floor); supervised and autonomous actions emit no approval.* events, per amended section 6.3
- [x] #4 Expiry appends approval.expired with a system: actor and honors defaults.on_expiry; late decisions after TTL are refused with the expiry reason even when the expired event is not yet in the log
- [x] #5 Intake and grant refuse with the APRV-15 attestation codes when the policy is unattested or hash-mismatched, and with a budget refusal (appending budget.exceeded) when APRV-14 verdicts fail — both covered by tests
- [x] #6 CLI verbs register/request/grant/reject/revoke follow the frozen exit-code and --json conventions; grant/reject/revoke are documented as human-only
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent; fable review found nothing to override. 19-code refusal union pinned by test. Accepted decisions: request data comes from the log's task.registered record, never from CLI flags — an agent that could name its own class at request time could declare read.web for an action registered as financial.spend; lazy expiry appends the approval.expired event (system:gate) then refuses, idempotent with a later sweep; attestation is required at intake and grant but deliberately NOT for reject/revoke (refusing to withdraw authority because the policy file changed would leave a live grant standing); re-request after reject/expire/revoke is legal, after execution it is not; grants re-evaluate budgets at grant ts; budget refusal is the only refusing path that writes (budget.exceeded with verdicts + stage); requested/granted payloads always carry class + est_cost_usd per the budgets contract (deepEqual-asserted); frontmatter parsing replicates the policy-load hardening with MAX_ALIAS_COUNT imported so bounds cannot drift. Three flagged seams deferred: execution-event gating itself is APRV-17/18 (request/revoke refuse on started, but refusing to append started without grant lands with tokens); a dedicated refusal for grant-on-classless-request when APRV-17 lands; core cwd fallback only reachable by library callers. Verified: 541/541, lint, typecheck.

Date corrected in place per the 2026-08-05 human ruling (log-is-authoritative, applied to all APRV-46 findings): prose previously claimed 2026-08-06; this task's own created_date (2026-08-05) is the cited source. The wrong date was orchestrator confabulation, part of the systematic drift reported in APRV-46.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
src/core/gate.ts + register/request/grant/reject/revoke/expire CLI: log-derived request lifecycle with write-boundary refusal of illegal transitions (19-code union), TTL judged from the request's own ts with lazy expiry, system: expiry actor, manual-only approval events per amended 6.3, attestation and budget refusals wired per contract. 64 tests. Verified: 541/541, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
