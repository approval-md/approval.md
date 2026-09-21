---
id: APRV-424
title: >-
  Telegram webhook transport: decisions arrive by webhook so no long-poll
  process needs to run
status: To Do
assignee: []
created_date: '2026-09-21 06:42'
labels:
  - telegram
  - channels
  - webhook
dependencies: []
priority: medium
ordinal: 325000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC section 10.3 lists channels as transport that holds no state; the Telegram channel today long-polls getUpdates, which requires one always-running process per bot and forbids a second poller on the same token. A webhook mode registers a URL with setWebhook and receives updates as HTTP posts, which is what makes a serverless or sleep-when-idle daemon possible (the hosted layer's wake-on-event shape) and what lets one bot serve many tenants behind a router that dispatches by chat. Verification of the update, sender mapping (approvers.<id>.senders, APRV-324), the decision record and the annotate-after-decision path are unchanged; only the arrival changes. The secret_token header Telegram supports must be required so a forged post is refused.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval channel telegram webhook registers the URL with a secret token and serves the callback; a post without the matching secret is refused and logged as a refusal, never a decision
- [ ] #2 A tap arriving by webhook produces the same approval.granted or approval.rejected record, through the same sender mapping, as a tap arriving by long-poll, shown by a shared contract test
- [ ] #3 Long-poll and webhook are mutually exclusive per bot at runtime, with a clear refusal when both are configured
- [ ] #4 docs/cli-reference.md documents the mode and the proxy or tunnel requirement; the channels conformance suite passes
<!-- AC:END -->
