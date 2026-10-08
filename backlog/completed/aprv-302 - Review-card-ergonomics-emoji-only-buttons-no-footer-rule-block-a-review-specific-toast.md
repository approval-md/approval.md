---
id: APRV-302
title: >-
  Review card ergonomics: emoji-only buttons, no footer rule block, a
  review-specific toast
status: Done
assignee:
  - '@claude'
created_date: '2026-09-07 23:36'
updated_date: '2026-09-08 01:45'
labels:
  - channels
dependencies: []
ordinal: 222000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter's first live review cards (2026-09-07) were too verbose.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 REVIEW_BUTTON_LABELS in src/channels/telegram.ts become bare emoji: check mark and stop sign on row one, thumbs-down, neutral, thumbs-up, heart on row two.
- [x] #2 The TELEGRAM_REVIEW_RULE block (Nothing here is pending and no button on this card authorizes anything...) is removed from the rendered card; the heading REVIEW - THIS ALREADY RAN carries the meaning.
- [x] #3 Review taps answer with their own toast (e.g. Heard - recording your review. The card will say what the log recorded.) instead of TELEGRAM_ACK_HEARD; the note-prompt toast is unchanged.
- [x] #4 tests/channels-telegram.test.ts expectations updated; docs/cli-reference.md telegram section and docs/dogfood-cutover.md review-card section reflect the new card.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/channels/telegram.ts: REVIEW_BUTTON_LABELS become bare emoji, two-row layout unchanged.
2. Delete TELEGRAM_REVIEW_RULE (no test or doc imports it) and drop the lines.push that appended it in renderReviewCard; the heading and the deny-armed heading stay, as do refusal notices and the COMPUTED/CLAIMED split.
3. Add TELEGRAM_REVIEW_ACK and answer review taps with it at the two safeAnswer sites in the review handler; the deny-arm and note-prompt toasts and the request-card TELEGRAM_ACK_HEARD are untouched.
4. tests/channels-telegram.test.ts: assert the six bare-emoji labels in their two rows, assert the rule prose is gone, assert review taps toast TELEGRAM_REVIEW_ACK while the request digest keeps TELEGRAM_ACK_HEARD. Keep every no-payload/no-approve/no-token assertion.
5. docs/cli-reference.md telegram section and docs/dogfood-cutover.md review-card section describe the emoji buttons and stop promising the on-card rule paragraph; CHANGELOG entry under 0.1.0.
6. npm run build, node --test on the two compiled suites, then full npm test and npm run lint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
APRV-302 landed in src/channels/telegram.ts, with no change needed in src/cli/channel-telegram.ts (it imports only the settled headlines, never the labels, the rule or the ack).

**AC1 — bare emoji buttons.** REVIEW_BUTTON_LABELS drops the word beside every glyph. The two-row layout is untouched (verdict row [ok, deny], grade row REACTIONS in worst-to-best order), so the tap coordinates a reviewer has learned do not move. Emoji still live only in the label table and never in message text, which was already the rule here.

**AC2 — no footer rule block.** TELEGRAM_REVIEW_RULE is DELETED, not kept and unused: nothing outside renderReviewCard referenced it (no test, no doc, no other module), so an exported constant nobody renders would be a second place for the card's wording to live. What the four sentences carried is carried elsewhere and was already: 'nothing is pending' is TELEGRAM_REVIEW_HEADING plus the summary line in cli/channel-telegram.ts (reviewSummaryLines already says 'no card here authorizes anything'), and the deny latch is TELEGRAM_REVIEW_ARM_TOAST on the first tap plus TELEGRAM_REVIEW_ARMED in the card's own headline until it is spent. Everything else on the card is untouched: heading, deny-armed heading, refusal notices with their codes and the 900-char trimNotice cut, the COMPUTED/CLAIMED split, and the per-row (origin) suffixes.

