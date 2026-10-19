---
id: APRV-526
title: >-
  Telegram: one message per technical card when it fits, with a settle text that
  keeps the canonical block (P-9 item 5)
status: To Do
assignee: []
created_date: '2026-10-18 15:59'
labels: []
dependencies:
  - APRV-525
references:
  - 'https://github.com/approval-md/approval.md/pull/657'
priority: low
ordinal: 403000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
P-9 item 5, split out of APRV-525 (PR #657). A technical card is 3 messages (header, payload, claimed block with the buttons), so a restart re-sends 3 messages per pending request. When header + payload + claimed block fit in TELEGRAM_MAX_MESSAGE_CHARS they could be one sendMessage. Blocker found while building P-9: annotate()'s technical branch replaces the WHOLE text of the buttoned message with the outcome, key and detail, so a one-message card's settle edit would erase the canonical payload block the approver answered on. This needs a settle-text design like the minimal card's minimalSettleText (APRV-489): keep the block whole, shorten the runtime's own lines to fit.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A card whose header, payload and claimed block fit in one message is sent as one sendMessage carrying the keyboard; otherwise it splits exactly as today
- [ ] #2 The settle edit of a one-message technical card keeps the canonical block whole (SPEC.md:568) and the outcome headline, within the Telegram limit
- [ ] #3 Digest member prompts follow the same rule and stay technical (SPEC.md:570)
- [ ] #4 The relay quiet hold still finds exactly one ttl row per message
- [ ] #5 Message-count tests in channels-telegram and the four e2e demos updated
<!-- AC:END -->
