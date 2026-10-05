---
id: APRV-480
title: >-
  Review card shows the sampled subject's payload: ReviewCardFields includes
  fullPayload so the reviewer sees the published text, not a uuid and the
  agent's own summary
status: In Progress
assignee: []
created_date: '2026-10-05 06:51'
updated_date: '2026-10-05 07:46'
labels:
  - agentvillage
dependencies: []
priority: high
ordinal: 365000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Supervised-retro, in scope for Oct 11 (Carter, 2026-10-04), from claude-main's investigation. The review card for a sampled subject currently shows a uuid and the agent's own summary of what it did, so the reviewer cannot judge the text that was actually published. ReviewCardFields should include fullPayload so the card carries the payload the subject sent.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The review card renders the payload bytes, or their hash when the channel cannot show them, and says which of the two it shows
- [x] #2 A test per card renderer covers the bytes case and the hash-only case, including the label
- [x] #3 Docs updated: what a reviewer sees per channel
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Lane A3 (claude-edge/A3), branch lane/aprv-480-483, one PR for APRV-480..483 (commits 6801e67d, 11bd24b4).

Done:
- `ReviewCardFields` (src/channels/telegram.ts) now picks `fullPayload` and an optional `payload_hash`. `cli/audit-card.ts` fills them: the bound hash comes from the `execution.started` payload, falling back to the registration; the bytes are hash-checked against it (`renderingFor`), so substituted bytes give `null`.
- `reviewPayloadView(card)` (pure) decides between `bytes` (whole canonical rendering, escaped length <= REVIEW_PAYLOAD_BUDGET = 2000), `hash` (reason `unavailable` or `too-long`) and `none`. `renderReviewCard` draws one of three headings: TELEGRAM_REVIEW_PAYLOAD_BYTES / _HASH_ONLY / _NONE. Bytes are shown whole or not at all, because a card is one message edited in place.
- `core/audit.ts` `boundPayloadHash(records, subject)` is the shared derivation (APRV-481 uses it).
- Docs: docs/cli-reference.md, Telegram review-card section, with a table of what a reviewer sees on each channel (a terminal review shows no payload). CHANGELOG entry.

Decided: the Telegram card is the only card renderer. The CLI has no card: `audit list` prints rows, and a terminal review never records a payload_hash.

Security review finding (coordinator relay, "resource-cap defeat / review-delivery DoS in src/channels/telegram.ts"): CONFIRMED IN PART, FIXED in 11bd24b4.
- Path: `reviewPayloadView` ran canonicalRender + escapeHtml over the whole payload on every render, redraw and tap before it concluded too-long. The party under review chooses the payload size, and supervised payloads have no cap (PROPOSE_PAYLOAD_MAX_BYTES binds proposals only). `cli/audit-card.ts` also held the whole text in listener memory.
- Fix: REVIEW_RENDER_INPUT_MAX = 8 x budget. A longer or truncated rendering becomes hash-only `too-long` and is never rendered. The builder keeps a truncated prefix of at most that length.
- Pinning test: tests/channels-telegram.test.ts "APRV-480: an agent-sized payload costs a review card bounded work". It uses a payload value that throws on any access. Removing the short-circuit fails it, and so does removing the builder truncation.
- Not reachable: a message flood. offerReview sends one message per card, refusals and settles edit that message, and the payload is never split. The ForceReply note prompt is sent once per human tap; that path predates this change and this change does not touch it.

Resume point: none (lane complete; PR open).

PROPOSED SPEC HUNK (pending sign-off; no SPEC.md edit made). §10.3 "Review delivered through a channel":
- replace: "the card carries no payload region, offers no approval, accepts no token"
- with: "the card offers no approval and accepts no token. It carries a payload region showing either the bytes the sampled execution bound to, whole, or that binding's hash with the reason the bytes are absent, and its heading says which; a channel MUST NOT show part of the bytes as the payload (Amended APRV-480)."

Resume point (fix round 1, refutation of PR #614): no fix landed yet; next is F1 in src/core/audit.ts reviewerRoster (refuse when the policy load is not ok or the resolution is fail-closed). Next command: node scripts/run-tests.mjs --only audit
<!-- SECTION:NOTES:END -->
