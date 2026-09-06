---
id: APRV-256
title: Telegram /queue wording must not imply a visible approval card
status: In Progress
assignee:
  - '@opus-256'
created_date: '2026-09-04 22:30'
updated_date: '2026-09-06 07:49'
labels:
  - telegram
  - channels
  - ux
dependencies: []
references:
  - APRV-216
  - APRV-218
  - src/cli/channel-telegram.ts
  - src/channels/telegram.ts
documentation:
  - docs/cli-reference.md
priority: medium
type: bug
ordinal: 194000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed on 2026-09-04: /queue reported three pending requests, marked one shown now, and said Tap the buttons on the message above, but the user could see no approval buttons. /queue is a summary-only reply; the listener marker records an earlier successful delivery and cannot establish that its card remains visible. /skip recovered navigation without deciding requests. Follow up APRV-216 with accurate wording and discoverable recovery instructions. Scope is user-facing wording and matching documentation/tests, not new commands, decision controls, policy changes or live service reconfiguration. Before implementation, inspect concurrent APRV-218 prompt-layout work and coordinate shared channel/documentation ownership.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The /queue reply explicitly identifies itself as a pending-request list without decision buttons and directs decisions to a separate approval card without assuming its position or visibility.
- [x] #2 Replace shown now and message above wording with language describing listener selection or prior delivery; missing or deleted cards are never asserted to be currently visible.
- [x] #3 When an approval card cannot be found, the reply explains /skip recovery, that requests remain pending and no decision is made, and that a fresh card arrives on a later listener cycle with possible gloss delay. /next is not described as a resend command.
- [x] #4 Focused rendering and command tests cover selected-item, no-selected-item and empty-queue wording; existing navigation remains non-decisional and log-free. Update corresponding CLI/Telegram documentation and pass applicable repository checks.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read the /queue surface end to end: `queueLines`/`summaryLines` (src/cli/channel-telegram.ts ~711-783), the `commandHandlerFor` branches for `queue` and for the no-selection reply (~1840-1875), the listener marker `state.paced.current`, tests/channels-telegram.test.ts (the /queue command test ~4455 and the rendering test ~4718), and docs/cli-reference.md ~2826-2860 plus docs/dogfood-cutover.md:195. Confirm commands are wired only under `delivery: paced` (listen ~1942), so the wording may speak of one selected request.
2. Rewrite `queueLines` output, output only, no decision or log behaviour:
   - A self-identification line under the summary: this reply is a list of what the log holds, it carries no decision buttons, and decisions happen on a request's own approval card. Name no position for that card ('above', 'below', 'shown now' all go).
   - The per-item marker for the selected key changes from ' — shown now' to prior-delivery language ('selected — card sent earlier'), which is what the listener marker actually records.
   - A selected-item footer that states the buttons live on that card, that this listener cannot establish the card is still in the chat, and then the recovery: /skip returns the request to the back of the order and lets the next through, the request stays pending and nothing is decided, and a fresh card is sent on a later cycle once the ones ahead have had their turn, a cycle that can run long while a gloss is written. /next is described as giving up the place, explicitly not a resend.
   - A no-selection footer for the case where nothing is marked: no request is selected right now, the next pending one is sent with its buttons on an upcoming cycle.
   - Empty queue keeps its single line, since there is no card to imply.
3. Align the no-selection replies in `commandHandlerFor` (/skip and /next with `state.paced.current === null`) with the same vocabulary, and keep the /queue queue-error reply as is.
4. Tests in tests/channels-telegram.test.ts: extend the rendering test into focused cases for selected-item, no-selected-item and empty-queue wording (asserting the new phrases present and 'shown now'/'message above' absent, and that /next is never called a resend); extend the /queue command test to assert the reply still appends nothing and the recovery sentences reach the chat over the real wire.
5. Docs: update the `/queue` row and the surrounding paragraphs in docs/cli-reference.md (and the /queue sentence in docs/dogfood-cutover.md) so the documented reply matches the shipped strings, including the missing-card recovery and /next not being a resend.
6. Run `npm run build`, the telegram suites, `npm run lint`, `npm run typecheck`. Keep the diff inside /queue rendering and command handling so the APRV-277 annotate-path work merges clean.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Implementation (opus-256)

Output-only change. Nothing about how the queue is derived, which requests are
pending, what a tap does, or what reaches the log moved; `queueLines` and the
no-selection command reply are the whole of the behaviour change, and the
`/queue` handler still calls `buildPendingQueue` and announces, with no path to
`recordChannelDecision`.

**What the bug actually was.** `/queue` was reading `state.paced.current` (this
process's selection) plus the delivery bookkeeping (a send that once returned
success) and rendering both as present visibility: ` — shown now` on the item,
and `Tap the buttons on the message above` as the footer. The Bot API reports a
successful send; it never reports that a message still exists. A card can be
deleted, buried under later traffic, or lost with the chat history, and on
2026-09-04 one was. So the two strings were claims the process had no way to
make.

