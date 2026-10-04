---
id: APRV-462
title: >-
  approval up refuses to start, or prints one red line with the fix, when a
  configured channel cannot resolve any account; a listener with no identity or
  no sender key must not degrade to a silent dash
status: To Do
assignee: []
created_date: '2026-10-04 09:22'
labels:
  - dogfood
dependencies: []
priority: high
ordinal: 349000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Evidence 2026-10-04: approval up started the daemon and skipped Telegram with a dash line (no human identity) once, and later started Telegram with the identity but no sender key, so every tap was refused sender-key-unavailable and Carter's phone showed NOT RECORDED three times; nothing on the laptop said the listener was useless. The policy maps a keyed sender for the only approver, so the listener could not have recorded any decision. Two restarts and about forty minutes went to this.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 At startup, when the attested policy maps any keyed sender for a configured channel and the key does not resolve, approval up exits non-zero (or with --degrade starts without that channel) with one line naming the variable's purpose and the exact fix, and the same for a missing human identity when a channel is configured
- [ ] #2 The dash lines keep existing only for genuinely optional features (web port); anything that makes a configured channel unable to record is a refusal
- [ ] #3 approval status and the first daemon tick print the channel state (telegram: resolving accounts | refused: <code>) so a remote operator can see it
<!-- AC:END -->
