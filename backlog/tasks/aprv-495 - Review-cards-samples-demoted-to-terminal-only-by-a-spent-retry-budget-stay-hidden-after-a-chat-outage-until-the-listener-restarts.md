---
id: APRV-495
title: >-
  Review cards: samples demoted to terminal-only by a spent retry budget stay
  hidden after a chat outage until the listener restarts
status: To Do
assignee: []
created_date: '2026-10-05 15:40'
labels:
  - review
  - telegram
dependencies: []
priority: medium
ordinal: 379000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
PR #614 fix round 2 (NF-2): the Telegram review-card offer keeps a per-sample budget of 5 failures for anything that is not a deterministic Bot API 400, pausing cards for max(backoff, retry_after) (backoff 60 s doubling, capped at one hour by NF-5). A spent budget prints the coded review-offer-failed line and marks the sample terminal-only, and retry state is process memory like terminalOnly. 'chat not found' and 'bot was blocked' are deliberately treated as transient because they describe the chat, not the card. So a chat outage longer than the budget (the bot blocked or the chat unreachable for several backoffs) demotes every sample offered during it, and they stay off the approver's Telegram until the listener restarts, although the chat is healthy again. Found in the PR #614 recheck notes; the sample stays listable and reviewable at the terminal (SPEC section 10.3: a sample absent from the screen MUST remain in the backlog), so nothing is lost, only hidden.

Decision to make: re-offer terminal-only samples after a cool-off or on a later pass once a send succeeds, versus keeping restart as the only reset and saying so in the docs. Whatever is chosen must not re-offer a sample whose card the Bot API refuses deterministically.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A decision is recorded: re-offer after recovery, or restart-only with the docs saying so
- [ ] #2 If re-offer: a test where N transient failures spend a sample's budget, a later send succeeds, and the sample is offered again; a deterministic 400 sample is never re-offered
- [ ] #3 The review-offer-failed line says whether the sample will be offered again
- [ ] #4 docs/cli-reference.md review-card section states the behaviour
<!-- AC:END -->
