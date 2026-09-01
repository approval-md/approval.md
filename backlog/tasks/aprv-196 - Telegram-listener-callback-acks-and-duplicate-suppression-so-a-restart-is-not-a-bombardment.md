---
id: APRV-196
title: >-
  Telegram listener: callback acks and duplicate suppression, so a restart is
  not a bombardment
status: Done
assignee:
  - '@claude'
created_date: '2026-09-01 04:31'
updated_date: '2026-09-01 20:49'
labels:
  - channels
  - ux
dependencies: []
priority: high
ordinal: 163000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Incident 2026-09-01, during the APRV-182..185 wave: with 5-6 pending policy.edit requests, every listener restart re-sent the full pending queue (documented behavior, SPEC 10.3: channels hold no state that is truth), the human reported being bombarded, approve buttons generally getting stuck, and taps on pre-restart duplicate messages silently doing nothing. Three real grants DID land, so the pipeline works; the experience is the failure. The human's workaround was the CLI channel (approval grant / approval channel cli --interactive), which unblocked the wave.

Scope to design within the SPEC 10.3 constraint (no channel state that is truth): (a) ack every Telegram callback query immediately (answerCallbackQuery) so a tap never spins, including taps on dead pre-restart buttons, which should get an explanatory toast (request already decided, or this copy is stale, tap the newest); (b) on restart, edit or delete superseded prompt messages where the Bot API allows, or prefix re-sends with a one-line re-delivery banner naming how many are coming, so a flood reads as a re-delivery; (c) resolve a tap by ACTION KEY rather than by message identity where possible, so a tap on any copy of a still-pending request decides it (kills the duplicate-copy trap outright); (d) consider a single queue-summary message with per-request buttons as the re-delivery form. Derived state (message-id to action-key map) may live in the process or a cache file, provided the log stays the only truth.

Related: the flood-of-rejections rule (a swept backlog is not considered denial) becomes less load-bearing once duplicates cannot eat taps. The CLI channel fallback should also be named in docs/dogfood-cutover.md as the runbook for a misbehaving phone channel.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every callback query is acked; taps on stale copies get an explanatory toast; no tap ever spins indefinitely
- [x] #2 A tap on any copy of a still-pending request decides that request (action-key resolution), tested
- [x] #3 Restart re-delivery is legible: superseded copies edited or deleted where the API allows, or a banner precedes the batch
- [x] #4 No channel state becomes truth: SPEC 10.3 respected, any mapping is derived and rebuildable
- [x] #5 docs/dogfood-cutover.md names the CLI channel as the fallback when the phone channel misbehaves
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. callback_data carries a RESTART-STABLE action reference. `callbackData` becomes `<g|r>:<nonce>:<akid>` where akid is the first 16 hex of sha256(action key). It always fits the 64-byte cap, so the cross-check that used to vanish for long keys is now always present, and (the point) two copies of the same request delivered by two different processes carry the same akid even though their nonces differ. The bytes still never NAME an action: akid resolves only against deliveries this process itself made.

