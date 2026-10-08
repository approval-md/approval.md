---
id: APRV-299
title: >-
  Retrospective samples reach the approver's channel: Telegram review cards with
  a verdict and a reaction
status: Done
assignee: []
created_date: '2026-09-07 06:35'
updated_date: '2026-09-07 23:35'
labels:
  - telegram
  - audit
dependencies: []
priority: high
ordinal: 219000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
2026-09-07: Carter expected the retrospective samples to arrive on the Telegram bot and found 60 waiting in QUEUE.md instead. The daemon draws samples (audit.sampled) and the only review surfaces are approval audit list / approval audit review in a terminal; src/channels/telegram.ts knows requests and nothing else. The supervised bargain (SPEC 5.2) is 'execute now, a fraction is reviewed after', and a review nobody is shown is a review that does not happen; the reactions of APRV-237/239 (liked, loved, indifferent, disliked, with a note on the extremes) hang off exactly this verb, so the card is also where the values loop becomes real. Paced like requests (APRV-216): one card at a time behind a summary, navigation is process memory, the log stays the truth.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The Telegram channel delivers each audit.sampled with no later audit.reviewed as a review card: what ran (class, command breakdown, task, summary, the same rows the request prompt uses), with buttons for ok and deny and for the four reactions; ok/deny append audit.reviewed through the real reviewSample path, a reaction button on loved or disliked prompts for the note before appending, and every refusal in audit_refusal_codes is rendered in the reply
- [x] #2 Delivery is paced: a summary line (n awaiting review, oldest age) then one card at a time, with list/defer/skip navigation that decides nothing; a card lost from the screen leaves the sample pending and reviewable from approval audit review; a deny that opens a reconciliation obligation says so on the reply
- [x] #3 approval feedback shows reactions given from the card exactly as ones given from the CLI (same records, same actor human:<id>); tests/channels-telegram.test.ts covers card rendering, each button, the note prompt, pacing and a lost card, with logs built through the real append path
- [x] #4 docs/cli-reference.md telegram section and docs/dogfood-cutover.md describe the review card; CHANGELOG entry; SPEC 10.3 amendment text (a channel MAY deliver samples for review under the same pacing and rendering rules) in the task notes for hand application
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/cli/audit-card.ts (new): pure-ish builder. openReviewCards(logPath, tagOptions, now) reads VERIFIED records, takes openSamples(records), and for each builds a ReviewCard: sample seq/ts, action key, task, class + command_breakdown (recomputed by the classifier over the payload store bytes the execution.started payload_hash names), the declared summary (claimed, authored by the registering actor), gloss where a runner attached one, 'ran at' (the sample's subject_ts) and 'verdict' (the runtime allowed it unasked: autonomy + the rate the sample record states, plus the execution outcome when the log carries one). Nothing self-reported chooses a row: class comes from task.registered, the breakdown from the bytes, the rate from the sample record.

2. src/channels/telegram.ts: extract the row renderer so the card reuses it. telegramRow's five shared cases (class, command_breakdown, task, summary, gloss) move behind reviewRow(fields: ReviewCardFields, row) where ReviewCardFields is a Pick of ChannelRequest; telegramRow delegates for those rows. renderReviewCard(card) builds the same COMPUTED/CLAIMED split, the same bullet renderer and the same anomaly-mark rules, adds the two card-only computed rows, states the deny latch rule in words, and carries NO payload region and NO approve button: a sample is never an approval request and never accepts a token.

3. Buttons and callbacks. A new verb vocabulary, parsed BEFORE parseCallbackData exactly as the checkpoint one is: reviewCallbackData(choice, nonce) -> 'v:<nonce>:<choice>' with choice in ok|deny|disliked|indifferent|liked|loved, and parseReviewCallback. Row 1 is OK and Deny, row 2 the four reactions. The deny latch: a first Deny tap arms the card (process memory, appends nothing) and redraws it saying so; a second records verdict denied; a reaction with deny armed records the denial with that reaction, except liked/loved which are refused reaction-conflicts-verdict with nothing appended; OK disarms and records ok. loved/disliked send a ForceReply note prompt and append nothing until the reply arrives; the note goes to reviewSample, which refuses a blank one note-required. Every append goes through one handler the runtime registered (onReview), which calls reviewSample with actor human:<id> from the listener's approver mapping - never a payload field - so approval feedback shows a card reaction exactly as a CLI one.

4. Message updates. handleMessage gains the note-reply branch before the slash-command branch, keyed on reply_to_message.message_id matching an outstanding prompt; allowed_updates asks for 'message' when a command handler OR a review handler is registered.

5. src/cli/channel-telegram.ts: DispatchState gains a review walkthrough (order of sample seqs, current, delivered map, summarySent, announced) with the same in-memory rules as paced. dispatchReviews runs at the end of a cycle, only when nothing is in front of the approver, and sends a summary line (n awaiting review, oldest age) then ONE card. /queue gains the backlog line; /skip and /next act on the review card when no request is selected. reviewHandlerFor(setup, streams) wires reviewSample. A lost card is nothing: the sample stays open and approval audit review still names it.

6. Tests in tests/channels-telegram.test.ts built through the real append path (register/request/execute/sample through core), covering card rendering (rows, no payload, no approve), each button, the deny latch and its two refusals, the note prompt and its blank refusal, pacing (summary then one card), a lost card leaving the sample open, and approval feedback showing the card reaction identically to a CLI one (tests/cli-feedback.test.ts or the telegram suite reading humanFeedback).

7. Docs: cli-reference telegram section, dogfood-cutover, CHANGELOG under 0.1.0. SPEC 10.3 amendment text into the task notes only - no SPEC edit.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was done

Every `audit.sampled` with no later `audit.reviewed` now reaches the approver's Telegram chat as a review card, and the human's answer goes back through the same human-only `reviewSample` the CLI verb calls.

- `src/cli/audit-card.ts` (new). `openReviewCards(logPath, options)` reads VERIFIED records, takes `openSamples` (the same projection `approval audit list` and `.approval/QUEUE.md` read, so the three cannot disagree), and builds one `ReviewCard` per open sample. Every row is derived: the class from the `task.registered` declaration, the command breakdown recomputed by the classifier's own tokenizer (`core/wysiwys.ts`) over the payload-store bytes the `execution.started` hash names, the rate off the `audit.sampled` record itself, and the CLAIMED author off who APPENDED the registration rather than out of any payload field. A sample naming no action key, or one no registration declares, produces no card and stays in the backlog rather than having a class invented for it.
- `src/channels/telegram.ts`. `telegramRow`'s five shared cases (class, command_breakdown, task, summary, gloss) moved behind `reviewRow`, typed on a `ReviewCardFields = Pick<ChannelRequest, ...>` so the card and the prompt share one implementation with no cast; `telegramRow` delegates. `renderReviewCard` reuses the same bullet renderer, the same COMPUTED/CLAIMED headings and the same origins, and adds the two card-only computed rows (ran at, verdict). A new callback verb `v:<nonce>:<choice>` with its own parser, routed BEFORE `parseCallbackData` for exactly the reason the checkpoint verb is: a review button must never reach the decision ladder, where an unresolved nonce falls back to an action reference. `onReview` / `offerReview` mirror `onCheckpoint` / `offerCheckpoint`.
- `src/cli/channel-telegram.ts`. `reviewHandlerFor` calls `reviewSample` with actor `setup.actor`, the identity the listener was configured with, never anything the callback carried. `dispatchReviews` runs at the end of a cycle and only when nothing else is in front of the approver; `DispatchState.review` is the walkthrough. `/queue` lists the backlog, `/skip` and `/next` act on the card when no request is selected.

## What was decided

- **Deny is a latch, and the card says so.** A first Deny tap arms and appends nothing; the second records the denial. A retrospective denial cannot undo anything (what it does is open an obligation a human must discharge, SPEC 5.2), so a gesture with that consequence should not sit one thumb-width from a grade. The latch is also what makes 'denied, and disliked' sayable in one card, and what makes `reaction-conflicts-verdict` a state a person can actually reach and correct.
- **The channel implements none of the rules.** A denied review that says liked or loved is sent to `reviewSample` as that pair and refused by it; a blank note is sent as a blank note and refused `note-required`. The card renders the code and the message. No rule of `core/audit.ts` is restated here, which is why no new refusal code was needed: invariant 6 is untouched, and the `audit_refusal_codes` union and its 11.2 rows are unchanged.
- **A refusal keeps the buttons.** Nothing was appended, and the codes that get here are ones the reviewer can act on: `reaction-conflicts-verdict` asks which half they meant and `note-required` asks for words, so the card must stay answerable. A recorded review settles the card and forgets its nonce in the same edit, as a decided prompt does.
- **No payload region and no approve button, ever.** SPEC 10.3 requires the canonical rendering in front of an approver before a DECISION is collected, and a review collects none: the action ran. A sample is never delivered as an approval request and never accepts a token.
- **Review delivery is paced in both modes**, `burst` included. Nobody is blocked on a review, and a restart that put sixty cards on a phone would be the flood APRV-287 collapsed in the other direction.
- **`allowed_updates` now asks for `message` whenever a review handler is registered**, because a loved/disliked note is collected as a reply (an inline keyboard has no text input). Under `burst` a message that is not such a reply is ignored, exactly as an unrecognised /command is. docs/cli-reference.md states this and points at the existing 'stop the listener before setup channel telegram' rule.
- **Cost.** `dispatchReviews` would add a third verified log read per poll cycle, which is the APRV-217 shape of cost. It is skipped on the cycle where a card is already in front of the approver AND the log's byte size is unchanged: sound because the log is append-only, and the steady state (a card waiting on a human for minutes, a 25-second poll) is exactly that case. A null size, an unreadable stat, or any growth falls through to the ordinary derivation.

## Invariants touched

- **Invariant 10 (guidance never reaches enforcement).** Nothing added here reads the values block, and nothing branches on a reaction: the channel carries the word from a button into `reviewSample`'s payload, and no routing, class match, sampling draw, budget, token, gate-window or execution decision reads it. `core/audit.ts` is imported by `src/channels/telegram.ts` for `REACTIONS` and two types, which is the import that module's own doc sanctions (imported by the surfaces that show it, and by nothing that decides); `tests/values-inert.test.ts` scans the enforcement modules under `src/core/`, is unaffected, and still passes.
- **Invariant 4 (self-reported fields never reduce scrutiny).** No payload key an authoring party wrote chooses a row: class from the registration, breakdown from the bytes, rate from the sample record, claimed author from who appended.
- **Invariant 1 (enforcement paths read only verified records).** A card is a statement to a human about what the log says; `openReviewCards` refuses on a log that does not verify and builds nothing.
- **Invariant 6 (refusals machine-readable and distinct).** No new code. Every member of `audit_refusal_codes` is rendered on the card, pinned by a test that walks the whole frozen union.
- **Human-only.** The channel appends nothing. `reviewSample` refuses any actor that is not human:<id>, and a card cannot close a sample other than by recording a human's review.

## SPEC amendment text (apply by hand)

Insert in 10.3, after the 'Delivery pacing (amended APRV-216)' paragraph:

Review delivered through a channel (amended APRV-299). A channel MAY deliver a retrospective sample for review, under the same pacing and rendering rules this section already states. A review card is not a request and MUST NOT be presented as one: the action has already executed, so the card carries no payload region, offers no approval, accepts no token, and a channel MUST NOT deliver a sample as an approval request. What it carries is the computed and claimed split above, over facts the log already holds: the class the registration declared, what the payload bytes do, the task, the claimed summary, when it ran, and that the runtime allowed it without asking and at what rate. The gestures it collects are a verdict and, optionally, the graded reaction of 5.2, and every one of them MUST reach the log through the same human-only review a terminal calls, recorded against the human identity the runtime was configured with and never against anything the channel received, so that a reaction collected on a channel and one collected at a terminal are the same record; a refusal MUST reach the approver with its own machine-readable code. A reaction that requires the human's own words (5.2) MUST collect them before anything is appended. The order and the card currently shown are process memory in the sense of the dispatch paragraph above: their loss MUST degrade to showing a sample again, and a sample absent from the approver's screen MUST remain in the sampled-audit backlog of 9, listable, and reviewable at any other surface. Nothing a channel does may close a sample other than by recording a human's review, because a supervision backlog a transport can empty measures nothing. (Amended APRV-299, pending sign-off.)

No 11.2 row is needed: the card adds no refusal code, and every code it renders already has one.

## Tests

`tests/channels-telegram.test.ts` gains eleven cases, all built through the real append path (register, startExecution, finishExecution, then `core/audit.ts`'s own sweep with a test-scoped secret): card rendering and what it must not carry, each button, the deny latch and both of its refusals, the note prompt and a blank note, every member of `audit_refusal_codes` reaching the card inside the message limit, pacing (summary then one card, then the next only after the first is answered), /queue and /skip, a lost card leaving the sample open with `approval audit review` still naming it, and `approval feedback` showing a card reaction field-for-field identically to one given by the CLI verb. `tests/telegram-mock.ts` gains `sentMessages()` (a send's assigned message id, which a reply must name) and `messageUpdate({ replyToMessageId })`.

## Docs

docs/cli-reference.md (the telegram listen section, the --json stream, the burst paragraph), docs/dogfood-cutover.md (a new review-card section in the phone runbook), CHANGELOG.md under 0.1.0 unreleased, and one line in TELEGRAM_LISTEN_HELP.

2026-09-07 finalize: SPEC §10.3 amendment text for this task ('Review delivered through a channel (amended APRV-299)') landed in PR #323 (opened today, pending Carter's sign-off), applying the paragraph quoted above verbatim. AC4 is satisfied on that basis.
<!-- SECTION:NOTES:END -->
