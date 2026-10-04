---
id: APRV-463
title: >-
  setup identity is step zero: a first run of approval up, attest or setup
  without a human identity points at it once and the ceremony sets the variable
  for every later shell
status: To Do
assignee: []
created_date: '2026-10-04 09:23'
labels:
  - ergonomics
dependencies:
  - APRV-74
ordinal: 350000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Evidence 2026-10-04: the human-identity variable was unset on the primary all day. approval up skipped Telegram for it; setup sender-key refused for it; every attest and amend needed --as human:carter typed by hand; env --check listed it UNSET with a fix line nobody read. One setup identity run writes the line into .approval/env and the eval carries it; the verbs should push the operator there once instead of each demanding --as.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval up, policy attest, policy amend and setup sender-key, when the identity is unset and --as is absent, print one line: run approval setup identity once (writes the env line), then eval the env; the message names the file
- [ ] #2 setup identity is idempotent and prints what it wrote without values; env --check shows the identity resolved after it
- [ ] #3 docs/cli-reference.md quick start begins with setup identity
<!-- AC:END -->
