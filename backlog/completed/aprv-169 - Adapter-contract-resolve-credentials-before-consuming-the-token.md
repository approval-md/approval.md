---
id: APRV-169
title: 'Adapter contract: resolve credentials before consuming the token'
status: Done
assignee:
  - '@claude'
created_date: '2026-08-31 00:33'
updated_date: '2026-09-01 18:52'
labels:
  - core
  - gate
dependencies: []
ordinal: 148000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Decided with Carter 2026-08-30 (analysis on APRV-168, option C). Today startExecution in src/adapters/contract.ts consumes the single-use token and appends execution.started BEFORE the credential window opens, so a credential-unavailable failure burns the human's authorization and the retry refuses token-consumed: a refusal that destroys a grant. The consume-early ordering exists to make side effects never double-spendable across crash ambiguity (APRV-120 custody states), and a pre-flight credential PROBE executes nothing, so checking credentials before consumption creates no double-spend window. Change: adapters declare their required credential names; execution resolves them first and refuses credential-unavailable with the token intact (no execution.started, machine-readable refusal per SPEC 11); only then consume and run. This touches the check-then-append ordering of an enforcement path, so SPEC 10.4 gets a sentence and the implementation notes must call out the invariants touched.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Credential resolution precedes token consumption: a credential-unavailable refusal appends no execution event and leaves the token spendable, proven by a test that then succeeds with the same token once the credential appears
- [x] #2 Double-spend safety unchanged: the consume-then-execute ordering for the actual side effect is untouched and its existing pins stay green
- [x] #3 SPEC 10.4 states the ordering; implementation notes name the SPEC 11 invariants touched
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Confirm the contract on main resolves Adapter.requiredCredentials before startExecution (src/adapters/contract.ts resolveRequiredCredentials). 2. Run the adapter suites for objective evidence of AC1 and AC2. 3. Confirm SPEC section 10.4 states the ordering. 4. Finalize with notes naming the section 11 invariants touched.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-09-01 bookkeeping close (the code merged in PR #162 on branch adapter-credentials; this task was never finalized). Evidence: src/adapters/contract.ts step 3b resolveRequiredCredentials runs before startExecution and refuses credential-unavailable with nothing appended and the grant intact (refusal text cites SPEC section 10.4, APRV-169). Tests: node scripts/run-tests.mjs --only adapters-contract --only vault-provider --only adapter-email = 81 pass, 0 fail, including "a credential refusal leaves the token spendable, and the same token then succeeds" (AC1) and "an adapter that declares no credentials keeps the ordering it always had" plus the existing consume-then-execute pins (AC2). SPEC section 10.4 (line ~415) states the ordering, flagged (Amended APRV-169 and APRV-168, pending sign-off.) for the human. Section 11 invariants touched: enforcement paths read only verified records (unchanged), raw secrets never appear in the log (the refusal names the credential NAME only; a provider-published value is redacted, pinned by test), every check-then-append passes through compare-and-append (the credential check appends nothing, so no new check-then-append path exists).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Adapters declare requiredCredentials and the runtime resolves them before the token is consumed; an unresolvable credential refuses credential-unavailable with no execution event and a still-spendable token. Landed in PR #162; verified 2026-09-01 with 81 passing adapter tests and the SPEC 10.4 sentence (sign-off pending, human step).
<!-- SECTION:FINAL_SUMMARY:END -->
