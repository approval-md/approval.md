---
id: APRV-96
title: >-
  setup channel telegram: wait for the message instead of asking for Enter, and
  say what Telegram reported when none arrives
status: Done
assignee: []
created_date: '2026-08-18 19:14'
updated_date: '2026-08-19 01:32'
labels:
  - cli
  - ux
dependencies: []
ordinal: 88000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed running examples/email-demo.md (2026-08-18): the operator sent the bot a message, pressed Enter, and got 'No message seen yet' with no way to tell whether the message went to the wrong bot, arrived after the 10s long-poll expired, or was consumed by another poller. A second message sent later was found by curl (getWebhookInfo pending_update_count 1) and picked up on attempt 2. Two changes. (1) Replace the send-then-press-Enter loop with a continuous long-poll after getMe: print 'waiting for a message to @bot (up to 90s, Ctrl-C to stop)', re-issue offset-less getUpdates(allowed_updates=[message], timeout=10) until a candidate appears, so timing no longer matters; the no-offset invariant and allowed_updates narrowing are unchanged. (2) On giving up, call getWebhookInfo and print pending_update_count and whether a webhook url is set, plus 'check the chat header on your phone: the bot must be @<username>' before the existing manual-curl recipe. Sibling of APRV-90/91/95.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 After token validation the verb long-polls until a message arrives or a stated deadline passes; no Enter is required
- [x] #2 Every getUpdates still carries no offset and allowed_updates [message]; the existing tests asserting that still pass
- [x] #3 On timeout, output includes pending_update_count and webhook status from getWebhookInfo and names the bot username to check
- [x] #4 examples/telegram-demo.md and email-demo.md transcripts updated
- [x] #5 npm test and lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Field evidence 2026-08-18: 'hello' was sent to @approval_md_bot at 19:54 local, yet by ~20:05 getWebhookInfo showed pending_update_count 1 holding only a later 'testing'. Unacked updates persist 24h and setup never sends an offset, so a second poller with an offset consumed it (nothing matching dist/src/cli/main.js was running locally besides setup). The timeout report should therefore say: if pending_update_count is 0 right after you sent a message, another process (daemon/listener, possibly on another machine or a cloud session) is acknowledging this bot's updates, and it will also fight the listener with 409s.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Telegram setup waits for the message with an offset-free long-poll and diagnoses silence via getWebhookInfo. PR #68.
<!-- SECTION:FINAL_SUMMARY:END -->
