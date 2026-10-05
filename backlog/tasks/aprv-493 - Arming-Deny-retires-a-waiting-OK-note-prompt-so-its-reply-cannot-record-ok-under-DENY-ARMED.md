---
id: APRV-493
title: >-
  Arming Deny retires a waiting OK note prompt, so its reply cannot record ok
  under DENY ARMED
status: To Do
assignee: []
created_date: '2026-10-05 13:56'
labels:
  - telegram
  - review
dependencies: []
references:
  - 'https://github.com/approval-md/approval.md/pull/619'
priority: medium
ordinal: 377000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the PR #619 refuter (S3), pre-existing on main e58839b1, not introduced by APRV-492. In src/channels/telegram.ts, the first Deny tap arms the card through recordReview and never touches state.awaitingNote. Sequence: loved, ok (prompt P1 = ok+loved is sent), deny (the card arms and says DENY ARMED). A reply to P1 still resolves and records audit.reviewed verdict=ok reaction=loved while the card says the human is about to deny. Same family as PR #619 finding B1 (a prompt carrying a verdict the human moved away from stays live). Fix direction: when Deny arms on a card whose awaited note carries verdict ok, retire that prompt (drop it from reviewNotePrompts, clear awaitingNote) and say on the card that the OK note is withdrawn; grading again then asks for the denial's words (the second Deny alone would not: the relay licenses one note prompt per grade tap, and P1 spent the licence).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Arming Deny while an ok note prompt is awaited retires that prompt; a reply to it records nothing
- [ ] #2 The card says the OK note was withdrawn
- [ ] #3 A regression test in tests/channels-telegram.test.ts pins the sequence loved, ok, deny, reply-to-P1 records nothing
<!-- AC:END -->
