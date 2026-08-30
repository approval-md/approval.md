---
id: APRV-165
title: 'The claimed block sits beside the buttons: WHAT THIS DOES as the last message'
status: To Do
assignee: []
created_date: '2026-08-30 21:51'
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
- [ ] #1 Message order per prompt: computed header, payload chunk(s), claimed block; the inline keyboard is on the final claimed message and callback arming still keys off that delivery id
- [ ] #2 The claimed block heading names the claiming author and says NOT verified; gloss renders first within it
- [ ] #3 The claimed segment is chunked like the payload (unbounded rationale survives), keyboard on the final chunk
- [ ] #4 A request with no gloss, no summary, no rationale still sends the claimed message showing explicit absence
- [ ] #5 Digest member prompts keep keyboard-free delivery with the same ordering; the digest card is unchanged
- [ ] #6 RenderedRequest lines and the conformance suite are unchanged and pass
<!-- AC:END -->