2. Resolution order in TelegramChannel.handleUpdate (scope 'one'):
   a. nonce hit -> akid cross-check -> decide, exactly as today;
   b. nonce miss + akid matches a LIVE delivery this process made -> decide that delivery (an older copy's button decides the request, and the annotation lands on the live message). Counted as a new stat, acked with a toast that says which copy answered;
   c. nonce miss + no live delivery -> ask the optional `describeAction` probe the listener wires to the VERIFIED log, and toast what the log says (already granted/rejected/expired/withdrawn/pending); fall back to a generic 'no longer live' toast when there is no probe or no record. New anomaly kind `stale-copy`, distinct from `unknown-callback`.

3. Exactly one ack per callback query, on every path including a thrown one. handleUpdate wraps its body so the answerCallbackQuery is guaranteed by a finally, and the accept path's ack is best-effort-wrapped so a failed toast cannot take down the poll cycle.

4. Restart re-delivery: a one-line banner sent by TelegramChannel.announce before the first cycle that has anything to send. Chosen over edit-in-place of prior copies because a restart has no memory of prior message ids (SPEC 10.3 forbids that memory being truth, and a crash loses it anyway); step 2b is what makes the un-marked older copies harmless. Banner names no action key, so it cannot be confused for a request.

5. Prune the listener's delivered map: drop an action key on successful terminal annotation, and sweep entries older than a retention window that the pending queue no longer carries. Reported as `pruned` on DispatchResult. The channel-side maps already sweep (APRV-135).

6. docs/dogfood-cutover.md: operator paragraph on what a restart looks like now, what each stale-tap toast means, and the CLI channel as the fallback for a misbehaving phone channel.

7. Tests in tests/channels-telegram.test.ts against the mock Bot API: ack on accept, ack on stale copy, ack on unknown key, an older copy's tap deciding the request, restart-with-N producing the banner, listener map pruning.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was done

Three properties, one per half of the incident.

**1. Every callback query is acked, exactly once, on every path.**
`TelegramChannel.handleUpdate` is now a wrapper: it records the query being
handled, delegates to `routeCallback`, and guarantees in a `finally` that an
`answerCallbackQuery` was attempted, falling back to `TELEGRAM_ACK_FALLBACK`
when a branch produced none. A thrown handler is answered and swallowed rather
than propagated, because `pollOnce` throwing puts `listen` into backoff and one
bad update would cost the whole batch. Every existing branch keeps its own,
better sentence; they now go through `safeAnswer`, which never throws and marks
the query answered so the wrapper does not add a second, vaguer toast on top.
The accepted-decision path became best effort for the same reason: the decision
is already in the log when the ack is attempted, so a refused toast (Telegram
drops a query after its own window) must not abandon the annotation that
follows it.

**2. A tap on any copy decides the same request.**
`callback_data` is now `<g|r>:<nonce>:<action ref>`, where the ref is the first
16 hex of sha256(action key) (`actionRefOf`). It always fits the 64-byte cap, so
the cross-check that used to be dropped for a long action key is now always
carried, and, the point, it is identical for two copies delivered by two
different processes. Resolution ladder in `routeCallback`: the nonce when this
process issued it; otherwise the ref against a delivery this process is holding
open (`liveDeliveryFor`), which decides the request on the live copy's message
and toasts with `TELEGRAM_STALE_COPY_PREFIX`; otherwise the new optional
`describeAction` probe, which the listener wires to the VERIFIED log and which
answers "Already granted / Expired / Withdrawn / Still pending". A new anomaly
kind `stale-copy` separates "a copy of a request I am not holding" from "bytes
I cannot place" (`unknown-callback`), and `stats().staleCopyDecisions` counts
the taps the ladder rescued.

The bytes still never NAME an action: a ref is only ever matched against
deliveries this process itself made, from the configured chat, and the gate then
does everything it does for any other tap. Nothing on the Telegram side reduces
scrutiny, and nothing there is truth. What makes an older copy's button work is
that the LOG still calls the request pending.

**3. A restart is legible.** The first batch a listener process sends is
preceded by one banner (`TelegramChannel.announce`, `bannerLines`): "LISTENER
STARTED - re-sending N pending requests", plus a line saying earlier copies
still decide the same request and a line saying the pending set is read from the
log. Only the startup cycle can carry one: the flag is consumed by the first
cycle that completes a derivation, so a listener that started against an empty
queue never announces a re-delivery hours later.

**Trade-off, chosen deliberately.** Edit-in-place of the superseded copies would
read better and cannot be relied on: it needs their message ids, which a restart
does not have. SPEC §10.3 forbids channel state that is truth, and a crash loses
a cache whether or not one is permitted, so a design that only works when the
crash was gentle fails on the day it is needed. The banner is unconditional and
the older copies are made harmless (property 2) instead of tidy. Recorded in the
`bannerLines` doc comment and in docs/dogfood-cutover.md.

**4. Pruning.** The listener's `delivered` map (commented "never pruned") is now
pruned two ways: an action key is forgotten when its terminal state has been
annotated, and a straggler is forgotten once it is older than
`DISPATCH_RETENTION_MS` (24h) AND the pending queue no longer carries it.
`forget` clears `delivered`, `sentAtMs`, `attempts`, `annotated` and the key's
`warned` tokens together; `DispatchResult.pruned` reports both kinds. Neither
prune can cost a re-send, for the same reason losing the whole map to a restart
is safe: the pending set is the log's answer. The channel-side maps were already
swept by APRV-135.

**5. docs/dogfood-cutover.md** gained "What a restart looks like on the phone"
(banner, working older copies, a table of every toast and what it means) and
"When the phone channel misbehaves, decide at the CLI" (`approval queue`,
`approval channel cli --interactive`, `approval grant`), which is AC #5 and the
workaround that unblocked the APRV-182..185 wave. The stale sentence in the
paragraph above it ("the buttons on the pre-restart messages stop resolving")
was corrected, as were the same claims in the two module doc comments.

## Global invariants touched

None weakened. The one worth naming is invariant 1 (enforcement paths read only
verified records): `describeActionFor` reads through `readVerifiedRecords`, and
an unverifiable log answers `null`, which the channel renders as its neutral
"not open here" toast. It describes and never decides. Deciding still requires a
delivery this process made, every decision still goes through
`recordChannelDecision` -> `decide()`, nothing new is appended anywhere, and no
Telegram-side state can lower scrutiny (invariant 4).

## Tests

`tests/channels-telegram.test.ts`, against the mock Bot API, no network:
- every callback query is acked exactly once, on every path (foreign chat,
  malformed, unplaceable nonce, stale ref, accepted decision, re-tap);
- a handler that throws still answers the tap, and `pollOnce` does not
  propagate;
- a tap on a pre-restart copy decides the request the new listener holds, with
  one event and a toast naming the earlier copy;
- a tap on a copy of a settled request is told what the log says (probe wired),
  and an unknown ref answers `null` rather than an invented outcome;
- an ack the Bot API refuses costs the decision nothing;
- a startup batch is preceded by one banner naming the count, which names no
  action key, and a later cycle sends none;
- the delivery bookkeeping is pruned on settlement and on age;
- the 64-byte cap still binds, and an over-long nonce drops the reference
  rather than the button.

Three existing tests changed their expected anomaly kind from
`unknown-callback` to `stale-copy` (the duplicate-callback test, the expired
digest member's stale tap, and the APRV-135 swept-delivery test) and the
`callback_data` unit test now asserts the reference form. Each is the same
refusal under a more precise name with a better toast; none of them decides
anything it did not decide before.

## Acceptance criteria — evidence

All from `node --test dist/tests/channels-telegram.test.js` (102 pass, 0 fail),
driven against the mock Bot API on loopback. No test in this repository contacts
the real network.

- **AC1 (every callback acked, stale copies get an explanatory toast, no tap
  spins).** `every callback query is acked exactly once, on every path
  (APRV-196)` feeds a foreign chat, unparseable bytes, an unplaceable nonce, a
  stale action reference, an accepted decision and a re-tap, and asserts exactly
  one `answerCallbackQuery` for each with the right sentence.
  `a handler that throws still answers the tap, and the loop survives (APRV-196)`
  covers the branch nobody writes on purpose: the wrapper's fallback toast
  fires, `pollOnce` does not propagate, and nothing is appended.
  `an ack the Bot API refuses costs the decision nothing (APRV-196)` pins the
  other direction, a toast that cannot be delivered.

- **AC2 (a tap on any copy decides the request, tested).**
  `a tap on a pre-restart copy decides the request the new listener holds
  (APRV-196)` builds two channels over one log (the process that died and its
  replacement), asserts the two copies carry different nonces and the SAME
  action reference, taps the older copy, and gets `ok: true` with exactly one
  `approval.granted` in the log and a toast naming the earlier copy.
  `a tap on a copy of a settled request is told what the log says (APRV-196)`
  is the other half: once decided, the same button is refused `stale-copy` and
  toasted from the verified log rather than deciding twice.

- **AC3 (restart re-delivery is legible).**
  `a startup batch is preceded by one banner naming how many are coming
  (APRV-196)` asserts the banner is the FIRST message of the batch, that there
  is exactly one, that it names the count, that it names no action key, and
  that a later cycle sends none. The AC offers edit-or-banner; the banner branch
  was taken and the reason is recorded in the `bannerLines` doc comment and in
  docs/dogfood-cutover.md.

- **AC4 (no channel state becomes truth; any mapping is derived and
  rebuildable).** `a fresh listener re-sends everything still pending: a
  duplicate, never silence` (pre-existing, still green) pins that the pending
  set is re-derived from the verified log rather than remembered.
  `the listener's delivery bookkeeping is pruned, on settlement and on age
  (APRV-196)` drops entries mid-run and asserts nothing is re-sent and nothing
  pending is lost, which is the same property from the other side: the map can
  be discarded at any moment. The new `describeAction` probe reads through
  `readVerifiedRecords` and answers `null` on an unverifiable log, asserted in
  the settled-request test; an action reference is only ever matched against
  deliveries this process itself made, so no Telegram-side value names an
  action or lowers scrutiny.

- **AC5 (docs name the CLI channel as the fallback).**
  docs/dogfood-cutover.md gained "When the phone channel misbehaves, decide at
  the CLI", naming `approval queue`, `approval channel cli --interactive` and
  `approval grant`. All three verbs were exercised for real: `node cli.js queue
  --help` and `node cli.js grant --help` print, and `--interactive` is a
  declared flag of the cli channel verb (src/cli/channel.ts:89).

## Validation

- `npm run build` (tsc -p tsconfig.json): clean.
- `npm run lint` (oxlint src tests): clean, no warnings.
- `node --test dist/tests/channels-telegram.test.js`: **102 pass, 0 fail**,
  including all seven new APRV-196 cases.
- `npm test` (full suite): **2499 tests, 2496 pass, 3 fail**.

The three full-suite failures are load-induced wall-clock flakes and not this
change. Two are in `tests/cli-hook.test.ts`, which drives the harness hook
through real subprocess waits against 1000ms and 20000ms deadlines: the failing
pair differed between two runs of the same code (`a rejected request denies with
hook-rejected` plus `a manual command is allowed when a grant lands mid-wait`
once, `a rejected request denies…` plus `a grant that lapsed its TTL carries
nothing` the other), and each reported a hook TIMEOUT where the test wanted a
decision. Re-run alone on an unloaded machine, `dist/tests/cli-hook.test.js` is
**65 pass, 0 fail**.

The third, `setup channel telegram: a message sent AFTER the first poll came
back empty is still found`, asserts the verb polled more than once; under load
the update queued at 120ms was already there for the FIRST poll, so the run
succeeded and only the staging of the "slow human" scenario failed. It passes on
re-run. It also cannot be reached by this diff: the only file it shares with
this change is a TYPE import (`TelegramFetch`, untouched), and
`tests/telegram-mock.ts` and `src/cli/setup-channel.ts` are both unmodified
(`git diff --name-only` lists four files: the two channel sources, the telegram
test, and the doc).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A restart no longer bombards the approver, and no tap is ever swallowed. Three changes to the Telegram channel and its listener: (1) `handleUpdate` guarantees exactly one `answerCallbackQuery` per callback query on every path, including a thrown handler, with each branch keeping its own sentence and a fallback toast behind them; (2) a button's `callback_data` now carries a restart-stable 16-hex reference to its action key, so a tap on a pre-restart copy resolves to the request this process is holding open and decides it through the ordinary gate path, while a tap on a request nothing here holds is told what the VERIFIED log says became of it (already granted, expired, withdrawn, still pending); (3) the first batch a listener sends is preceded by one banner naming how many are coming, chosen over editing the superseded copies because a restart does not know their message ids and a cache would not survive the crash that matters. The listener's delivery map, commented "never pruned", is now pruned on annotated settlement and on a 24h retention sweep once the log stops calling the key pending. Channel-local state stays derived and rebuildable: the pending set is re-derived from the verified log every cycle, an action reference only selects among deliveries this process itself made, and every decision still goes through recordChannelDecision -> decide(). docs/dogfood-cutover.md gained an operator section (what a restart looks like now, a table of every toast) and names `approval channel cli --interactive` as the fallback for a misbehaving phone channel. Verified with `npm test`, `npm run lint` and `npm run build`, and with eight new cases in tests/channels-telegram.test.ts driven against the mock Bot API.
<!-- SECTION:FINAL_SUMMARY:END -->