**src/cli/channel-telegram.ts**
- `SELECTED_MARKER = " — selected — card sent earlier"` replaces ` — shown now`.
  Two facts (this listener's selection, a prior successful send) and no third.
- `QUEUE_IS_A_LIST`, pushed directly under the summary: the reply says it is a
  list of what the log is holding, that it has no decision buttons, and that a
  request is decided on its own approval card "wherever that card sits in this
  chat". No direction word, in either the header or the footer, deliberately:
  `announce` chunks long replies, so even "above" about the reply's own numbered
  lines is not a promise this function can keep.
- Selected-item footer: what was sent, then the honest limit ("This listener
  cannot tell whether that card is still here"), then recovery. `/skip` is named
  as the recovery and its three consequences are spelled out (back of the order,
  nothing decided, still pending), with the fresh card promised to a later cycle
  "once the requests ahead of it have had their turn" and the gloss delay noted
  in parentheses. `/next` gets its own line saying it gives up the place and
  sends no new card, ending "It is not a way to ask for the card again."
- The footer has a plural branch because `state.paced.current` is a key ARRAY: a
  digest group is several keys delivered as ONE message, so the plural reads "a
  single approval card for them" rather than inviting a hunt for one card per
  marked line.
- No-selection footer (nothing marked, an ordinary state before the first
  dispatch or right after a decision): says nothing is selected, that no card has
  been sent for any of the listed requests, and that the next goes out with its
  buttons on an upcoming cycle. No recovery paragraph there, since there is no
  lost card to recover and `/skip` would have nothing to skip.
- Empty queue keeps its single line unchanged. There is no card to imply, so
  buttons, `/skip` and `/next` stay out of it; the test pins that absence.
- `commandHandlerFor`'s no-selection reply moved to the same vocabulary: "this
  listener has no request selected" replaces "no request is in front of you",
  which was also a claim about the approver's screen.

**Decisions worth recording.** (1) The recovery names `/skip` and not `/next`
because only `/skip` clears the delivery bookkeeping (`forget`) and requeues, so
only `/skip` produces a fresh card; describing `/next` as a resend would have
been the same class of error this task fixes. (2) `src/channels/telegram.ts:246`
still says "check the message above" and was left alone: that is the toast
answering a tap the approver just made on a card they are looking at, not the
`/queue` reply, and the task scopes to `/queue`. (3) The test spells the marker
out as its own constant rather than importing `SELECTED_MARKER`, so changing the
shipped wording takes two deliberate edits.

**Verification.** `npm run build` clean. `node scripts/run-tests.mjs --only
channels-telegram`: 121 tests, 121 pass, 0 fail, exit 0. `--only
telegram-tap-latency`: 5/5 pass, exit 0. `--only cli-coverage --only cli-help
--only cli-long-help` (the doc-coupled suites): 43/43 pass, exit 0. `npm run
lint` and `npm run typecheck` both clean. Full `npm test` not run, per the
task brief.

**Merge note.** APRV-277 is changing the annotate path's 400 handling in the
same two files on another branch. This diff touches only `queueLines`, the two
new module constants above it, the `commandHandlerFor` doc comment for `/queue`,
and its no-selection reply, so the two should not overlap.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
/queue no longer claims a card is visible. The reply now opens by identifying itself as a pending-request list with no decision buttons and points at the request's own approval card without naming a position; the item marker changed from ' — shown now' to ' — selected — card sent earlier' (this listener's selection plus a prior successful send, which is all the Bot API reports); and the footer states outright that the listener cannot tell whether that card is still there, then gives /skip as the recovery (back of the order, nothing decided, still pending, fresh card on a later cycle once the ones ahead have had their turn, gloss delay noted) and says /next gives up the place and sends no new card, explicitly not a way to ask for the card again. Separate footers cover the no-selection and digest-selection cases; an empty queue keeps its single line. The /skip and /next no-selection replies moved to the same selection vocabulary. Output only: no decision, derivation or log behaviour changed and the commands still append nothing. Verified by two new tests in tests/channels-telegram.test.ts (a renderer test over selected, digest, no-selection and empty-queue wording, and a command test driving /queue, /skip and /next with nothing selected and then an empty queue, asserting recordCount is unchanged) plus the extended over-the-wire /queue test: channels-telegram 121/121 pass exit 0, telegram-tap-latency 5/5, cli-coverage/cli-help/cli-long-help 43/43, build, lint and typecheck clean. Docs updated in docs/cli-reference.md (command table plus two new paragraphs) and docs/dogfood-cutover.md.
<!-- SECTION:FINAL_SUMMARY:END -->
