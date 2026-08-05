---
id: APRV-38
title: >-
  M5 vocabulary: payload_retention, payload.pruned, first-class
  batch_delivery_id, sampling secret
status: In Progress
assignee:
  - '@fable'
created_date: '2026-08-05 14:18'
updated_date: '2026-08-05 16:14'
labels: []
milestone: m-7
dependencies: []
priority: high
type: feature
ordinal: 38000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The milestone's spec-and-schema groundwork, all additive and version-noted since the shapes are frozen. Four pieces. (1) Ruling 2b verbatim intent: policy key payload_retention (duration, standard grammar) permits pruning payload files whose action reached a terminal state (executed, rejected, expired, revoked) longer ago than the duration; non-terminal payloads are never prunable; default absent means retained indefinitely as material evidence. (2) New event type payload.pruned (system actor, carrying the pruned hash so the evidence of deletion outlives the deletion) — the 17th type: SPEC section 8 enum, event schema, fixtures. (3) The queued first-class batch_delivery_id payload field replacing the interim note-encoding: schema additive, gate/channels write the field, readers accept both encodings during v0.1 (documented). (4) Sampling-secret configuration per amended section 5.2 B1: an operator-held secret outside the repo and any agent-readable path — define audit.sampling_secret_env (env-var NAME in policy, mirroring the channel credential convention). Every spec amendment lands same-commit with its schema; wording drafted for review where not already dictated.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 policy schema + SPEC section 5.2 gain payload_retention (standard duration grammar) with the terminal-state-only, never-non-terminal, daemon-only-pruning semantics of ruling 2b; fixtures both ways
- [x] #2 payload.pruned joins the event enum in SPEC section 8 and the event schema (system actor required, payload carrying the hash), with valid and invalid fixtures; version-noted as the first post-v0.1-draft enum addition
- [x] #3 batch_delivery_id becomes a first-class optional payload field on approval.granted/rejected written by the gate and channels; note-encoding still read; batchDeliveryIdOf prefers the field; tests cover both
- [x] #4 audit.sampling_secret_env lands in policy schema + SPEC (env-var name only, never the secret), with the B1 outside-agent-reach requirement restated
- [x] #5 All frozen-shape and fixture suites updated additively; 949-test baseline stays green
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent in an isolated worktree branched from current main (fable briefs, reviews, merges via PR under branch protection). 2. payload_retention: policy.schema.json additive key (standard duration grammar, reuse the existing duration pattern), SPEC 5.2 amendment with ruling-2b semantics (terminal-state-only pruning, non-terminal never prunable, absent = retain indefinitely, daemon-only), fixtures valid+invalid. 3. payload.pruned: SPEC 8 enum sentence (sixteen -> seventeen, version-noted first post-v0.1-draft addition), event.schema.json enum + per-type constraint (system actor required, payload.sha256 required), fixtures valid+invalid. 4. batch_delivery_id: first-class optional payload field on approval.granted/rejected in event schema; gate/channel write path emits the field; batchDeliveryIdOf prefers field, falls back to note-encoding during v0.1 (documented both directions); tests cover both encodings. 5. audit.sampling_secret_env in policy.schema.json + SPEC 5.2 (env-var NAME only, mirroring channel credential convention, B1 outside-agent-reach restated). 6. Frozen-shape suites updated additively; full gates (test/lint/typecheck) green; PR to main, ci required check green, merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built by an Opus subagent in an isolated worktree, reviewed by fable, delivered as PR #1 (branch aprv-38-m5-vocabulary). All four pieces landed additively: payload_retention (policy schema $ref duration + SPEC 5.2 bullet + Durations list mention + 5 fixtures), payload.pruned (17th type: SPEC 8 enum + enum-versioning bullet, event schema per-type rule requiring system: actor and payload_hash [64-hex], 5 fixtures including the orphan case), first-class batch_delivery_id (gate DecideOptions.batchDeliveryId written on grant/reject only, revoke ignores it by design; recordChannelDecision stops note-encoding; batchDeliveryIdOf prefers field with note fallback; dual-read window documented in SPEC 10.3 and contract.ts), audit.sampling_secret_env (env-var name only, B1 restated). INVARIANT NOTE: the gate write path (decide) was touched to add the payload field; ts assignment stays runtime-side (invariant 2 unaffected, confirmed in review) and the field is caller-supplied grouping metadata that raises no scrutiny question (invariant 4 untouched). One existing assertion rewritten rather than extended: channels-web batch test asserted the note-encoding verbatim, which is deliberately no longer written; it now asserts the first-class field and that note stays absent without a human note. Design note: empty-string batchDeliveryId is dropped silently (documented in DecideOptions), consistent with schema minLength 1; a refusal code was deliberately not added for a vocabulary task. Verification: 972 tests (953 baseline +19), lint, typecheck; PR #1 ci aggregator green on both matrix jobs. MERGE PENDING: gh pr merge was blocked twice by the session permission classifier; the human merges PR #1 or grants the permission.
<!-- SECTION:NOTES:END -->
