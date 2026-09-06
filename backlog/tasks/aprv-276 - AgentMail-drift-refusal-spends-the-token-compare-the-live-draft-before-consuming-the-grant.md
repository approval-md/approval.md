---
id: APRV-276
title: >-
  AgentMail drift refusal spends the token: compare the live draft before
  consuming the grant
status: In Progress
assignee:
  - '@opus-276'
created_date: '2026-09-06 01:39'
updated_date: '2026-09-06 02:05'
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
- [ ] #1 A draft that drifted after the grant refuses agentmail-draft-drifted BEFORE the token is consumed: no execution.started is appended, the token remains spendable, and the refusal says so
- [ ] #2 Restoring the approved content and re-running the adapter with the same token sends once (execution.started, execution.completed) and a third run refuses token-consumed
- [ ] #3 tests/adapter-agentmail (or equivalent) covers drift-then-restore-then-send on one token, and the order of the adapter steps in examples/agentmail-demo.md matches the code
- [ ] #4 SPEC §10.4 says which key performs the pre-spend comparison and why, called out to Carter for sign-off
<!-- AC:END -->
