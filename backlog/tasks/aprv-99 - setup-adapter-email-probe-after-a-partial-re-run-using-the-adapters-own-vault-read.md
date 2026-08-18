---
id: APRV-99
title: >-
  setup adapter email: probe after a partial re-run using the adapter's own
  vault read
status: To Do
assignee: []
created_date: '2026-08-18 21:32'
labels:
  - cli
  - ux
dependencies: []
ordinal: 91000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed running examples/email-demo.md (2026-08-18): after replacing only smtp.password (and smtp.host) the verb declined to probe: 'not verified: smtp.port, smtp.security, smtp.user were left alone this run, so this verb does not hold the whole configuration, and it will not read the missing values back'. The rule (setup-flow never reads a credential out) is sound for PRINTING, but the adapter itself reads the whole set from the vault at send time; a probe that opens the vault through the same in-process path (adapters/email.ts credential read, values never leaving the process) is no wider than the send. Proposal: on a partial re-run, offer 'open an SMTP session using the stored configuration to check it? [Y/n]' and run probeSmtp over the merged set read the way the adapter reads it. Keep the current refusal text as the fallback when the vault cannot be opened. Rotating an app password is the common case for this verb, and it deserves the same proof as first setup.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A partial re-run offers a probe over the stored configuration, read through the adapter's own vault path; nothing is printed
- [ ] #2 First-run behaviour unchanged; scripted-prompter tests cover the partial case
- [ ] #3 npm test and lint clean
<!-- AC:END -->
