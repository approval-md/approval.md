---
id: APRV-480
title: >-
  Review card shows the sampled subject's payload: ReviewCardFields includes
  fullPayload so the reviewer sees the published text, not a uuid and the
  agent's own summary
status: Done
assignee: []
created_date: '2026-10-05 06:51'
updated_date: '2026-10-08 01:14'
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

Fix round 1 (refutation of PR #614), lane claude-edge/A3-fix1. The resume point above is spent; nothing is in flight.
- F4 (should-fix) FIXED in 327baedb. Summary capped at 400 chars, other rows at 300, both with a '+N chars not shown' marker; pathologically long rows are cut further in fixed steps (REVIEW_CAP_LEVELS) until the frame + longest heading + largest notice + hash region fit 4096 visible chars. Notice region capped at 600, settled detail at 3000. reviewPayloadBudget(card) replaces the constant 2000 (min of 2000 and the headroom), pure over the card so the drawn view and the tap's view agree. dispatchReviews marks a sample whose offer threw as terminal-only (coded 'approval: telegram review-offer-failed:' line naming approval audit review <seq> --ok|--deny) and offers the next one. Tests: the four 'PR #614 refutation F4' tests in tests/channels-telegram.test.ts; each of the four predicates mutated off fails its test.
- F3 (card state per sender, APRV-482 surface) FIXED in e0fd9498, see APRV-482.
- Follow-ups filed: APRV-485 (N1 rebuild cost), APRV-486 (N2 bidi/invisible chars in the bytes view).
- SPEC hunk §10.3 (APRV-480) gains: 'The whole card MUST fit one message: claimed and computed rows are cut with a marker, and the payload region's budget is what the rows leave.'
Evidence: tsc --noEmit exit 0; oxlint src tests exit 0; run-tests --only audit event-schema money channels-telegram render-queue conformance-regen conformance autonomy-split values-inert cli-feedback cli-help cli-long-help cli-instructions docs-guard gate gate-window reindex retro-rate daemon telegram-webhook exit 0, 690 pass, 0 fail.

Fix round 2 (impact-scoped recheck of PR #614).
- NF-2 FIXED in bd57fcb7 (docs dca30922). dispatchReviews makes a sample terminal-only at once only on a deterministic Bot API refusal of the card (isDeterministicSendRefusal: HTTP 400 whose description is "message is too long", "can't parse entities", "message text is empty"/"text must be non-empty", "reply markup is too long", BUTTON_DATA_INVALID, ENTITIES_TOO_LONG). Every other failure (429, timeout, 5xx, network, a non-TelegramApiError throw) counts against a per-sample budget (REVIEW_OFFER_ATTEMPTS = 5) and pauses the review walkthrough for max(backoff, retry_after); backoff 60 s doubling per attempt; retry_after parsed from parameters.retry_after into TelegramApiError.retryAfterSeconds. The same sample is retried first after the pause (the pause is the walkthrough's, so an outage spends one sample's budget at a time, not every sample's). A spent budget prints the coded review-offer-failed line and the queue moves on; a transient failure prints review-offer-retry. chat not found / bot blocked are deliberately not deterministic (chat state, not the card). Process memory, pruned when the sample closes.
- Tests (channels-telegram): 'PR #614 recheck NF-2: only the Bot API refusing the card itself is deterministic'; '... one 429 does not hide the sample, its retry_after is honoured, and later samples still flow'; '... a deterministic 400 marks the sample terminal-only with the coded line'; '... transient failures spend a per-sample budget with backoff, then the sample is terminal-only'. The F4 offer test now throws a real TelegramApiError 400. Mutations in built JS (terminal on every failure; pause ignored; retry_after ignored; deterministic forced false) each fail a named test.

Closed by the 2026-10-08 backlog sweep (claude-b3/SWEEP-APRV-1): all ACs ticked; shipped in PR #614 (APRV-480..483 supervised-retro core) merged 27980de0 on 2026-10-05; released in 0.4.1 (v0.4.1, PR #622 5f9b9c3d).
<!-- SECTION:NOTES:END -->
