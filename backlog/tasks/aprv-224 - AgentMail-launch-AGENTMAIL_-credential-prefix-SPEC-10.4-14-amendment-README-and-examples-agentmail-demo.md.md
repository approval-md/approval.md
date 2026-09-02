---
id: APRV-224
title: >-
  AgentMail launch: AGENTMAIL_ credential prefix, SPEC 10.4/14 amendment, README
  and examples/agentmail-demo.md
status: To Do
assignee: []
created_date: '2026-09-02 16:30'
labels:
  - adapter
  - launch
  - docs
  - spec
dependencies:
  - APRV-223
priority: high
ordinal: 184000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Closes the AgentMail stack for the 0.1.0 launch. (1) `AGENTMAIL_` joins SECRET_ENV_PREFIXES in src/core/command-class.ts so the agent AgentMail key never leaks into `approval run` children. (2) SPEC.md section 10.4 is amended: adapter examples name adapter-agentmail, the prefix list adds AGENTMAIL_, and a new paragraph states the two-key enforcement model (agent key without send permissions, gate key in the vault with them) and how a remote mutable draft is bound by the bytes fetched at request time; section 14 M7 notes the second adapter. This is a spec divergence: draft the text, call it out, and Carter signs it through the policy.edit gate. (3) README adapter walkthrough gains the AgentMail variant and examples/agentmail-demo.md shows the full loop: agent writes a draft, `payload agentmail-draft`, register/request, Telegram approve, `adapter agentmail` sends, log verifies. No APPROVAL.md change: adapter execution classifies by the registered action class, never network.call. APRV-199 depends on this task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 AGENTMAIL_ is in the credential-bearing prefixes; tests/child-env.test.ts and tests/command-class.test.ts cover it; env_stripped counts an AGENTMAIL_ variable
- [ ] #2 SPEC.md sections 10.4 and 14 amended as described and the divergence called out to Carter for sign-off; no silent spec edit
- [ ] #3 README adapter section shows the AgentMail path and the two-key split; examples/agentmail-demo.md exists and tests/docs-guard.test.ts passes on its exit-code and refusal claims
- [ ] #4 Manual e2e against a real AgentMail account recorded in the notes: agent key gets 403 on messages/send; edited draft refuses agentmail-draft-drifted with grant intact; approved draft sends once; `approval log verify` clean
- [ ] #5 npm test green, lint clean
<!-- AC:END -->