**AC3 — a review-specific toast.** New TELEGRAM_REVIEW_ACK ('Heard — recording your review. The card will say what the log recorded.') answers the two safeAnswer sites inside handleReviewTap: the ok / second-deny branch and the reaction branch that records straight off the tap (indifferent, liked, and a liked/loved that core/audit.ts is going to refuse). TELEGRAM_ACK_HEARD's 'deciding' is a request card's word and stays on request and digest cards, where the tests still pin it. TELEGRAM_REVIEW_ARM_TOAST and TELEGRAM_REVIEW_NOTE_TOAST are byte-identical. The note-reply recording path answers no callback at all, because a reply is a message rather than a callback query, so there was no toast there to change; the new test pins that (no extra answerCallbackQuery on a note reply) so a future 'ack the note too' cannot be added silently.

APRV-206's invariant is preserved deliberately: the new toast, like the old one, claims only that the tap ARRIVED. It says 'recording', never 'recorded'. At the instant it is sent nothing has been appended and core/audit.ts may still refuse, and what the log actually took is the card edit that follows. Touches no global invariant in SPEC §11.1: this is display and toast wording only, no enforcement path reads any of it, and nothing here mints, widens or narrows anything.

**AC4 — tests and docs.** tests/channels-telegram.test.ts: the card-shape test now pins the exact keyboard ([['✅','🛑'],['👎','😐','👍','❤️']]) and asserts five phrases from the old rule block are ABSENT, so a reworded footer fails too. Every assertion about what the card must not carry is kept verbatim and none was weakened: no PAYLOAD region, no TELEGRAM_PROMPT_HEADING, no button that parses as a DECISION via parseCallbackData, callback_data under TELEGRAM_MAX_CALLBACK_BYTES, and the file's assertNoTokenInEdits/assertClean sweeps. Two new tests were added at the END of the review block on purpose: the mock Bot API accumulates requests for the whole file (it is started once in before()), and inserting a test that sends a ForceReply prompt mid-block broke the existing 'deny with loved' case, which scans every message ever sent for a force_reply. The first new test slices mock.answerTexts() from its own start for the same reason.

docs/cli-reference.md telegram section: the button list and the tap table are emoji, a paragraph says the card does not print that table under itself and names the two things that say themselves instead, and the new ack is quoted. docs/dogfood-cutover.md review-card section: a new bullet for the two-row emoji keyboard, the tap bullets reworded to the emoji, and a bullet for the ack with the deny-arm exception. CHANGELOG entry under 0.1.0 (unreleased).

**Verification.** npm run build clean. node --test dist/tests/channels-telegram.test.js dist/tests/values-inert.test.js: 152 tests, 152 pass, 0 fail, exit 0. Full npm test: 3871 tests, 3870 pass, 0 fail, 1 skipped, exit 0. npm run lint (oxlint src tests): exit 0.

**Note for the orchestrator.** Every Edit in this session drew a PostToolUse complaint from approval hook claude-code: post-tool-gate-refused:not-delegated, 'no execution.started record names task hook:<session>:<tool id>'. The edits all applied and the pre-tool gate allowed each one; it is the completion report that closes nothing, because this worktree session never registered an execution for these tool ids. Worth a look if it is not already known, since it means these edits accrue no completion in the log.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Review cards lost the words on their buttons and the four-sentence rule block under them, and gained their own toast. REVIEW_BUTTON_LABELS is bare emoji in the same two rows; TELEGRAM_REVIEW_RULE is deleted (nothing else referenced it) and renderReviewCard no longer appends it, the heading and the DENY ARMED headline carrying what it said; review taps that record answer with the new TELEGRAM_REVIEW_ACK while request cards keep TELEGRAM_ACK_HEARD and the deny-arm and note-prompt toasts are unchanged. Verified by the suite: new cases pin the exact keyboard, the absence of five phrases from the old rule block, and the toast on each recording path, with every no-payload/no-approve/no-token assertion kept. npm run build clean; the two named suites 152/152 exit 0; full npm test 3871 tests, 3870 pass, 0 fail, 1 skipped, exit 0; npm run lint exit 0. Docs (cli-reference telegram section, dogfood-cutover review-card section) and a 0.1.0 CHANGELOG entry match the new card.
<!-- SECTION:FINAL_SUMMARY:END -->
