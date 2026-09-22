---
id: APRV-424
title: >-
  Telegram webhook transport: decisions arrive by webhook so no long-poll
  process needs to run
status: In Progress
assignee:
  - '@opus-424'
created_date: '2026-09-21 06:42'
updated_date: '2026-09-21 23:54'
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
- [ ] #1 approval channel telegram webhook registers the URL with a secret token and serves the callback; a post without the matching secret is refused and logged as a refusal, never a decision
- [ ] #2 A tap arriving by webhook produces the same approval.granted or approval.rejected record, through the same sender mapping, as a tap arriving by long-poll, shown by a shared contract test
- [ ] #3 Long-poll and webhook are mutually exclusive per bot at runtime, with a clear refusal when both are configured
- [ ] #4 docs/cli-reference.md documents the mode and the proxy or tunnel requirement; the channels conformance suite passes
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
<!-- SECTION:PLAN:END -->
