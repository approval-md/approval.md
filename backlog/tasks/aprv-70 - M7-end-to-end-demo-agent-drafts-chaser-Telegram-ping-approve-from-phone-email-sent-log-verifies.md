---
id: APRV-70
title: >-
  M7 end-to-end demo: agent drafts chaser, Telegram ping, approve from phone,
  email sent, log verifies
status: To Do
assignee: []
created_date: '2026-08-17 21:40'
updated_date: '2026-08-17 21:41'
labels: []
milestone: m-9
dependencies:
  - APRV-55
priority: high
type: feature
ordinal: 69000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC 14 M7 exit criterion, and the abstract made real: an agent drafts the canonical example deposit chaser (SPEC 6.1) as a task with communicate.email.external, reversible false, payload = the message; register, request (payload filed), Telegram notify to the human phone, approve, token minted, approval run / the email adapter sends via SMTP using vault credentials, log verifies. Two halves like APRV-27: a scripted demo test against the mock SMTP server and the mock Bot API (CI-runnable, asserts every hop against the log), and a documented manual runbook (examples/email-demo.md) for the human to run once against real Telegram and a real SMTP account (the network hop only a human can prove; the human sets up an app password in the vault). The proof event range is recorded here when the human runs it. Update the README ceremony docs with the fourth ceremony (sending mail from your phone approval) if it fits naturally, in the incident-grounded style.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Scripted demo test walks register -> request -> notify -> approve -> send -> log verify against mocks and passes in CI
- [ ] #2 examples/email-demo.md runbook exists; the human has run it once against real Telegram and SMTP and the log seq range is recorded on this task
- [ ] #3 README documents the fourth ceremony
<!-- AC:END -->
