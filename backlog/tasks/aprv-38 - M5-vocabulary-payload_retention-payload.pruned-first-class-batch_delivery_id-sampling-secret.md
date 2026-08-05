---
id: APRV-38
title: >-
  M5 vocabulary: payload_retention, payload.pruned, first-class
  batch_delivery_id, sampling secret
status: To Do
assignee: []
created_date: '2026-08-05 14:18'
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
- [ ] #1 policy schema + SPEC section 5.2 gain payload_retention (standard duration grammar) with the terminal-state-only, never-non-terminal, daemon-only-pruning semantics of ruling 2b; fixtures both ways
- [ ] #2 payload.pruned joins the event enum in SPEC section 8 and the event schema (system actor required, payload carrying the hash), with valid and invalid fixtures; version-noted as the first post-v0.1-draft enum addition
- [ ] #3 batch_delivery_id becomes a first-class optional payload field on approval.granted/rejected written by the gate and channels; note-encoding still read; batchDeliveryIdOf prefers the field; tests cover both
- [ ] #4 audit.sampling_secret_env lands in policy schema + SPEC (env-var name only, never the secret), with the B1 outside-agent-reach requirement restated
- [ ] #5 All frozen-shape and fixture suites updated additively; 949-test baseline stays green
<!-- AC:END -->
