---
id: APRV-69
title: 'Email adapter: SMTP send behind the gate, zero dependencies'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-17 21:40'
updated_date: '2026-08-17 23:36'
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
- [x] #1 A granted communicate.email.external action sends exactly the approved bytes via SMTP against a mock server; a changed body is refused payload-mismatch before connecting
- [x] #2 Credentials come from the vault by name and appear in no log line, output, or fixture; SMTP failures are recorded as execution.failed carrying the reply code only
- [x] #3 Conformance suite passes against the email adapter; zero new dependencies
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from aprv-68-vault branch (needs vault provider + contract). 2. src/adapters/email.ts implementing Adapter for communicate.email.external: payload = canonical message object {from, to[], cc[], subject, body}; act canonicalizes and hashes exactly what it will send (the contract already recomputes; the adapter formats RFC 5322 from the same object); credentials smtp.host/port/user/password by name from the provider; plain SMTP over node:tls (implicit TLS 465) or node:net + STARTTLS (587), AUTH PLAIN/LOGIN, EHLO/MAIL FROM/RCPT TO/DATA/QUIT with reply-code parsing; failure -> {ok:false, code:"smtp-<reply>", message} never containing credentials; no nodemailer. 3. CLI: approval adapter email <action-key> --token <t> --payload <file> [--as] [--json] wiring executeThroughAdapter with the vault provider. 4. Tests against a local mock SMTP server (node:net) speaking enough of the protocol: happy path asserts the DATA bytes equal the canonical rendering; auth failure; 5xx at RCPT; TLS via a self-signed cert with rejectUnauthorized override only in tests; conformance suite passes against the email adapter; idempotency and payload-mismatch refused before any connection (mock records zero connections). PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR #36. Payload {from,to[],cc?,bcc?,subject,body,content_type?} re-validated in act (defence in depth; unknown keys refused; ASCII local@domain only; CR/LF refused; bcc inside the hash, RCPT TO only). RFC 5322 rendering; Date from injected clock and a deterministic Message-ID (sha256 over action key + payload hash, recomputable from the log so a bounce traces to an approval), neither in the hash: SPEC 6.2 binds body and recipients; judged no SPEC amendment needed, flagged. Quoted-printable (~50 lines) rather than refusing non-ASCII bodies; RFC 2047 B for subjects; non-ASCII addresses refused (no SMTPUTF8). SMTP over node:net/tls: implicit TLS, STARTTLS, none; AUTH PLAIN then LOGIN; multi-line replies; timeouts; codes smtp-connect-failed/tls-failed/timeout/protocol-error + smtp-NNN family (a family, not an enumeration). Credentials smtp.host/port/user/password/security by name from the vault provider inside act; half a login pair refused (email-config-invalid); a credential is never sent over security none. TLS relaxation: no CLI flag; in-process option only, strict default pinned. approval adapter email shares run exit mapping via newly exported executeRefusalExitCode. Mock SMTP server (tests/smtp-mock.ts) with self-signed test cert; conformance harness gained additive credentials option (five-credential adapters could not pass otherwise). REVIEWER-WEIGH: host/port from the vault join the redaction corpus, so connect diagnostics name the credential (smtp.host) not the address; policy-supplied host/port would be a SPEC 5.2 change and its own task. Adapter-side scrubbing makes the contract redactions counter read 0 on a server reply echoing the password (pinned so nobody reads 0 as guard-off). Zero new deps. +47 tests, 1385 composed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Zero-dependency SMTP email adapter behind the contract: canonical payload, deterministic Message-ID, QP encoding, TLS modes, vault-sourced credentials scoped to act, refused-before-connect on mismatch or replay, conformance suite green. PR #36.
<!-- SECTION:FINAL_SUMMARY:END -->
