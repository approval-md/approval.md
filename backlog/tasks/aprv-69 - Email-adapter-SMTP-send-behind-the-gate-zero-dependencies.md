---
id: APRV-69
title: 'Email adapter: SMTP send behind the gate, zero dependencies'
status: To Do
assignee: []
created_date: '2026-08-17 21:40'
labels: []
milestone: m-9
dependencies:
  - APRV-67
  - APRV-68
priority: high
type: feature
ordinal: 68000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The first adapter (SPEC 14 M7): communicate.email.external. Implements the APRV-67 contract for an SMTP send: payload is the canonical message (to, cc, subject, body, from) whose payload_hash the request declared; the adapter re-canonicalizes and re-hashes before sending and refuses payload-mismatch; credentials (SMTP host, port, user, password) come from the APRV-68 vault by name; the send is a plain SMTP session over node:net/node:tls with STARTTLS or implicit TLS (no nodemailer: minimal dependencies is a repo invariant, and a mail library is a large surface for one send). execution.started before the SMTP DATA command, execution.completed after the 250, execution.failed with the SMTP reply code otherwise (never the credential). Idempotency: a repeated idempotency_key is refused before any connection is opened. Tests against a local mock SMTP server (never the network); the real send is exercised only by the APRV-70 demo. Adapter runs as approval adapter email <action-key> --token <t> --payload <file> or is invoked by approval run through the contract, whichever APRV-67 settled. Reversible: false is set on the action by the demo task, so the irreversibility floor forces manual regardless of policy (SPEC 7).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A granted communicate.email.external action sends exactly the approved bytes via SMTP against a mock server; a changed body is refused payload-mismatch before connecting
- [ ] #2 Credentials come from the vault by name and appear in no log line, output, or fixture; SMTP failures are recorded as execution.failed carrying the reply code only
- [ ] #3 Conformance suite passes against the email adapter; zero new dependencies
<!-- AC:END -->
