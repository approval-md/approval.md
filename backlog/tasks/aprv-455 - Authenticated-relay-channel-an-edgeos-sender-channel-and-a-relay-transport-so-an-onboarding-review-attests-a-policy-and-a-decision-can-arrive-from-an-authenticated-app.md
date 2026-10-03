---
id: APRV-455
title: >-
  Authenticated relay channel: an edgeos sender channel and a relay transport so
  an onboarding review attests a policy and a decision can arrive from an
  authenticated app
status: In Progress
assignee:
  - '@claude'
created_date: '2026-10-03 04:25'
updated_date: '2026-10-03 20:58'
labels:
  - channels
  - attest
  - schema
  - agent-village
  - spec
dependencies:
  - APRV-449
references:
  - private/agentvillage-integration/05-integration-architecture.md
priority: high
ordinal: 343000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Agent Village residents review their approval.md settings in the Edge City onboarding app, and Carter wants that review to be the attestation of the policy in force (and later changes to it). Core admits only telegram under approvers.<id>.senders (schema/policy.schema.json line 419: a channel whose transport attributes a gesture to an account id the sender cannot choose; web and cli deliberately absent), the web channel is loopback and unauthenticated, and grant, reject and attest are human-only verbs absent from approval serve. An EdgeOS-authenticated session in the control plane attributes an acceptance to a stable human id (the EdgeOS /humans/me id) the resident cannot choose, under the same operator trust the Telegram relay already asks for (the daemon trusts the relay's report of callback_query.from.id). Design and build: (1) a new sender channel name, edgeos, mapped beside telegram in approvers.<id>.senders, with the schema rationale extended on the APRV-324 ground; (2) a relay transport the daemon process runs (a sibling of channel telegram webhook): an inbound POST authenticated by a shared secret from the launch environment, carrying a gesture (attest a proposed policy by hash, or grant/reject a request by id), the sender id, and the hash the human saw; mapped against the attested policy's senders exactly as a Telegram tap is; refused sender-unmapped and audited otherwise; a forged post appends nothing; (3) the attestation case: the control plane proposes the rendered policy (policy.proposed with the semantic diff, as the channel attestation path APRV-109 already does) and the resident's acceptance in the app appends policy.updated with actor human:<resident> and payload.sender {channel: edgeos, id}; the operator bootstrap attestation (APRV-449) is what makes the resident a mapped sender the first time; (4) SPEC section 10.3 hunk proposed as pending sign-off, stating the trust level in APRV-422's words. Never an HTTP decision verb on serve's agent or tenant credentials: this is a third transport with its own secret, in the daemon's process. Context: approval-md private/agentvillage-integration/05-integration-architecture.md section 5 (gitignored pack).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approvers.<id>.senders admits an edgeos id; the schema description states why the channel qualifies; a policy mapping it loads and attests
- [ ] #2 A relay transport in the daemon process accepts an authenticated gesture (shared secret from the launch environment, never from the policy or the working tree) and resolves its sender against the attested policy; an unmapped sender is refused sender-unmapped with one audit.decision_refused; a post without the secret appends nothing and returns a frozen code; both under test with a fake control plane
- [ ] #3 An acceptance of a proposed policy by hash appends policy.updated with actor human:<resident> and payload.sender channel edgeos; a stale hash is refused with a distinct code; a grant or reject of a request through the same transport behaves exactly as a Telegram tap, including policy-drift and expiry refusals
- [ ] #4 docs name the trust level (the daemon trusts the relay's attribution, operator trust per APRV-422) and the SPEC section 10.3 hunk is proposed in the notes, not applied; conformance refusal-union vectors regenerated
- [ ] #5 A refutation pass covers forged posts, replayed gestures, a sender swap between proposal and acceptance, and a relay secret leaking into the log
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Part 1 (sender channel): schema senderChannel enum gains edgeos and senders.properties.edgeos (raw grammar ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ or the keyed hmac-sha256 form; colon-free so a raw id can never collide with the keyed prefix); description extended on the APRV-324 ground. sender-identity.ts: SENDER_CHANNELS = [telegram, edgeos], an exported EdgeOS id grammar, and a guard so an observed id wearing the keyed prefix never matches a keyed entry through the raw comparison. Tests: load/attest a policy mapping edgeos raw and keyed, resolver modes for edgeos, the digest-as-raw guard.
Part 2 (relay): src/channels/relay.ts (closed body shape, frozen RELAY_REFUSAL_CODES, applyRelayGesture translating attest/decline/grant/reject into recordChannelDecision with requireSenderMapping, propose into proposeAttestation with a verified in-force baseline), src/channels/relay-server.ts (loopback HTTP, x-approval-relay-secret checked before path/method/body, digest timingSafeEqual, duplicate header refused, bounded body, issued_at window, nonce ledger by O_EXCL files under the gate's daemon/ dir so replay is refused across processes and restarts without a lease), src/cli/channel-relay.ts (approval channel relay: APPROVAL_RELAY_SECRET from the launch environment with floor/charset, --listen/--port/--allow-non-loopback, --proposer). contract.ts: ChannelActorOptions.requireSenderMapping turns every configured-actor fallback into sender-unmapped plus one audit.decision_refused. policy-proposal.ts: ProposeInput.reaffirm lets the relay propose bytes already in force so an unchanged review is still the resident's attestation. Registry entry human_only so serve and MCP never publish it. Conformance: relay_refusal_codes union, vectors regenerated. Docs: cli-reference section, hermes-hook Agent Village paragraph, CHANGELOG; SPEC 10.3 and 11.2 hunks proposed in notes only.
Tests with a fake control plane (real HTTP posts against a tmp gate): forged post appends nothing, unmapped sender audited once, attest by hash appends policy.updated with sender edgeos, stale hash refused, grant/reject with drift and expiry, nonce replay, secret absent from the log. Then an opus refuter, PR(s), CI, arm.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Resume point: implementation complete in worktree approval-md-wt/lane-455 (branch lane/aprv-455); next: full npm test, opus refuter on git diff origin/main, then commit, PR, CI, arm.
<!-- SECTION:NOTES:END -->
