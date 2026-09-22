---
id: APRV-424
title: >-
  Telegram webhook transport: decisions arrive by webhook so no long-poll
  process needs to run
status: In Progress
assignee:
  - '@opus-424'
created_date: '2026-09-21 06:42'
updated_date: '2026-09-22 02:16'
labels:
  - telegram
  - channels
  - webhook
dependencies: []
priority: medium
ordinal: 325000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC section 10.3 lists channels as transport that holds no state; the Telegram channel today long-polls getUpdates, which requires one always-running process per bot and forbids a second poller on the same token. A webhook mode registers a URL with setWebhook and receives updates as HTTP posts, which is what makes a serverless or sleep-when-idle daemon possible (the hosted layer's wake-on-event shape) and what lets one bot serve many tenants behind a router that dispatches by chat. Verification of the update, sender mapping (approvers.<id>.senders, APRV-324), the decision record and the annotate-after-decision path are unchanged; only the arrival changes. The secret_token header Telegram supports must be required so a forged post is refused.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval channel telegram webhook registers the URL with a secret token and serves the callback; a post without the matching secret is refused and logged as a refusal, never a decision
- [x] #2 A tap arriving by webhook produces the same approval.granted or approval.rejected record, through the same sender mapping, as a tap arriving by long-poll, shown by a shared contract test
- [x] #3 Long-poll and webhook are mutually exclusive per bot at runtime, with a clear refusal when both are configured
- [x] #4 docs/cli-reference.md documents the mode and the proxy or tunnel requirement; the channels conformance suite passes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Read first (done): channels/telegram.ts (listen/pollOnce/handleUpdate/routeCallback/call), channels/contract.ts, conformance.ts, core/sender-identity.ts, core/telegram-config.ts, cli/channel-telegram.ts (prepareListen, dispatchPending, startListener, claimListenerBot, commandTelegram), cli/daemon.ts + cli/up.ts supervision, serve/server.ts + cli/serve.ts + serve/credentials.ts (APRV-421), SPEC §10.3, §11.1(7), design/channel-sender-identity.md, design/hosted-daemon-identity.md, tests/telegram-mock.ts, tests/layering.test.ts, tests/cli-help.test.ts, tests/cli-long-help.test.ts.

1. ONE update path, shared by construction. Extract TelegramChannel.pollOnce's per-update body into a private intake(raw, result) (offset bump, counter, handleUpdate) and add a public deliverUpdate(update): Promise<TelegramPollResult> that sweeps exactly as pollOnce does and calls the SAME intake. Webhook therefore reaches routeCallback -> senderOf -> this.handler -> recordChannelDecision unchanged: no copy of the sender mapping, the decision record or the annotate-after-decision path exists.
2. Transport exclusivity inside the process: TelegramChannel holds a transport claim (poll | webhook); listen() claims poll, the webhook server claims webhook, and the second claim refuses with a distinct code. Add registerWebhook/deleteWebhook/webhookInfo and a shared allowedUpdates() used by both setWebhook and getUpdates. registerWebhook adds the secret to the channel's redaction set so it cannot reach stderr or an error string.
3. src/channels/telegram-webhook.ts (new): a node:http receiver, zero new dependencies. Secret checked FIRST (before path, method and body), constant-time over SHA-256 digests as serve/credentials.ts does; duplicate secret headers refused rather than resolved. One route, POST only, bounded body with drain-before-refuse. Frozen refusal union, machine-readable, distinct: webhook-secret-mismatch, webhook-duplicate-secret-header, webhook-unknown-path, webhook-method-not-allowed, webhook-body-too-large, webhook-body-unreadable, webhook-not-an-update, webhook-transport-conflict. A refusal is counted, complained about on stderr and returned as {error:{code,message}}; it never reaches the decision path and appends NOTHING to events.jsonl, for the reason TELEGRAM_ANOMALY_KINDS already gives (an unauthenticated internet endpoint that can grow an append-only approval log is a log any stranger can pad). Updates are serialized through one promise chain: handleUpdate keeps a single ack slot, so concurrent updates are not safe.
4. The secret NEVER comes from the tree: a conventional launch-environment name APPROVAL_TG_WEBHOOK_SECRET in core/telegram-config.ts (names live in core; nothing under channels/ reads process.env). Conventional rather than policy-declared because channels.telegram in schema/policy.schema.json is additionalProperties:false, so declaring it there is a schema amendment and its own task; precedent is APPROVAL_SENDER_KEY (APRV-370).
5. src/cli/channel-telegram-webhook.ts (new verb, reached by a dynamic import from commandTelegram so the dispatcher/dispatched pair is not an ESM cycle): approval channel telegram webhook --url <https URL> [--listen [host:]port | --port n] [--allow-non-loopback] [--path] [--cycle <duration>] plus every listen flag. It reuses prepareListen for token/chat/actor/log/policy/payloads/TTL/layout/gloss, claimListenerBot for per-machine bot ownership, and dispatchPending + newDispatchState for delivery. Loopback bind by default with parseListen/isLoopbackHost from cli/mcp.ts and a non-loopback banner, exactly as approval serve: the operator's proxy terminates TLS. Startup order: every refusal before the listener exists (secret present/charset/length, https URL on a port Telegram accepts, bind), then getWebhookInfo (a foreign webhook refuses), then setWebhook with secret_token, then bind. deleteWebhook on clean stop so long-poll works again.
6. Mutual exclusion per bot at runtime (AC 3): claimListenerBot gains a getWebhookInfo probe, so `approval channel telegram listen` and `approval up` refuse with a new, distinct ListenRefusalCode (webhook-registered) naming the repair; the webhook verb refuses a URL another process registered. An unreachable Bot API stays a warning and not a refusal, per claimListenerBot's existing rule.
7. src/serve/server.ts is NOT imported: src/serve/ imports src/cli/, which imports src/channels/, so an import from the channel layer closes an ESM cycle that tests/layering.test.ts pins ('cli/serve.ts is the only CLI module that reaches the HTTP server'). What is reused is its shape, stated in the module doc: loopback default behind the operator's proxy, credential checked before the URL is parsed, refusal as a body with a frozen code, bounded body drained before the refusal is written, no state a restart loses.
8. Tests. tests/telegram-webhook.test.ts: (a) the SHARED CONTRACT TEST -- one scenario, one callback_query, driven through pollOnce and through an HTTP POST, asserting the appended approval.granted / approval.rejected records are identical field for field apart from seq/ts/hash/prev, under a policy that maps senders so the mapped approver (not the launch actor) is proven on both, plus the unmapped-account refusal on both; (b) a forged post (wrong, missing, duplicate secret) refused with its code, nothing appended, the request still pending; (c) each remaining refusal code; (d) transport exclusivity; (e) the secret appears in no response body and no complaint; (f) runChannelConformance driven through the webhook. tests/telegram-mock.ts gains setWebhook/deleteWebhook and a registration accessor.
9. Docs: docs/cli-reference.md gains `## channel telegram webhook` (the anchor the help's why: footer needs), covering the mode, the endpoint, the env var, the secret header, the refusal vocabulary, the mutual exclusion and the proxy-or-tunnel requirement; the listen section names the new refusal. SPEC.md is NOT edited: a proposed §10.3 hunk goes in the implementation notes.
10. Verify: npm run build, typecheck, lint, then channels/conformance/daemon suites and the new tests, then npm test once (22 SMTP failures on Node 26 are pre-existing, APRV-416).

REVIEW PASS (fixer, adversarial-review findings 1-10). 11. Per-gate transport lease: new core/channel-lease.ts, an O_EXCL lockfile under .approval/daemon/ holding pid + mode + start time, liveness-checked (stale pid reclaimed), taken by claimListenerBot in poll mode for up/listen and webhook mode for the webhook verb, released on clean stop; a second taker refuses telegram-poller-running or webhook-registered naming pid and mode. 12. handle.close() stops accepting, drains the serialize queue and the in-flight request count, then destroys idle sockets; the verb deleteWebhooks and prints stopped only after the drain, with SIGINT still hooked. 13. --path must start with /, hold no .., and equal url.pathname (webhook-path-invalid / webhook-path-mismatch). 14. setWebhook failure emits webhook-registration-failed with status and redacted description; the frozen union is pinned member by member. 15. webhook-unknown-path splits into webhook-malformed-request (400) and webhook-unknown-path (404). 16. Any existing registration refuses webhook-registered unless --reclaim; URLs normalised (lowercase host, no trailing slash) for the reclaim compare. 17. A failed getWebhookInfo/getMe probe refuses the webhook verb (webhook-probe-failed); the poller keeps its documented fail-soft. 18. Bind resolution refuses port 0 and anything outside 1..65535, through TELEGRAM_WEBHOOK_DEFAULT_HOST/PORT. 19. --url with userinfo refused; every printed url is origin plus served path, redacted otherwise. Finding 7 (secret_env in policy) is NOTE ONLY: recorded as a proposed follow-up task.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
WHAT WAS BUILT

`approval channel telegram webhook` registers a URL with `setWebhook` (carrying Telegram's `secret_token`), binds a loopback HTTP receiver, and hands each posted update to the channel. Nothing below the arrival is new or copied.

- `src/channels/telegram.ts`: `pollOnce`'s per-update body is extracted into a private `intake(raw, result)`, and a public `deliverUpdate(update)` sweeps as `pollOnce` does and calls the SAME `intake`. Both therefore reach one `handleUpdate` -> one chat check, one `senderOf`, one checkpoint/review parser pair, one resolution ladder, one early ack, one `onDecision` handler, one annotation. Added beside it: `allowedUpdates()` (one list for `getUpdates` and `setWebhook`), `registerWebhook`/`deleteWebhook`/`webhookInfo`, and `claimTransport` with `TelegramTransportError`. `redact` now scrubs a LIST of secrets, and `registerWebhook` adds the `secret_token` to it before the call that sends it.
- `src/channels/telegram-webhook.ts` (new): the receiver. `node:http` and `node:crypto`, no new dependency. Secret header checked FIRST, constant-time over SHA-256 digests; duplicate headers refused rather than resolved; one route, POST only; bounded body drained before the refusal is written; updates serialized through one promise chain.
- `src/cli/channel-telegram-webhook.ts` (new): the verb. Reuses `prepareListen`, `claimListenerBot`, `wireListener`, `dispatchPending` and `reportCycle` unchanged.
- `src/cli/channel-telegram.ts`: `wireListener` extracted out of `startListener` (both transports register the same four handlers); `claimListenerBot` gained a `getWebhookInfo` probe and the `webhook-registered` refusal; `webhook` added to the subcommand switch through a dynamic import.
- `src/core/telegram-config.ts`: `TELEGRAM_WEBHOOK_SECRET_ENV`.
- `tests/telegram-mock.ts`: `setWebhook`/`deleteWebhook` are real in the mock (they move what `getWebhookInfo` reports), plus `webhookRegistration()`.

DECISIONS THE TASK DID NOT SPECIFY

1. A refused post appends NOTHING to the log. AC 1 says "logged as a refusal, never as a decision"; the refusal is counted on the handle's per-code stats, complained about on the runner's stderr, and returned as `{"error":{"code","message"}}`. It is not an event. This is the rule `TELEGRAM_ANOMALY_KINDS` already states for ignored callbacks ("writing 'someone we do not answer to pressed a button' into an append-only approval log would let any stranger who guessed the bot's handle grow the record a human is asked to trust"), and it binds harder on a public URL than in a chat: an endpoint the internet can reach that could append is an endpoint anyone can use to pad the tenant's log, and to make `approval log verify` slower for free. If Carter wants forged posts in the log, that is an `audit.*` event shape and its own task.
2. The secret's env var is CONVENTIONAL (`APPROVAL_TG_WEBHOOK_SECRET`) and not policy-declared. `channels.telegram` in `schema/policy.schema.json` is `additionalProperties: false`, so a declared name is a schema amendment and its own task; and the precedent for launch-environment credentials with fixed names is `APPROVAL_SENDER_KEY` (APRV-370) and `approval serve`'s two bearer tokens (APRV-421). Consequence: two gates on one machine get their own value from their own launch environment (as they already do for the token), never from two different names.
3. `src/serve/server.ts` is NOT imported. `src/serve/` imports `src/cli/`, which imports `src/channels/`, so an import from the channel layer closes an ESM cycle, and `tests/layering.test.ts` pins that direction ("cli/serve.ts is the only CLI module that reaches the HTTP server"). The two are also different surfaces: six routes and two bearer credentials for two parties, against one route and Telegram's echoed secret. What IS reused is APRV-421's shape, named in the module doc: loopback default behind the operator's proxy, credential before the URL parse, refusal as a body with a frozen code, oversized body drained before the refusal, no state a restart loses. If the orchestrator would rather have one bounded-body reader, the honest place is a new `src/core/` module both import; I left APRV-421's file alone rather than refactor a lane that merged this morning.
4. The verb runs a dispatch cycle, because without one nothing would ever reach the phone: `--cycle <duration>` (default 30s) plus a cycle immediately after each handled update, both serialized with delivery. That is the webhook's `beforePoll`, same function, same `DispatchState`.
5. The response is written AFTER the update is handled. Telegram retries a delivery it got no 2xx for; answering first would make the retry race the gate instead of finding a decided request. The redelivery that does happen is refused `already-decided`, which is the property a twice-pressed button has had since APRV-26.
6. A clean stop calls `deleteWebhook`, so the bot is pollable again afterwards. `drop_pending_updates` is false in both directions: a tap that arrived while the process was down is the approver's answer, and the gate decides whether it is still honourable.
7. `--url` is refused unless it is https on 443/80/88/8443 (Telegram's own list) before any call is made, and the secret is refused when unset, under 24 characters, or outside Telegram's `A-Z a-z 0-9 _ -`. Refusing here rather than letting `setWebhook` fail is what puts the proxy requirement in front of the operator in a sentence instead of a Bot API error.
8. `approval up` is unchanged: it still starts the poller, and it now REFUSES when a webhook holds the bot (it shares `claimListenerBot`). Supervising a webhook part inside `up` is a bigger decision (it binds a port and registers a public URL) and was left out.

GLOBAL INVARIANTS TOUCHED (SPEC §11.1)

- Invariant 4 (a self-reported field never reduces scrutiny): the whole reason the secret header is required and checked before anything in the body is read. Nothing in a posted body is treated as evidence about itself; the sender still comes from `callback_query.from.id` alone, read by the same `senderOf`.
- Invariant 6 (refusals machine-readable and distinct): two new frozen unions, `TELEGRAM_WEBHOOK_REFUSAL_CODES` (9 codes) and `WEBHOOK_REFUSAL_CODES` (9 codes), plus one new `ListenRefusalCode` (`webhook-registered`) and one `TELEGRAM_TRANSPORT_REFUSAL_CODES` (`transport-conflict`). Every code distinguishes a distinct repair; the tests assert the receiver does not collapse two facts into one code.
- Invariant 7 (configuration never loaded implicitly from the working tree): the secret comes from the launch environment, and nothing under `src/channels/` reads `process.env`.
- Enforcement paths read only verified records, gate-typed events take no caller timestamp, raw secrets never appear in the log, every check-then-append goes through compare-and-append: all unchanged, because the decision path is literally the same code. The channel appends nothing on its own account and gained no way to.

PROPOSED SPEC §10.3 HUNK (not applied; SPEC.md is untouched)

§10.3 already writes the interface as `notify(request) -> delivery_id`, `poll()/webhook() -> decision`, so this adds no capability to the specification and only says what the second half now means. Suggested addition after the "What each channel authenticates" table:

  **A channel MAY receive updates by webhook instead of by polling (amended APRV-424).** The two are alternatives per transport account and an implementation MUST NOT run both against one: a runtime that did would answer a human's gesture from whichever arrival reached it first. Where a channel receives by webhook it MUST authenticate each post with a shared secret the runtime registered and the transport echoes, taken from the launch environment (§11.1 invariant 7) and never from a file the runtime discovered; a post whose secret does not match MUST be refused, MUST record no decision, and MUST NOT append to the log, for the reason an ignored callback does not: an endpoint reachable by anyone who can route to it would otherwise let a stranger grow the record a human is asked to trust. Nothing else about the gesture changes. The sender the transport attributes it to, the mapping of §5.2, the decision event, and the annotation of a settled delivery MUST be the same code path the polling arrival uses, and a conforming implementation SHOULD prove that rather than assert it. A refusal of either arrival MUST be machine-readable and distinct (§11.1 invariant 6).

WHAT I COULD NOT DO / RESIDUALS

- A cold process cannot resolve a tap on its own. The delivery and nonce maps are in memory, as SPEC §10.3 requires, so a webhook process that has not delivered the request in ITS lifetime answers a tap with the APRV-196 stale-copy toast rather than a decision (the callback carries a 16-hex digest of the action key, and only the log can turn that back into a key). This is exactly the long-poll behaviour after a restart, so it is parity and not a regression, and the task's "no in-memory state a restart loses beyond what the channel already keeps" is met by adding none. A host that truly sleeps between requests would want a log-backed `actionRef -> pending action key` probe, shaped like the existing `describeAction` and wired the same way. I did not add it: it changes the SHARED resolution ladder, which is the seam AC 2 is about, and it deserves its own task and its own refutation.
- Cross-machine exclusivity rests on the Bot API. `getWebhookInfo` at startup catches the common case, the per-machine ownership registry catches the local one, and a poller that misses both still meets the 409 the existing loop already reports. Nothing here can stop a second host from calling `setWebhook` afterwards; Telegram keeps the last registration, and the displaced receiver simply stops being posted to.
- `approval doctor`, `approval env` and `approval setup channel telegram` do not know about the new variable. Adding it to the credential manifest and the doctor roster is a small, separate change and would have pulled the setup conversation into this diff.
- No SPEC.md edit, no policy-schema edit, no `approval up` part.

VALIDATION

npm run build, npm run typecheck, npm run lint: clean.
tests/telegram-webhook.test.ts: 13 tests, all passing, including the shared contract test (one callback_query, same callback id, same mapped account, driven through `pollOnce` and through an HTTP POST; the two `approval.granted` / `approval.rejected` records are compared field for field with only seq/ts/hash/prev/token_sha256 normalised, and `channel`, `payload.sender`, `payload.sender_source` and the mapped actor asserted present on both), the same comparison for the `sender-unmapped` refusal record, the forged-post cases (missing, wrong, short, duplicated header: refused, nothing appended, request still pending, and the good post afterwards still decides), the rest of the frozen union, transport exclusivity in both directions, the `webhook-registered` preflight, the verb's eight preparation refusals, and the shared channel conformance suite driven entirely over the webhook.
channels-telegram, channels-contract, channels-cli, channels-web, conformance: 266 tests, all passing.
daemon suites plus telegram-tap-latency: 120 tests, all passing.
cli-help, cli-long-help, layering, docs-guard, cli-up-preflight: 107 tests, all passing.

FULL SUITE

`npm test`: 5138 tests, 5114 pass, 23 fail, 1 skipped. 22 of the 23 are the pre-existing SMTP failures on Node 26 (APRV-416), in files this diff does not touch: adapter-email 14, cli-setup 4 ("setup adapter email: ..."), smtp-probe 4, every one of them the same `options.servername` TLS change ("Setting the TLS ServerName to an IP address is not permitted"). I am not fixing them, per the brief.

The 23rd was MY OWN doing and is not a defect in the diff: `demo-provision.test.ts`'s `--check` row failed `approval doctor failed 1 check(s): build-freshness`, because I committed four small source fixes WHILE that run was in flight, which made `dist/` older than `src/` inside the child process doctor spawns. Rebuilt and re-run on its own afterwards: demo-provision 19 tests, 19 pass. An earlier full run of the same diff, before those edits, was 5138 / 5115 pass / 22 fail with exactly the SMTP set.

Re-run after the last commit, on a fresh build: tests/telegram-webhook.test.ts 14/14; channels-telegram + channels-contract + conformance 221/221; cli-help + cli-long-help + layering + docs-guard + cli-up-preflight 107/107; daemon suites + telegram-tap-latency 120/120 (before the last four commits, none of which touch the daemon). build, typecheck and lint clean at every commit.
<!-- SECTION:NOTES:END -->
