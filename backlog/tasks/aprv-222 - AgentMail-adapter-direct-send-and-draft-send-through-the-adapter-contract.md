---
id: APRV-222
title: 'AgentMail adapter: direct send and draft-send through the adapter contract'
status: To Do
assignee: []
created_date: '2026-09-02 16:29'
labels:
  - adapter
  - launch
dependencies:
  - APRV-221
references:
  - 'https://docs.agentmail.to/drafts'
  - 'https://docs.agentmail.to/api-reference/inboxes/messages/send.md'
  - 'https://docs.agentmail.to/api-reference/api-keys/create.md'
priority: high
ordinal: 182000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A second adapter, `agentmail`, serving `communicate.email.external` over the AgentMail HTTPS API (Node built-in fetch, no new dependency). Two payload modes: (a) direct send, the email adapter payload shape (from, to, cc, bcc, subject, body, content_type) posted to `POST /v0/inboxes/{inbox_id}/messages/send`; (b) draft send, payload `{inbox_id, draft_id, to, cc, bcc, subject, text}` snapshotted at request time, where `act` re-fetches the draft, canonicalizes the same fields (src/core/jcs.ts), refuses on any drift, and only then calls `POST .../drafts/{draft_id}/send`. Why: AgentMail is becoming the default way agents send mail and its Drafts primitive is documented as mail that only sends with a human permission; approval.md is that permission, with a hash-chained log. Enforcement model (recorded in SPEC by the later task in this stack): the agent holds an AgentMail key WITHOUT draft_send/message_send; the vault entry `agentmail.api_key` holds a key WITH them and is read only inside the verified-token window. AgentMail keys carry per-permission booleans (draft_create, draft_update, draft_read, draft_send, message_send are separate). Follow the injectable-fetch pattern of src/channels/telegram.ts and tests/telegram-mock.ts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Adapter named `agentmail` implements only `act`, declares credentials `agentmail.api_key` (secret) and `agentmail.inbox_id` (config), and passes the src/adapters/conformance.ts suite in tests/adapters-contract.test.ts
- [ ] #2 Direct-send payload validated with the email adapter validateEmailPayload; unknown keys refused; a successful send returns a detail carrying message id, payload hash, recipient count and nothing secret
- [ ] #3 Draft payload: drift in any of to, cc, bcc, subject, text between request and act refuses `agentmail-draft-drifted` with nothing sent; a 404 draft refuses `agentmail-draft-missing`; an identical draft sends exactly once
- [ ] #4 HTTP 4xx/5xx map to distinct `agentmail-*` failure codes recorded as execution.failed; a transport throw after the request left the process surfaces as thrown so the contract records execution.indeterminate
- [ ] #5 Options {fetch, apiBase, timeoutMs} injectable; tests run against a loopback node:http mock (tests/agentmail-mock.ts) that asserts no test reaches the network
- [ ] #6 Redaction: the API key never appears in any returned message or detail, verified by a test that plants the key in a mock error body
- [ ] #7 npm test green, lint clean
<!-- AC:END -->
