---
id: APRV-414
title: >-
  Telegram review card: symmetric verdict latch, grade taps commit only an armed
  verdict
status: To Do
assignee: []
created_date: '2026-09-20 20:54'
labels:
  - channel
  - telegram
  - ux
dependencies: []
ordinal: 320000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Today a review card's grade row (👎 😐 👍 ❤️) commits verdict ok silently unless 🛑 was tapped first; only Deny is a latch. Carter read a grade tap as feedback separate from the verdict and was surprised the card closed. Reactions must stay guidance and never map to verdicts (SPEC 5.2, invariant 10; denied+liked is already refused), and one sample takes one review event, so the fix is presentation: make row one a symmetric latch so no tap ever commits a verdict the card did not show. Channel-only change in src/channels/telegram.ts and src/cli/channel-telegram.ts; no spec amendment.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Tapping ✅ arms verdict ok and tapping 🛑 arms verdict denied; the first tap of either appends nothing and the card heading names the armed verdict
- [ ] #2 A grade tap with a verdict armed records that verdict plus the reaction (loved and disliked still collect a note first); a second tap on the armed verdict button records it with no grade
- [ ] #3 A grade tap with no verdict armed appends nothing and answers a toast telling the human to tap ✅ or 🛑 first
- [ ] #4 Tapping the other verdict button while one is armed re-arms to it without appending
- [ ] #5 Existing refusals are unchanged: denied plus liked or loved still fails reaction-conflicts-verdict before any log read
- [ ] #6 tests/ cover every sequence in the table: ✅✅, ✅👍, 🛑🛑, 🛑👎+note, bare 👍, ✅ then 🛑 then 👎, and the settled card still shows verdict and reaction
- [ ] #7 docs/telegram.md (or wherever the review card is documented) describes the two-row latch
<!-- AC:END -->
