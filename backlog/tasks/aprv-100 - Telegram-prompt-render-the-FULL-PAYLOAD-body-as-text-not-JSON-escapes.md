---
id: APRV-100
title: 'Telegram prompt: render the FULL PAYLOAD body as text, not JSON escapes'
status: To Do
assignee: []
created_date: '2026-08-18 21:47'
labels:
  - channels
  - ux
dependencies: []
ordinal: 92000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed in the real email-demo run (2026-08-18): the approval message on the phone shows the payload as raw JSON, so the email body arrives as one line with literal \n sequences and the £ as-is; the operator called it 'not styled too well'. The exactness is right (the human approves the bytes the hash binds), and it must stay verifiable, but a body field should be shown as the human will read it: real line breaks, and the JSON view (or the hash) available underneath rather than instead. Proposal: for payloads the channel recognises (email: from/to/cc/subject/body), render a labelled block per field with body unescaped and HTML-escaped for Telegram (the existing < and & handling stays), and keep 'payload sha256 …' as the binding line; unknown payload shapes keep the JSON rendering. Same for the web channel if it mirrors Telegram.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Email-shaped payloads render field-by-field with real line breaks in the body; the binding hash is still shown
- [ ] #2 Markup injection tests (< & in subject/body) still pass; unknown shapes still render as JSON
- [ ] #3 npm test and lint clean; examples/email-demo.md step 8 text updated
<!-- AC:END -->
