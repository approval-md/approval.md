---
id: APRV-216
title: >-
  Telegram queue: summary first, one request at a time, /queue and /skip instead
  of the restart burst
status: In Progress
assignee:
  - 'agent:opus-lane-z'
created_date: '2026-09-02 15:57'
updated_date: '2026-09-02 18:32'
labels:
  - telegram
  - channels
dependencies: []
references:
  - APRV-196
  - APRV-115
  - APRV-206
priority: high
type: enhancement
ordinal: 178000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On listener start the Telegram channel re-sends every pending request: a banner (APRV-196), digest grouping where requests are similar (APRV-115), then one message per request or digest (src/cli/channel-telegram.ts deliverUnits/groupForDigest/bannerLines). There are no bot commands. The one-at-a-time walkthrough that Carter liked exists only in approval channel cli --interactive (src/cli/channel.ts interactiveLoop, g/r/s prompt in src/channels/cli.ts). approval queue lists open requests read-only; QUEUE.md is read-only; the web page (src/channels/web.ts, channels.web.port) can act but is not enabled in the live policy. Replace the burst with paced delivery, chosen by Carter 2026-09-02: on listener start, and whenever the pending set grows while nothing is in front of the human, send ONE summary line (N pending, oldest age, classes) and the OLDEST pending request with its buttons. The next request is sent after a decision on the current one, after /skip (stays pending, goes to the back of this process's order), or after /next. /queue replies with the summary and a numbered list (action key, task, class, age) at any time. Digest grouping still applies to the item being shown. SPEC §10.3 holds: the channel holds no truth; the order and the current item are in-memory per process, pending-ness is always re-derived from the log, and a tap on any older copy still decides by action key (APRV-196). Opt-out channels.telegram.delivery: burst keeps today's behaviour; the default becomes paced. Reuse deliverUnits, groupForDigest, bannerLines, buildPendingQueue ordering, and the CLI loop's skip semantics.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Listener start with N pending sends exactly two messages: the summary and the oldest request
- [ ] #2 A grant or reject on the shown request sends the next one within one poll cycle; /skip and /next do the same without deciding anything and append nothing to the log
- [ ] #3 /queue lists every pending request inside its TTL, derived from the log, with counts and ages, and works while an item is being shown
- [ ] #4 A tap on a pre-restart copy still decides the same request (APRV-196 preserved); nothing is ever decided twice
- [ ] #5 channels.telegram.delivery: burst restores today's behaviour; the optional policy key is schema-validated (split into its own schema task if the change is non-trivial)
- [ ] #6 Tests in the Telegram channel suites with the mock bot cover start, decide, skip, next, queue, and the burst opt-out; docs/cli-reference.md channel telegram section updated; npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. **Policy key.** `channels.telegram.delivery: paced | burst`, default paced. One enum property added to schema/policy.schema.json (annotation-only default); the runtime default lives beside the other telegram names in src/core/telegram-config.ts as TELEGRAM_DEFAULT_DELIVERY + telegramDeliveryFor(load), which is where token_env/chat_id_env already resolve. Trivial schema change, so no split task. Valid and invalid policy-md fixtures.

2. **Channel grows bot commands, and asks for message updates only when someone is listening for them.** src/channels/telegram.ts gains onCommand(handler) and a pure parseBotCommand(text) -> 'queue'|'skip'|'next'|null (tolerating the /cmd@botname form). allowed_updates becomes ['callback_query','message'] ONLY while a command handler is registered, so burst delivery and `approval setup channel telegram`'s message discovery (APRV-74) are untouched. handleUpdate routes a message update: a chat that is not the configured one is counted (foreign-chat) and dropped, an unrecognised command is counted under a new anomaly kind unknown-command, a recognised one calls the handler. Commands are reported on TelegramPollResult.commands. No callback query, so nothing is acked; the answer is the message the handler sends or the item the next cycle sends.

3. **Pacing lives in the CLI layer, in memory, per process.** ListenSetup gains a REQUIRED delivery field (prepareListen resolves it from the policy; the only other construction site is the test helper). DispatchState gains `paced`: order (this process's order of action keys), current (the keys of the unit in front of the human), summarySent, announced. Every cycle re-derives pending from the verified log, drops settled keys from order, appends newly pending keys in log order at the back, and releases current when the log no longer calls its members pending. Nothing here is truth: losing it degrades to a re-send, exactly as delivered already does (SPEC 10.3).

4. **One item at a time.** With current set, a paced cycle sends nothing. With current null it picks the first still-pending, undelivered key in order, groups the undelivered set with groupForDigest, and delivers the group that key belongs to (digest when it has 2+ members, deliverUnits otherwise) — digest grouping still applies to the shown item. The gloss is attached only to the members actually being sent, instead of to every undelivered request. A summary message precedes it when this process has sent no summary yet, or when the pending count has grown since the last one: N pending, oldest age, class tally. Burst keeps bannerLines and today's send-everything loop byte for byte.

5. **Commands mutate that state and append nothing.** /queue replies with the summary and a numbered list (action key, task, class, age), re-derived from the log at reply time, and works while an item is shown. /skip moves the shown unit to the BACK of this process's order and forgets its delivery, so it is shown again after everything else; the copy already in the chat keeps live buttons and still decides by action ref (APRV-196). /next releases the shown unit without reordering, so it is not shown again by this process. Neither calls recordChannelDecision, so neither can append.

6. **Tests** in tests/channels-telegram.test.ts against the mock bot: start with N pending sends exactly two messages; a grant on the shown item sends the next within one cycle; /skip and /next advance and append nothing (record count unchanged, chain clean); /queue while an item is shown; a pre-restart copy's tap still decides (APRV-196 preserved, nothing decided twice); delivery: burst restores the banner-plus-everything behaviour. Existing multi-request dispatch cases that assert the burst shape become explicit burst cases.

7. **Docs**: docs/cli-reference.md channel telegram section (the two modes, the three commands, the policy key) and docs/dogfood-cutover.md's restart paragraph. SPEC/CLAUDE sentence drafts go in the notes; neither file is touched.
<!-- SECTION:PLAN:END -->
