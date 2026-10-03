---
id: APRV-442
title: >-
  Telegram: a refused tap must not kill the live prompt; the pending request is
  offered again on the next cycle
status: To Do
assignee: []
created_date: '2026-09-25 08:08'
labels:
  - telegram
  - channels
  - hosting
dependencies: []
priority: medium
ordinal: 336000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-25 in the hosted image smoke (bountify-ai/approval-md-hosted HOSTED-4, two tenant stores in webhook mode against a fake Bot API, core at 6b74ca72): after a tap from an unmapped account is refused sender-unmapped (audit.decision_refused appended by system:gate, the request left pending), the prompt's buttons stop working and no fresh prompt is sent for the still-pending request until the listener restarts. Nothing was re-sent for over 30 seconds across several dispatch cycles, although src/cli/channel-telegram.ts documents that a pending request is offered again on the next cycle. On a hosted machine the approver often taps from a phone the operator mapped by hand, so a single wrong user id turns the approver's first tap into a dead prompt with no way to answer short of an operator restart, and the request sits pending until the TTL lapses. The webhook listener (src/cli/channel-telegram-webhook.ts) and the polling listener (src/channels/telegram.ts) should be checked together: the delivery and nonce maps that make a refused tap final for that card must not also mark the REQUEST as delivered. Fail closed is kept throughout: the unmapped tap stays refused and recorded; what changes is that the mapped approver can still answer.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A test with the fake Bot API: a request is pending, an unmapped account taps it (refused sender-unmapped, one audit.decision_refused), then within one dispatch cycle the mapped approver can still answer, either on the original card or on a re-sent one, and approval.granted is recorded by the mapped human
- [ ] #2 The same holds for the webhook listener and the polling listener, shown by one test each
- [ ] #3 A refused tap never marks the request itself as delivered or answered; the delivery and nonce state it touches is named in the implementation notes
- [ ] #4 The refusal path is unchanged: the unmapped tap is still refused sender-unmapped and attributed to nobody, with no new fail-open branch
<!-- AC:END -->
