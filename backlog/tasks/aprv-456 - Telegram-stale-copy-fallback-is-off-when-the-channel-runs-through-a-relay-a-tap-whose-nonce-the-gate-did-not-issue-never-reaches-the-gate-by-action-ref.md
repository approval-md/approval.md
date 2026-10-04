---
id: APRV-456
title: >-
  Telegram stale-copy fallback is off when the channel runs through a relay: a
  tap whose nonce the gate did not issue never reaches the gate by action ref
status: Done
assignee:
  - '@claude-lane-C15'
created_date: '2026-10-03 19:10'
updated_date: '2026-10-04 22:57'
labels:
  - telegram
  - channels
  - hosting
  - security
  - agent-village
dependencies: []
references:
  - private/agentvillage-integration/05-integration-architecture.md
priority: high
ordinal: 344000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-196 added a stale-copy fallback in src/channels/telegram.ts (around lines 1695-1741, counted as staleCopyDecisions): when a tap arrives with a nonce this process does not know, the channel falls back to the action ref (sha256 of the action key, first 16 hex) and carries the tap to the gate if this process holds that action open. The bound that made this safe was that only the bot token puts buttons in front of the approver. In the Agent Village relay (agentvillage-controlplane PR 67: the daemon talks Bot API to a control-plane relay through --api-base with a per-tenant relay token), anyone holding the relay token can send a message to the approver with inline buttons whose callback_data carries the ref of a real pending action under forged text; the approver's genuine tap passes the chat check and the sender mapping, and the stale-copy path grants it. The relay cannot tell the daemon's sends from a token holder's. Found by the refuter on PR 67 (2026-10-03). The relay token lives only in the approvald 0600 env, so this needs a leak, and day one has no manual tool class, but it would grant an inferred-intent publish under text the resident never saw. Fix in core: when the channel runs against a non-default api base (relayed), or when a new flag says so, a tap whose nonce is unknown is refused with a distinct code and never carried by action ref; the APRV-196 fallback stays for the direct-bot shape. Document the residual for the direct shape and the relay shape in docs/hermes-hook.md For Agent Village.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 With --api-base set (or an explicit --no-stale-copy flag), a callback whose nonce this process did not issue is refused with a distinct machine-readable code, appends at most one audit record, and never reaches decide(); covered by a test against the fake Bot API in both listeners
- [x] #2 The direct-bot shape keeps the APRV-196 behaviour unchanged, under its existing tests
- [x] #3 The refusal code joins the frozen channel decision refusal union with a conformance vector, and docs/cli-reference.md and docs/hermes-hook.md state the rule
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add `nonce-not-issued` to CHANNEL_DECISION_REFUSAL_CODES (core/sender-identity.ts) with its refusal line; regenerate refusal-unions (28.0.0, collision rule).
2. TelegramConfig.staleCopy (default true = APRV-196). When false, routeCallback refuses a g/r tap whose nonce this process never issued: no ref fallback, no describeAction, never the decision handler; at most one audit.decision_refused via a new onRefusedDecision registration, only when the ref names a delivery this process holds open (the action key comes from that delivery, never from the bytes); the nonce joins refusedNonces so a replay appends nothing.
3. contract.ts recordSurfaceRefusal: resolves the sender for the record and calls the existing noteRefusedDecision; never calls decide().
4. CLI: prepareListen computes staleCopy = apiBase unset or default AND no --no-stale-copy; flag on channel telegram listen, channel telegram webhook and up; wireListener registers the refusal recorder; restart banner drops the earlier-copies-still-decide promise when off.
5. Tests with the fake Bot API: forged button for a real pending ref refused on poll and webhook, one audit record, request still pending, live card still decides; prepareListen derivation; direct-shape restart still decides (existing APRV-196 tests unchanged).
6. Docs: cli-reference (channel telegram), hermes-hook For Agent Village residuals, CHANGELOG Unreleased; implementation notes with SPEC §10.3 hunk.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was done

**The rule.** `TelegramConfig.staleCopy` (default `true`, the direct-bot shape and APRV-196 exactly). When it is false, `routeCallback` refuses a single-request decision tap (`g|r:<nonce>[:<ref>]`) whose nonce is not in this process's live `deliveries` map, before any reference lookup, before the `describeAction` log probe, and without calling the decision handler (`refuseUnissued`). The code is `nonce-not-issued`, a new member of `CHANNEL_DECISION_REFUSAL_CODES` (core/sender-identity.ts) with its own approver line. The live card is not touched and still decides. Taps on a card a refused tap disarmed (APRV-442 `refusedNonces`) keep their existing path. Digest "all" buttons, checkpoint and review buttons never had a fallback and are unchanged.

**Who turns it off.** `staleCopyFor(apiBase, noStaleCopy)` in cli/channel-telegram.ts, called by `prepareListen`, which `channel telegram listen`, `channel telegram webhook` and `approval up` (and so `daemon run --with-channels`) all go through: off when `--api-base` is set to anything but `https://api.telegram.org` (trailing slashes ignored), or when `--no-stale-copy` is passed (new boolean on all three verbs). The policy is deliberately not consulted and nothing in an update reaches the field; the constructor treats anything other than `undefined`/`true` as off (the strict direction). A self-hosted Bot API server is treated as a relay, stated in the docs.

**The record.** `TelegramChannel.onRefusedDecision(handler)` is a new registration, separate from `onDecision` because that one calls the gate. `wireListener` (shared by poller and webhook runner) wires it to `recordSurfaceRefusal` (channels/contract.ts), which resolves the sender with `actorForSender` (same rule as every refused decision since APRV-324/370: mapped approver named, unmapped account recorded with no actor, no mapping -> configured identity) and calls the existing `noteRefusedDecision` -> `recordRefusedDecision`. It never calls `decide()`. A record is written only when the tap's reference names a delivery this process holds open, and the action key comes from that delivery, never from the bytes; a reference that names nothing open, a ref-less button, or a replay of the same nonce (`unissuedRefused`, capped at TELEGRAM_REFUSED_NONCE_CAP) records nothing. So one button costs the log at most one `audit.decision_refused`. The operator's terminal gets the refusal line either way (`--json`: a `decision` event with `ok:false, code`).

