---
id: APRV-168
title: >-
  Demo email finale: adapter credential path collides with the runner's env
  scrub
status: To Do
assignee: []
created_date: '2026-08-31 00:01'
labels:
  - demo
  - design
dependencies: []
ordinal: 147000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found during APRV-157 (runbook): the web-agent demo's email finale routes adapter_email through the agent child, whose env the server deliberately scrubs of anything matching APPROVAL|VAULT|TELEGRAM (server.mjs agentEnv, and the security contract requires the server itself to hold no vault passphrase). passphraseFrom (src/core/vault.ts:764) reads only process.env and no verb reads .approval/env into its own environment (src/core/env-file.ts:45), so the agent's adapter call should refuse credential-unavailable. Compounding it: startExecution (src/adapters/contract.ts:560-585) consumes the token and appends execution.started BEFORE the credential window opens, so the failure burns the single-use token and the retry refuses token-consumed. The runbook ships with a mandatory pre-show rehearsal and a stage recovery (operator sends by hand from ~/demo-gate per email-demo.md), but the finale deserves a design answer: candidates include a narrowly-scoped passthrough of the demo instance's passphrase variable into the agent child (weighing that against the server's no-credentials contract, since the child is not the server), the adapter reading the instance's .approval/env itself, or moving credential resolution before token consumption so a credential-unavailable refusal does not burn the token (that last one may be a §11-adjacent change and deserves its own scrutiny regardless of the demo).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A decided design (recorded here) for how a gated adapter reaches vault credentials when its parent process holds none
- [ ] #2 The demo's send_the_email template completes end to end in rehearsal: phone approve, sealed wait, mail sent, execution.completed on the demo log
- [ ] #3 Decision recorded on whether credential resolution should precede token consumption in the adapter contract, with a follow-up task if yes
<!-- AC:END -->
