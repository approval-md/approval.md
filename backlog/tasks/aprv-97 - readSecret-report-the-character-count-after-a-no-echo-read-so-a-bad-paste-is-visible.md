---
id: APRV-97
title: >-
  readSecret: report the character count after a no-echo read so a bad paste is
  visible
status: Done
assignee:
  - Claude
created_date: '2026-08-18 19:30'
updated_date: '2026-08-18 19:37'
labels:
  - cli
  - ux
dependencies: []
ordinal: 89000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed running examples/email-demo.md (2026-08-18): the Gmail app password is displayed as four space-separated groups; the operator pasted it into setup adapter email's no-echo prompt, could not tell whether spaces or stray characters came along, and the SMTP probe returned 535. Proposal: after readSecret returns, the setup flow prints 'received N characters' (never the value). Rationale for accepting the length leak: what setup collects are app passwords and tokens whose formats are public (16 chars, 46 chars) so a count reveals nothing an attacker lacks, and it turns 'blind paste, then a provider refusal' into an immediate 'received 19, expected 16'. Optionally: for smtp.password, if the count is 19 and the value matches ^\S{4}( \S{4}){3}$, offer to strip the spaces (Gmail rejects the spaced form over AUTH). Do NOT strip silently: an operator's real password may contain spaces. Sibling of APRV-90/91/95/96.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 After each readSecret in setup flows, output includes the character count and never the value
- [x] #2 The Gmail-shaped 19-character case gets a one-line hint that spaces are probably in the paste, with an explicit y/N to store without them
- [x] #3 Scripted-prompter tests cover the count line and the strip offer; lint and npm test clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented in src/cli/setup-flow.ts collectDefault(): after any secret read the flow prints 'received N character(s)'; if the value matches ^[a-z]{4}( [a-z]{4}){3}$ (Google's display form) it asks 'store the 16 characters without the spaces? [Y/n]' and strips on yes, printing 'storing 16 character(s)'. Never silent, so a real password with spaces survives a 'n'. Three cases in tests/cli-setup.test.ts (accepted, declined, not-the-shape); the suite-wide no-value sweep still passes. Field motivation: Gmail's AUTH rejected a spaced paste with 535 during the email demo.
<!-- SECTION:NOTES:END -->
