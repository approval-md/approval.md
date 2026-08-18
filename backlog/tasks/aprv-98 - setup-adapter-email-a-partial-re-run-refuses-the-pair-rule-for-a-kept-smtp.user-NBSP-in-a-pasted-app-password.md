---
id: APRV-98
title: >-
  setup adapter email: a partial re-run refuses the pair rule for a kept
  smtp.user; NBSP in a pasted app password
status: Done
assignee:
  - Claude
created_date: '2026-08-18 20:26'
updated_date: '2026-08-18 20:26'
labels:
  - bug
  - cli
dependencies: []
ordinal: 90000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed running examples/email-demo.md (2026-08-18). (1) Rotating only smtp.password (answering n to replace smtp.user) was refused with 'the vault holds smtp.password but not smtp.user': the flow deliberately never reads the vault back, so hooks.check saw only this run's values and treated the kept user as absent. Fix: check(values, kept) receives plan.skipped and checkEmailCredentialSet counts a kept name as present (presence is all the pair rule needs). (2) The same paste showed 'received 19 character(s)' with no strip offer: the copy from Google's page carried non-breaking spaces (U+00A0), which the APRV-97 regex (literal space) did not match and split(' ') would not have removed. Fix: separator is \s, case-insensitive letters, strip via replace(/\s/g,'').
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Replacing only smtp.password on a vault that already holds smtp.user succeeds; a fresh vault with password and no user is still refused
- [x] #2 A Google-shaped paste with U+00A0 separators gets the strip offer and stores 16 characters
- [x] #3 Tests for both; lint and setup/adapter tests clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
check hook signature widened to (values, kept) in setup-flow.ts and setup-adapter.ts; the flow passes plan.skipped. checkEmailCredentialSet(values, names, kept) treats kept names as present. The app-password pattern now uses a whitespace-class separator (covers U+00A0) and case-insensitive letters, and the strip removes all whitespace. Two new tests in tests/cli-setup.test.ts. Found during the email demo, second adapter run.
<!-- SECTION:NOTES:END -->
