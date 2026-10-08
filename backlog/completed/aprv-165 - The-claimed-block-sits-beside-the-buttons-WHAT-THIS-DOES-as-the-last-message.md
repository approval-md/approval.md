---
id: APRV-165
title: 'The claimed block sits beside the buttons: WHAT THIS DOES as the last message'
status: Done
assignee: []
created_date: '2026-08-30 21:51'
updated_date: '2026-08-31 18:30'
labels: []
dependencies:
  - APRV-163
  - APRV-164
ordinal: 142000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The claimed lines (gloss, summary, est. cost, rationale, confidence) currently sit mid-thread under the computed block, far from the Approve/Reject keyboard, so the reader decides next to bookkeeping instead of next to the description of the act. Restructure the Telegram delivery so the message order is: header + computed block, then the payload messages, then a final claimed message headed "WHAT THIS DOES — CLAIMED by <author>, NOT verified by the runtime" with the gloss first, carrying the keyboard. SPEC §10.3/§10.4 permit claimed material appended around the canonical block when visibly separated and labelled; the computed/claimed split is preserved, only its position moves. The claimed message is always sent, even when every value is "(none given)", so the keyboard has a stable home and a missing summary is visible rather than absent.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Message order per prompt: computed header, payload chunk(s), claimed block; the inline keyboard is on the final claimed message and callback arming still keys off that delivery id
- [x] #2 The claimed block heading names the claiming author and says NOT verified; gloss renders first within it
- [x] #3 The claimed segment is chunked like the payload (unbounded rationale survives), keyboard on the final chunk
- [x] #4 A request with no gloss, no summary, no rationale still sends the claimed message showing explicit absence
- [x] #5 Digest member prompts keep keyboard-free delivery with the same ordering; the digest card is unchanged
- [x] #6 RenderedRequest lines and the conformance suite are unchanged and pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read renderTelegram/sendPrompt/deliverOne and digest paths in src/channels/telegram.ts, plus the message-sequence tests.
2. Split TelegramRendering into header (heading + action key + computed block) and claimedText (WHAT THIS DOES heading, gloss first, then summary, est. cost, rationale, confidence).
3. sendPrompt order: header, payload chunks, claimed chunks; keyboard on the final message; claimed message always sent so absence is visible and the keyboard has a stable home.
4. Chunk claimedText via chunkForTelegram; digest members keep keyboard-free delivery; digest card unchanged.
5. lines[] unchanged in content so conformance sees every rendered field; delivery-id still the buttoned last message.
6. Targeted verification (machine under heavy load): channels-telegram, channels-contract, channels-cli, channels-web, cli-hook, e2e demo test files standalone + lint; full suite before the PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built 2026-08-31 by an Opus subagent, reviewed by fable. TelegramRendering gained claimedText (always non-empty); header is heading + action key + COMPUTED only; lines[] keeps computed-then-claimed content so conformance is untouched. sendPrompt sends header, payload chunks, claimed chunks, keyboard and deliveryId on the final claimed chunk; continuation claimed chunks carry a "(continued) — CLAIMED, NOT verified" heading so no claimed line arrives unlabelled. Deviation, accepted at review: claimed chunking uses a new chunkClaimedForTelegram rather than chunkForTelegram, because the claimed segment is live markup (chunkForTelegram may cut anywhere only because its caller escapes and <pre>-wraps each chunk); the new splitter keeps tags and entities atomic and breaks at line boundaries, so every chunk is balanced HTML — its input is already escaped, so raw length is wire length. Digest members share the path with keyboard null; renderDigest and the size guard untouched. Verified under extreme host load (load avg >150) with targeted compiled suites: channels-telegram 95/95 (incl. shared conformance), channels-contract + channels-cli + channels-web + wysiwys 91/91, tsc --noEmit clean, oxlint clean; e2e heading regexes updated as literals. Full suite runs before the PR merges (CI aggregator + a local background run).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The claimed block is the last message, headed WHAT THIS DOES — CLAIMED by <author>, NOT verified by the runtime, gloss first, keyboard riding on it; payload sits between the computed header and it; claimed chunking is markup-safe so unbounded rationale splits into balanced-HTML messages. Verified by six new message-sequence tests plus the shared conformance suite; tsc and lint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
