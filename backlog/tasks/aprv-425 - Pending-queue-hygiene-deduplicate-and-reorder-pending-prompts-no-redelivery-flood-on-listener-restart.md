---
id: APRV-425
title: >-
  Pending-queue hygiene: deduplicate and reorder pending prompts, no redelivery
  flood on listener restart
status: To Do
assignee: []
created_date: '2026-09-21 06:42'
labels:
  - telegram
  - daemon
  - hygiene
dependencies: []
priority: low
ordinal: 326000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Dogfooding produced a specific list of what hurts about running the gate: a listener restart redelivers every pending prompt at once because the sent-record starts empty, a live prompt is buried behind dead ones, and an operator rejected a decision they wanted in the flood (APRV-118). APRV-287 collapses old requests into one reject-all message on reconnect. Go further: the sent-record survives restart (derived from the log, never evidence), pending prompts are ordered with the live one on top, expired and superseded ones are collapsed, and a restart resends nothing already on the phone. This is a hosted-daemon hygiene requirement and a self-hosted quality of life fix in one.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After a listener restart with N pending requests already delivered, zero new messages are sent; shown by a test against the injected fetch
- [ ] #2 Pending prompts are ordered newest-live first and expired or superseded ones are collapsed per APRV-287, with the ordering rule documented
- [ ] #3 The sent-record is rebuilt from the log on start and is never read as evidence of delivery
<!-- AC:END -->
