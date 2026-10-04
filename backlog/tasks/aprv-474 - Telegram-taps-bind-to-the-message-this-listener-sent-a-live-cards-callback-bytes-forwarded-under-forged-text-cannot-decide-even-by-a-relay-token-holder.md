---
id: APRV-474
title: >-
  Telegram taps bind to the message this listener sent: a live card's callback
  bytes forwarded under forged text cannot decide, even by a relay-token holder
status: To Do
assignee: []
created_date: '2026-10-04 23:53'
labels:
  - agent-village
dependencies:
  - APRV-456
priority: high
ordinal: 361000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The residual the refuter on PR #605 (APRV-456, 2026-10-04) named and the lane did not fix. With the stale-copy fallback off behind a relay, a holder of the per-tenant relay token can still obtain a LIVE card's callback bytes (guess the sequential message id, forwardMessage the real card: the response carries its buttons) and put them under forged text; the approver's genuine tap then carries a nonce this process is holding and decides. Two halves: (core, this task) bind each tap to the message_id this process sent for that delivery (callback_query.message.message_id must equal the delivery's recorded message id, and the chat must match), and echo-check the text the process sent so a forwarded or edited copy is refused with a distinct code (nonce-message-mismatch or similar, added to the frozen channel decision refusal union with a vector); both listeners; tests with the fake Bot API including the forward route; direct shape unchanged in behaviour except that a forwarded copy of a live card no longer decides (say so in docs; APRV-196's re-delivery on restart still works because the listener re-sends and records the new message id). (control plane, filed in agentvillage-data as the relay half) the relay refuses forwardMessage and getUpdates outright and editMessage* for any message id the daemon did not send through it. docs/hermes-hook.md For Agent Village gets the closed residual.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A tap whose callback_query.message.message_id or chat does not match the delivery this process recorded is refused with a distinct code before decide(); at most one audit record; tests on both listeners including the forwardMessage route
- [ ] #2 The frozen channel decision refusal union gains the code with a conformance vector; refusal-unions regenerated per the collision rule
- [ ] #3 Direct-shape tests from APRV-196 and APRV-456 still pass; docs state the rule and the remaining residual, if any
<!-- AC:END -->
