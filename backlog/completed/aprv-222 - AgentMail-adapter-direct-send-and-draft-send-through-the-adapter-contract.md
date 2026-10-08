---
id: APRV-222
title: 'AgentMail adapter: direct send and draft-send through the adapter contract'
status: Done
assignee:
  - '@claude-opus'
created_date: '2026-09-02 16:29'
updated_date: '2026-09-02 16:57'
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
- [x] #1 Adapter named `agentmail` implements only `act`, declares credentials `agentmail.api_key` (secret) and `agentmail.inbox_id` (config), and passes the src/adapters/conformance.ts suite in tests/adapters-contract.test.ts
- [x] #2 Direct-send payload validated with the email adapter validateEmailPayload; unknown keys refused; a successful send returns a detail carrying message id, payload hash, recipient count and nothing secret
- [x] #3 Draft payload: drift in any of to, cc, bcc, subject, text between request and act refuses `agentmail-draft-drifted` with nothing sent; a 404 draft refuses `agentmail-draft-missing`; an identical draft sends exactly once
- [x] #4 HTTP 4xx/5xx map to distinct `agentmail-*` failure codes recorded as execution.failed; a transport throw after the request left the process surfaces as thrown so the contract records execution.indeterminate
- [x] #5 Options {fetch, apiBase, timeoutMs} injectable; tests run against a loopback node:http mock (tests/agentmail-mock.ts) that asserts no test reaches the network
- [x] #6 Redaction: the API key never appears in any returned message or detail, verified by a test that plants the key in a mock error body
- [x] #7 npm test green, lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/adapters/agentmail.ts: AGENTMAIL_CLASS, DEFAULT_AGENTMAIL_CREDENTIAL_NAMES {apiKey: agentmail.api_key, inboxId: agentmail.inbox_id}, AGENTMAIL_CREDENTIAL_SPECS (api_key secret required, inbox_id config required; both non-empty, whitespace-free), requiredAgentmailCredentials(names) derived from the specs, readAgentmailConfig(provider, names) as the single provider->config reader (mirrors readEmailSmtpConfig, returns {config, secrets} on both branches), probeAgentmail(config, deps) doing GET /v0/inboxes/{inbox_id} and sending nothing.
2. Payload modes discriminated by shape: a payload carrying draft_id is the draft mode, one carrying body is the direct mode; a payload matching both or neither refuses agentmail-payload-invalid rather than guessing. Direct mode reuses validateEmailPayload from email.ts. Draft mode validates exactly {inbox_id, draft_id, to, cc?, bcc?, subject, text}, unknown keys refused.
3. act (direct): read config, GET the inbox (that read is the credential check), refuse agentmail-from-mismatch when payload.from is present and is not the inbox address, then POST /v0/inboxes/{inbox_id}/messages/send with Authorization: Bearer and {to, cc, bcc, subject, text|html}.
4. act (draft): payload.inbox_id must equal the credential inbox_id (agentmail-inbox-mismatch); GET the draft (404 -> agentmail-draft-missing); canonicalize the fetched draft's to/cc/bcc/subject/text with core/jcs.ts and compare field by field against the payload's canonical form; any difference -> agentmail-draft-drifted naming the fields and never their values; then POST .../drafts/{draft_id}/send.
5. HTTP mapping (returned failures, execution.failed): 401/403 unauthorized, 404 not-found, 409 conflict, 429 rate-limited, other 4xx rejected, 5xx server-error. A throw on the pre-send GETs returns agentmail-unreachable (nothing attempted); a throw on the send call propagates so the contract records execution.indeterminate. AbortController for timeouts; every returned string scrubbed with redactSecrets over the api key.
6. tests/agentmail-mock.ts: loopback node:http mock with assertLocal, request log, inbox/draft fixtures, per-code failure injection, a plant-the-key-in-an-error-body mode.
7. tests/adapter-agentmail.test.ts: both happy paths, per-field drift with no POST observed, deleted draft, inbox mismatch, from mismatch, every HTTP mapping, send-throw propagation, redaction sweep.
8. Append an agentmail conformance section to tests/adapters-contract.test.ts and run npm test plus npm run lint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built src/adapters/agentmail.ts, tests/agentmail-mock.ts, tests/adapter-agentmail.test.ts, and appended an agentmail conformance run to tests/adapters-contract.test.ts (plus one optional `bytes` parameter on that file's `granted()` so the case can bind an email-shaped payload).

Decisions worth recording:

1. **`from` is informational on the wire and binding here.** AgentMail's send endpoint has no `from` field: the inbox is the sender. Rather than dropping the field (which would let a human approve a sender nobody checked) or inventing a header, the direct payload reuses the email adapter's `validateEmailPayload` verbatim, so `from` stays required and well-formed, and `act` performs one extra `GET /v0/inboxes/{inbox_id}` before every direct send and refuses `agentmail-from-mismatch` (case-insensitively) when the inbox's own address is not the approved one. That read doubles as the credential check, so the extra round trip buys two things rather than one, and it is idempotent: a throw on it is `agentmail-unreachable` precisely because nothing was attempted. The inbox address is read from the response's `address`, falling back to `inbox_id` (AgentMail ids are addresses).
2. **Mode discrimination by markers, ambiguity refused.** Draft markers are draft_id/inbox_id/text, direct markers from/body/content_type. Both present is `agentmail-payload-ambiguous`; neither is `agentmail-payload-invalid`. A send mode chosen by inference is a side effect chosen by inference.
3. **Drift naming, never quoting.** `agentmail-draft-drifted` names which of to/cc/bcc/subject/text differ and never what they now hold: the refusal is written to a log a human reads, and the drifted text is by definition unapproved content. A draft body that does not read back as a JSON object is also `agentmail-draft-drifted` (what the human approved cannot be compared with what would be sent). Absent, null and [] are one fact for cc/bcc; array order is significant for recipients.
4. **Which throws propagate.** Only the POST is unwrapped, so a throw there reaches the contract and is recorded execution.indeterminate. Both pre-send GETs are wrapped and return `agentmail-unreachable` (execution.failed). Every HTTP status is a RETURNED failure: an answer is knowledge.
5. **Redaction corpus is the API key only.** `readAgentmailConfig` returns `secrets` holding just the secret-kind value; the inbox id is not a secret and appears in refusal sentences that are useless without it. `AgentmailCredentialNames` is an interface rather than `typeof DEFAULT` so `credentialNames` can actually rename (the email adapter's literal-typed version cannot; not changed here, it is not this task).
6. No new dependency: Node's built-in fetch, injectable, with AbortController timeouts.

Global invariants touched (CLAUDE.md / SPEC §11.1): invariant 3 (raw secrets never appear) is exercised by planting the key in a mock error body; invariant 6 (frozen, distinct refusal unions) by AGENTMAIL_FAILURE_CODES and its pin test. Nothing here writes to the log or mints authority.

Verification evidence, per AC:
- AC1: `agentmailAdapter()` declares name agentmail, classes [communicate.email.external], requiredCredentials [agentmail.api_key, agentmail.inbox_id] (pinned by "the credential manifest matches the names act asks for"); the shared suite runs green in tests/adapters-contract.test.ts ("the agentmail adapter conforms to the adapter contract", all seven checks reported).
- AC2: "a granted direct send posts exactly the approved message and returns a receipt" asserts the wire body (no from, text vs html), the receipt keys (mode, message_id, thread_id, payload_hash, recipients, http_status) and that the key rode only the Authorization header; unknown keys refused by "a draft payload with an unknown key is refused rather than silently trimmed" and the display-name From case.
- AC3: one test per field in AGENTMAIL_DRAFT_FIELDS asserts agentmail-draft-drifted, no POST observed, and no needle from the drifted value anywhere in the result; "a draft that no longer exists refuses agentmail-draft-missing without sending"; the happy path asserts exactly one draft read and one send.
- AC4: a parameterised test covers 401/403/404/409/422/429/500/503 mapping and asserts the log's last two events are execution.started, execution.failed; "a throw on the send itself propagates" asserts execution-indeterminate and execution.indeterminate in the log, and the two pre-send-read tests assert agentmail-unreachable as execution.failed.
- AC5: {fetch, apiBase, timeoutMs, credentialNames} are options; every apiBase goes through the mock's assertLocal, and the timeout test proves the AbortController fires.
- AC6: "an API key planted in an error body never reaches the message, the detail or the log" plus an after() sweep over every captured string and every log this suite wrote.
- AC7: npm test -> tests 2879, pass 2878, fail 0, skipped 1 (pre-existing). npm run lint (oxlint src tests) exits 0 with no findings.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added the agentmail adapter (src/adapters/agentmail.ts): one Adapter serving communicate.email.external over AgentMail's HTTPS API with Node's built-in fetch, two payload modes discriminated by shape with ambiguity refused, and a draft mode that re-reads the draft, canonicalizes to/cc/bcc/subject/text with core/jcs.ts and refuses agentmail-draft-drifted (naming fields, never values) before anything is sent. from is checked against the inbox's own address via one extra idempotent GET that doubles as the credential check, since AgentMail has no per-message From. Exports the CredentialSpec list, readAgentmailConfig and probeAgentmail for the setup wizard task. Every HTTP status maps to a distinct returned agentmail-* failure (execution.failed); only a throw on the send itself propagates (execution.indeterminate). Verified by tests/adapter-agentmail.test.ts (41 tests against the new loopback node:http mock in tests/agentmail-mock.ts, assertLocal on every apiBase) and by the shared conformance suite appended to tests/adapters-contract.test.ts. npm test: 2879 tests, 0 fail, 1 pre-existing skip; oxlint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
