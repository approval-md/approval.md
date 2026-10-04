---
id: APRV-456
title: >-
  Telegram stale-copy fallback is off when the channel runs through a relay: a
  tap whose nonce the gate did not issue never reaches the gate by action ref
status: To Do
assignee: []
created_date: '2026-10-03 19:10'
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
- [ ] #1 With --api-base set (or an explicit --no-stale-copy flag), a callback whose nonce this process did not issue is refused with a distinct machine-readable code, appends at most one audit record, and never reaches decide(); covered by a test against the fake Bot API in both listeners
- [ ] #2 The direct-bot shape keeps the APRV-196 behaviour unchanged, under its existing tests
- [ ] #3 The refusal code joins the frozen channel decision refusal union with a conformance vector, and docs/cli-reference.md and docs/hermes-hook.md state the rule
<!-- AC:END -->
