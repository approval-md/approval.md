---
id: APRV-75
title: 'Doctor: uniform fix commands and the value-free environment check'
status: To Do
assignee: []
created_date: '2026-08-18 01:39'
labels: []
milestone: m-10
dependencies:
  - APRV-73
priority: medium
type: feature
ordinal: 74000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
doctor catches misconfiguration and does not help configure; some fixes are literal commands, some are prose. Every fail fix begins with a runnable command (shape test over all failing verdicts); identity, audit-sampling secret-unset, vault passphrase-unset, and telegram unconfigured point at the corresponding approval setup verb, keeping the export line as the manual alternative. New environment check APPENDED (pinned order): each policy-named variable set/unset BY NAME ONLY; .approval/env presence, mode, gitignore coverage, plaintext literals; skip when nothing unset and no file; fail only for wrong mode, plaintext secret, or ungitignored file. Doctor still appends nothing, sends nothing, getMe only. Generalize VAULT_IGNORE_PATTERNS to cover .approval/env.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every fail fix begins with a runnable command; the four env-shaped fixes point at approval setup <thing> with the export line kept as alternative
- [ ] #2 environment check appended (10 -> 11), value-free, with the stated skip/fail semantics; pinned lists extended additively
<!-- AC:END -->
