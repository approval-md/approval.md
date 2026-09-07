---
id: APRV-302
title: >-
  Review card ergonomics: emoji-only buttons, no footer rule block, a
  review-specific toast
status: To Do
assignee: []
created_date: '2026-09-07 23:36'
labels:
  - channels
dependencies: []
ordinal: 222000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter's first live review cards (2026-09-07) were too verbose.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 REVIEW_BUTTON_LABELS in src/channels/telegram.ts become bare emoji: check mark and stop sign on row one, thumbs-down, neutral, thumbs-up, heart on row two.
- [ ] #2 The TELEGRAM_REVIEW_RULE block (Nothing here is pending and no button on this card authorizes anything...) is removed from the rendered card; the heading REVIEW - THIS ALREADY RAN carries the meaning.
- [ ] #3 Review taps answer with their own toast (e.g. Heard - recording your review. The card will say what the log recorded.) instead of TELEGRAM_ACK_HEARD; the note-prompt toast is unchanged.
- [ ] #4 tests/channels-telegram.test.ts expectations updated; docs/cli-reference.md telegram section and docs/dogfood-cutover.md review-card section reflect the new card.
<!-- AC:END -->