**Observability.** `stats().staleCopyRefusals`, `TelegramPollResult.refused[]` (code, action_key or null, detail), a stderr complaint per refusal. The restart banner (`bannerLines(n, staleCopy)`) says earlier copies no longer decide when the fallback is off.

## Decisions worth knowing

- **"Not holding" rather than "never issued".** A set of every nonce this process ever issued was considered and rejected: anyone who has seen one genuine button's bytes (a relay-token holder reading updates through the relay) could pair an old issued nonce with a new pending action's reference and pass it. So a nonce this process issued and has since forgotten (annotated card, swept delivery, restart) is refused the same way. Cost: a relayed listener does not honour taps on pre-restart copies; the banner says so.
- **Recording on a forged tap.** The record says a human's attention was spent on a card this listener did not send, which is the forensic signal an operator needs for a leaked relay token. The action key it names is this process's own delivery for that reference.
- **Conformance.** `refusal-unions` 28.0.0 (one major above 27.0.0, the union grew). If C14 or another lane lands a 28.0.0 first, the collision rule in conformance/README.md applies: regenerate on top and take the next major.

## Global invariants touched (SPEC §11.1)

- **Invariant 4 (self-reported fields never reduce scrutiny):** strengthened. The callback's action reference, which is bytes off the network, no longer selects a request to decide on a relayed channel. The record's action key comes from this process's own delivery, never from the bytes; the sender is `callback_query.from.id` only.
- **Invariant 6 (refusals machine-readable and distinct):** `nonce-not-issued` is its own code in the surface union, distinct from `sender-unmapped` (the account may be the very approver the policy names; what is wrong is the button) and from the gate's codes (`decide` is never called).
- Gate-typed events / caller timestamps: unchanged; the record goes through `recordRefusedDecision`, which takes `ts` from the injected clock. Compare-and-append: unchanged, through the same `withHeadRetry` cycle.

## Residuals (documented in docs/hermes-hook.md "For Agent Village")

- Relay shape: the nonce binds a button to this process's issuance, not to the text above it. A relay-token holder who obtains a LIVE card's callback bytes (reading updates through the relay, or any Bot API method that returns a message with its keyboard) can still put them under forged text. Bound: relay-token custody.
- Direct shape: unchanged; a bot-token holder can forge a card with a real reference and the fallback carries the tap. Bound: bot-token custody; `--no-stale-copy` is the opt-in.

## SPEC amendment text (apply by hand)

§10.3, a new paragraph after "Every gesture a channel collects, not only decisions":

> **A button the listener is not holding, behind a relay (amended APRV-456).** A push channel MAY resolve a decision tap whose per-process nonce it does not hold to a request it holds open by an action reference carried in the button (the reference implementation's earlier-copy fallback, APRV-196), and the gate then judges that tap as it judges any other. That fallback is safe only where nothing but the channel's own credential can put a button in front of the approver. Where the channel reaches its transport through an intermediary that other parties can also address with the same credential (a relay, or any Bot API base other than the transport's own), anyone holding that credential can present a button carrying a real pending request's reference under text the runtime never sent. An implementation MUST therefore disable the fallback for such a channel, and MUST offer an explicit launch option that disables it on any channel. With the fallback disabled, a decision tap whose nonce the listener does not hold MUST be refused `nonce-not-issued` before the gate is called, MUST NOT be resolved by its reference to any request, and MUST leave the listener's own live delivery of that request answerable. It MAY append one `audit.decision_refused`, and only when the reference names a request the listener itself holds open; the action key on that record MUST come from the listener's own delivery and never from the button. The setting is launch configuration: no policy key and nothing carried in an update may enable or disable it.

§11.1, `channel_decision_refusal_codes` table, a new row after `attest-requires-terminal`:

> | `nonce-not-issued` | A decision tap arrived on a channel whose earlier-copy fallback is disabled (§10.3: a relayed transport, or the explicit launch option) carrying a nonce the listener does not hold. Evaluated before the gate's verbs, so nothing is decided; at most one `audit.decision_refused` is appended, and only when the tap's reference names a request the listener holds open. Distinct from `sender-unmapped`, because the account may be a mapped approver: what is refused is the button. (Amended APRV-456.) |

Validation: npm test exit 0 (5595 tests, 5594 pass, 1 skip, 0 fail) under the CLAIMS lock 22:46Z-22:57Z; npm run typecheck exit 0; npm run lint exit 0 (no warnings). New tests: tests/telegram-webhook.test.ts (forged button on poll and webhook, stale-copy rule via prepareListen, wired listener records the refusal) and tests/channels-telegram.test.ts (relayed restart, direct-shape residual pinned, banner). Existing APRV-196 tests unchanged and green.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A Telegram listener whose stale-copy fallback is off (any --api-base but the Bot API, or the new --no-stale-copy on listen, webhook and up) refuses a decision tap whose nonce it is not holding with nonce-not-issued: never carried to the gate by action ref, at most one audit.decision_refused (only when the ref names a delivery this process holds; key from that delivery), live card stays armed, banner adjusted. Direct shape unchanged. nonce-not-issued joins channel_decision_refusal_codes (refusal-unions 28.0.0). Verified by new poll+webhook fake-Bot-API tests and the full suite (exit 0).
<!-- SECTION:FINAL_SUMMARY:END -->
