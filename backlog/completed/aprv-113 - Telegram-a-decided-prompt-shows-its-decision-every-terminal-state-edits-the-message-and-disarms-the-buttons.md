---
id: APRV-113
title: >-
  Telegram: a decided prompt shows its decision - every terminal state edits the
  message and disarms the buttons
status: Done
assignee:
  - '@fable'
created_date: '2026-08-20 09:24'
updated_date: '2026-08-20 10:16'
labels:
  - channels
  - ux
milestone: m-12
dependencies: []
priority: high
ordinal: 105000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Human feedback 2026-08-20: "i need the buttons to respond to being pressed (approve/deny) so that i know which messages i have answered". Today a tap answers the callback with a toast and records the decision, but the message keeps its text and its live buttons, so the chat is a wall of identical-looking prompts with no visible answered/unanswered distinction; the same holds for requests that expire or are decided at another surface (CLI grant, web page) while the Telegram prompt sits there. APRV-106 already built the mechanism: TelegramChannel.retract() rewrites the message and removes the keyboard in ONE editMessageText call and the nonce is deleted so a stale tap refuses. GENERALIZE IT: any terminal state observed for a delivered message edits that message. DESIGN: (1) On a decision the listener itself records (the tap path in src/cli/channel-telegram.ts after recordChannelDecision succeeds), edit the message to the outcome line: a glyph and word (APPROVED / REJECTED), the action key, by <human:id> at HH:MM UTC, and the seq; buttons removed; the existing one-call pattern and the replace-not-append rationale from retract() hold (the payload bytes stay recoverable from the log and payload store; SPEC 10.3 requires the full payload BEFORE the decision, not after). (2) On the poll cycle, a delivered message whose request the verified log now shows terminal (granted, rejected, revoked, expired, withdrawn) for ANY reason, including decisions taken at another surface and daemon expiry, gets the same edit with the matching word (EXPIRED, REVOKED, and the existing WITHDRAWN path folds into the shared helper); the listener process-local delivery memory already maps message ids to action keys, and its loss degrades to messages that stay un-annotated (never to a wrong annotation), matching the re-send-degradation stance of SPEC 10.3. (3) Batch messages (one keyboard over several requests): each decided member is annotated within the batch message or the batch is re-rendered showing per-member outcomes; do not leave one member undecidable because another was decided; follow the existing batch rendering. (4) The token stays OFF the chat: the edit never contains the token; the panel on the listener terminal is unchanged. (5) The edit is best effort exactly as retract(): a failed edit is cosmetic, logged to stderr, never blocks the decision or the loop. (6) Conformance (src/channels/conformance.ts): a channel must not present a terminal request as pending nor leave its decision affordance armed; web and cli channels already satisfy this by re-deriving per view, assert it. Mock Bot API records edits already (APRV-106 tests); extend for the decision path.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A tap edits the message to APPROVED or REJECTED with actor, time and seq, and removes the buttons, in one editMessageText; a second tap on any stale copy refuses and records nothing
- [x] #2 The poll cycle annotates delivered messages whose requests turned terminal elsewhere (CLI or web decision, expiry, revocation) with the matching word; withdrawn folds into the shared helper
- [x] #3 Batch messages annotate per member without disarming undecided members; the token never appears in any edit; a failed edit never blocks the decision
- [x] #4 Conformance asserts no terminal request is presented as pending on any channel; npm test and lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from main. 2. Generalize retract() into one annotate helper (one editMessageText, replace not append, nonce dropped). 3. Tap path edits to APPROVED/REJECTED with actor, time, seq; token never in an edit. 4. Poll cycle annotates deliveries whose requests turned terminal elsewhere (cross-surface decisions, expiry); memory loss degrades to un-annotated, never wrong. 5. Batches re-render per member, or all-terminal fallback documented. 6. Conformance: no terminal request presented as pending on any channel. 7. PR by branch via the merge queue; notes here.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR by branch aprv-113-decided-prompts (#98), merged at a0efe8c; primary dist rebuilt, so the next listener restart annotates decided prompts. annotate(deliveryId, outcome, detail[]) on TelegramChannel: disarm() drops every nonce for the message and returns the action key, then ONE editMessageText with the bold outcome, code-formatted key, and detail lines, no reply_markup; retract() is now annotate with the withdrawn headline, wording byte-identical. Glyphs: check/cross APPROVED REJECTED REVOKED EXPIRED, no emoji (message text on this channel is emoji-free; emoji live only on button labels). Batches needed no fallback: telegram batches are one message per member with a shared batch_delivery_id, so deciding one member edits exactly one message. Poll cycle: terminalDeliveries() annotates deliveries whose requests turned terminal elsewhere (CLI/web decisions, daemon expiry); memory loss degrades to un-annotated, never wrong. DELIBERATE CHANGE: a second tap on a decided request is refused by the channel as unknown-callback (the annotation forgot the nonce), not by the gate as already-decided; neither appends; test renamed to pin no-second-event. Poll annotation reads requestState with ttlMs null, so a TTL lapsed only by arithmetic is not annotated until the daemon writes approval.expired: an annotation states what the log says. Conformance gained check (f): no terminal request presented as pending or left armed. Token absent from every edit (hex sweep over the mock's recorded edits). 1879 tests, lint and typecheck clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Decided Telegram prompts rewrite themselves: tap or cross-surface decision or expiry edits the message to its outcome with actor, time and seq, and removes the buttons; one shared annotate helper; conformance guards it on every channel. PR #98 merged at a0efe8c; 1879 tests.
<!-- SECTION:FINAL_SUMMARY:END -->
