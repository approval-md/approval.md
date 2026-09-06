---
id: APRV-276
title: >-
  AgentMail drift refusal spends the token: compare the live draft before
  consuming the grant
status: In Progress
assignee:
  - '@opus-276'
created_date: '2026-09-06 01:39'
updated_date: '2026-09-06 11:48'
labels:
  - agentmail
  - adapters
  - release
dependencies: []
type: bug
ordinal: 203000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found in the APRV-224 manual e2e on 2026-09-06 against a real AgentMail inbox. After a grant, editing the draft through AgentMail (PATCH /v0/inboxes/{inbox}/drafts/{draft}) and running the adapter refused agentmail-draft-drifted as designed, but the refusal was recorded as execution.started (seq 10) then execution.failed (seq 11), so the single-use token was spent by the failed attempt. Restoring the approved subject and running the adapter again refused token-consumed. examples/agentmail-demo.md steps 9 and 10 promise the opposite: "Nothing was sent, execution.failed records the attempt that did not commit, and the grant is untouched", then "Restoring the approved text and running the adapter again sends it once", with the stated reason that a refusal costing the human another tap teaches operators to stop checking. The adapter order in the runbook itself (payload re-hashed, token verified and consumed, execution.started, vault opened, draft re-fetched and compared) shows why: the comparison runs after the spend. The drift check reads the draft with the SENDING key from the vault, which opens inside the token window; deciding whether the pre-spend read may use the agent key already in the environment, or a vault read before the spend, is the design question. Tests drive a mock and never reuse a token after a drift, so CI could not see it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A draft that drifted after the grant refuses agentmail-draft-drifted BEFORE the token is consumed: no execution.started is appended, the token remains spendable, and the refusal says so
- [x] #2 Restoring the approved content and re-running the adapter with the same token sends once (execution.started, execution.completed) and a third run refuses token-consumed
- [x] #3 tests/adapter-agentmail (or equivalent) covers drift-then-restore-then-send on one token, and the order of the adapter steps in examples/agentmail-demo.md matches the code
- [x] #4 SPEC §10.4 says which key performs the pre-spend comparison and why, called out to Carter for sign-off
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read the adapter contract's execution order (src/adapters/contract.ts) and the AgentMail draft path (src/adapters/agentmail.ts); decide where a pre-spend comparison can live without reordering consume-then-execute.
2. Add an optional Adapter.precheck hook to the contract, called after the declared credentials resolve (APRV-169's pre-token window, APRV-168's presented-phase grant) and before startExecution. A refusal appends nothing, spends nothing, and returns the stable code adapter-precheck-refused with the adapter's own reason in adapter_code; a precheck that throws is a refusal (precheck-threw), not an exception.
3. Extract AgentMail's shape/inbox/draft-read/drift comparison into one function and call it twice: as precheck (protects the grant) and inside act immediately before the POST (binds the bytes actually sent). The pre-spend read uses the vault's SENDING key through the contract-scoped provider, never a key from the agent's environment.
4. Gate the precheck on the log's content binding: bytes the grant (or, off the manual path, the declaration) does not bind never reach an adapter, so payload-mismatch stays core's refusal.
5. Tests: drift-then-restore-then-send on ONE token in tests/adapter-agentmail.test.ts, plus contract-level coverage of the refusal, the throw, the no-precheck ordering, and the unbound-payload skip.
6. Docs: CLI help within the 25-line cap, docs/cli-reference.md step order and failure-code prose, SPEC 10.4 amendment naming which key performs the pre-spend comparison and why (APRV-276, pending sign-off).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Finished by fable after the second agent session was cut off: adapter, contract, help and reference suites 181/181, lint and typecheck clean; examples/agentmail-demo.md step 10's ordered list now states the pre-spend comparison (the runbook file is on the stack via APRV-277). Design as landed: the adapter contract gains an optional precheck the contract calls after credentials resolve and before the token is consumed; AgentMail's precheck re-fetches the draft with the sending key in that pre-token window and refuses adapter-precheck-refused/agentmail-draft-drifted with nothing appended; the same comparison runs again inside the window before the POST. Invariants touched: token single-use (unchanged: only execution.started spends), §11.1 invariant 8 (a refusal that appends nothing returns no proceed).
<!-- SECTION:NOTES:END -->
