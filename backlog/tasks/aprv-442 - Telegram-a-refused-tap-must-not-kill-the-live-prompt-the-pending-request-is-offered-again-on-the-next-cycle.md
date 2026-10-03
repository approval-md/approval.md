---
id: APRV-442
title: >-
  Telegram: a refused tap must not kill the live prompt; the pending request is
  offered again on the next cycle
status: Done
assignee:
  - '@claude-opus-lane-c3'
created_date: '2026-09-25 08:08'
updated_date: '2026-10-03 13:44'
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
- [x] #1 A test with the fake Bot API: a request is pending, an unmapped account taps it (refused sender-unmapped, one audit.decision_refused), then within one dispatch cycle the mapped approver can still answer, either on the original card or on a re-sent one, and approval.granted is recorded by the mapped human
- [x] #2 The same holds for the webhook listener and the polling listener, shown by one test each
- [x] #3 A refused tap never marks the request itself as delivered or answered; the delivery and nonce state it touches is named in the implementation notes
- [x] #4 The refusal path is unchanged: the unmapped tap is still refused sender-unmapped and attributed to nobody, with no new fail-open branch
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Root cause: on a refused unit tap TelegramChannel.routeCallback calls annotateQuietly, whose disarm() forgets the card's nonces, while the listener's DispatchState.delivered keeps the action key, so dispatchPending never re-sends it and the old card's action-ref fallback finds no live delivery: a dead prompt until restart.
2. Channel: when a decision on the unit-tap path comes back refused (or the handler throws) and the card is disarmed, remember the action key in a released set; expose takeReleased() which drains it. No change to the refusal itself, the ack, the annotation text, or the nonce maps.
3. dispatchPending (shared by listen and webhook): drain takeReleased() before computing the undelivered set; for each released key the verified log still calls pending, forget its delivery bookkeeping (delivered, sentAtMs, attempts, annotated, warned) and clear it from paced.current, so the same cycle re-sends a fresh card. Keys no longer pending are left to the terminal annotation pass.
4. Tests (fake Bot API, mapped policy): one per transport. Pending request, unmapped tap refused sender-unmapped with exactly one audit.decision_refused, still pending; next dispatch cycle re-sends; mapped account answers and approval.granted is recorded by the mapped human. Replay of the refused callback is refused again.
5. npm test, lint, typecheck; CHANGELOG line; notes naming the state touched.

6. Refuter finding 1: the refused card's nonces (and the tap's) go into a capped refusedNonces set before the disarm; a nonce in it takes no action-reference fallback, so a redelivered or replayed refused tap reaches neither the gate nor the fresh card.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Resume point: fix and four listener tests in place in the worktree (uncommitted); next is the full suite with --baseline, lint, CHANGELOG, commit, push, PR.

Root cause: on a refused unit tap, TelegramChannel.routeCallback annotates the card, and annotate() -> disarm() deletes the card's nonces from the channel's deliveries map. The listener's DispatchState.delivered still held the action key, so dispatchPending's undelivered filter skipped it every cycle; the terminal pass ignored it (the log says requested); the stale prune ignored it (still pending). The original card's bytes fell through to liveDeliveryFor(actionRef), which found nothing live. Dead prompt until restart.

State a refused tap touches (AC3). Channel (src/channels/telegram.ts): deliveries, where disarm() (unit card) or settleMember() (digest member) removes that card's nonces, unchanged; digests/allNonces only through disarm() as before; NEW released (Set of action keys, drained by takeReleased()); NEW refusedNonces (Set of the disarmed nonces plus the tap's nonce, capped at TELEGRAM_REFUSED_NONCE_CAP = 1024, oldest dropped). Listener (src/cli/channel-telegram.ts, dispatchPending): for a released key the verified pending queue still holds AND state.delivered holds, forget() clears delivered, sentAtMs, attempts, annotated and warned, and paced.current is set to null when it contains the key; pruned reports reason 'released'. The request itself is never marked delivered or answered by a refusal: nothing adds to delivered except a successful send, and the log is the only source of 'pending'. Released keys the log has settled are dropped from the set and left in delivered for the terminal annotation pass.

Refusal path (AC4): unchanged. Same recordChannelDecision call, same audit.decision_refused by system:gate with no payload actor, same ack and NOT RECORDED annotation, same disarm. No new refusal code, no new anomaly kind; a refused-card tap is the existing unknown-callback ignore with a distinct detail string.

Both listeners share dispatchPending and TelegramChannel, so one fix covers listen (polling) and webhook. Also released on the handler-threw path, which disarms a card without settling anything.

Invariants touched (CLAUDE.md global list): fail closed. The re-send only offers what buildPendingQueue derives from the verified log, and a fresh card's taps go through the same gate and sender resolution. Refusals stay machine-readable and distinct.

Refuter (fresh opus): no blocker. Fixed finding 1 (a replay or webhook redelivery of the refused bytes would have resolved via action ref to the fresh card, appended another refusal and forced another re-send per replay) with refusedNonces; the test now asserts redelivery of the same update and replays by both accounts append nothing and send nothing. Wrote these notes (finding 2). Reworded the released-set comment (finding 7). Kept as residuals: (3) under paced, clearing current for one member of a digest group can leave two questions on the phone until the digest's siblings are answered; chosen over a stall because AC1 wants the answer within one cycle. (4) under paced, a due checkpoint prompt goes out first and the re-offer slips one cycle. (5) polling: an unmapped tap and the mapped tap in the same getUpdates batch, the mapped one finds no live card (ignored, nothing recorded) and the approver taps the fresh card. (7) a refused digest member keeps 'Not recorded' on the old digest; the new card carries the outcome. Each new unmapped tap on a fresh card is one refusal record and one re-sent card, the same volume as taps on any live card. Webhook cold process: released and refusedNonces are lost on restart, which costs nothing because the startup dispatch re-sends everything pending before the receiver binds; timer cycles and update handling are serialized (handle.serialize).

Validation: tests/telegram-webhook.test.ts, four cases (poll and webhook x burst and paced), failing before the fix (cycle after refusal delivered []), passing after. Related suites (telegram-webhook, channels-telegram, sender-identity, checkpoint-tap, gesture-refusal, telegram-tap-latency, channels-contract): 321 pass, exit 0. Full suite before the refuter fix: 5393 pass, 0 fail, exit 0, no new failures vs baseline. Lint and tsc exit 0.

Validation after the refuter fix: full suite 5393 pass, 0 fail, exit 0, no new failures vs scripts/ci-baseline.json; lint exit 0; tsc exit 0.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A refused Telegram tap (sender-unmapped and every other ok:false, plus a thrown handler) now releases its card: the channel records the disarmed nonces as dead and the action key as released, and dispatchPending, shared by listen and webhook, re-offers any released request the verified log still calls pending in the same cycle. The refusal record, its attribution to nobody and its wording are unchanged; the refused card's bytes stay dead, including on a webhook redelivery. Verified by four fake-Bot-API tests in tests/telegram-webhook.test.ts (poll and webhook x burst and paced) that failed before the fix, and by the full suite (5393 pass, exit 0).
<!-- SECTION:FINAL_SUMMARY:END -->
