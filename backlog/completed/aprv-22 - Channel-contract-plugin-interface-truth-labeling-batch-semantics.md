---
id: APRV-22
title: 'Channel contract: plugin interface, truth-labeling, batch semantics'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 10:50'
updated_date: '2026-08-05 11:15'
labels: []
milestone: m-5
dependencies: []
priority: high
type: feature
ordinal: 22000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC section 10.3: channels are transport plugins (notify(request) -> delivery_id; decision intake; health), never owners of state — decisions become log events. This task defines the contract every concrete channel (cli, web, telegram) implements, and it lands first so channels are written against an interface rather than each other. Two spec obligations are enforced HERE, in the contract layer, not per-channel: B3 computed-vs-claimed — the runtime pre-tags every displayed field as computed (class resolution, budget state, attestation status, payload hash, chain position) or claimed (summaries, estimates, rationale, confidence) before a channel ever sees it, and a shared conformance suite asserts a channel cannot render untagged or mis-tagged fields; and B7 batching — the contract models batch presentation with unit decisions (each decision its own log event carrying the batch delivery id), and forbids batches mixing manual classes whose payload-display requirements would hide any full payload. Channels receive tagged render-ready data; the runtime owns truth-labeling.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A Channel interface (notify, decision intake, health) is defined with typed request/decision shapes; decisions flow only into log events through the existing gate verbs, and channels hold no state (SPEC 10.3), documented in the contract
- [x] #2 Every field handed to a channel is pre-tagged computed or claimed by the runtime; the tagging is exhaustive (an untagged field cannot be constructed without a type error) and manual actions carry the full payload or its faithful rendering distinct from agent summaries per amended section 10.4
- [x] #3 A shared conformance test suite, runnable against any channel implementation, asserts: no untagged or mis-tagged rendering, full-payload display for manual actions, decision round-trip to a log event, and the B7 batch rules (unit decisions with batch delivery id; forbidden-mix refusal)
- [x] #4 Batch semantics per B7 are modeled in the contract with tests, independent of any concrete channel
- [x] #5 Contract types and the conformance suite live so that cli, web, and telegram tasks import them unchanged (src/channels/ per SPEC section 14 layout)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/channels/contract.ts: Channel interface (notify(TaggedRequest) -> delivery_id; decision intake callback shape; health()); TaggedField<T> discriminated on kind: computed|claimed so untagged fields cannot be constructed; TaggedRequest built by a runtime-side tagger (src/channels/tagging.ts) from the log + resolution + budgets + attestation (computed) and envelope self-reports (claimed); manual actions carry full payload rendering material.
2. Batch semantics per B7: BatchPresentation type, assembleBatch refusing forbidden mixes, unit decisions carrying batch delivery id.
3. Shared conformance suite (src/channels/conformance.ts or tests helper) runnable against any Channel: tagging exhaustiveness, full-payload for manual, decision round-trip to log event via gate verbs, batch rules.
4. Opus subagent implements; fable reviews, gates from wiped install, finalizes, merges, pushes; then 23/24/26 parallel.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent; fable review accepted all four flagged decisions, two of which go to the human in the m-4 report: (1) B7 operationalization — "hides any full payload behind the fold of another" reduced to batch material properties: forbidden mix = more than one distinct payload_hash AND any member whose fullPayload is null or truncated; single-payload batches always assemblable; the rendering half checked by the conformance suite (every member payload text present and delineated); (2) batch_delivery_id rides in the note field as a machine-readable first line (decide() exposes exactly one caller payload field and the gate/schema are frozen for this task) — first-class payload field flagged as a follow-up; (3) fullPayload material is caller-supplied but hash-verified against the recorded binding (payload-mismatch otherwise), which is what makes it computed rather than claimed; (4) buildChannelRequest takes a log PATH not records, per Global invariant 1 — accepting an array would let callers hand in unverified input. TaggedField makes untagged data unrepresentable; DecisionOutcome deliberately excludes the raw token (returned runtime-side only). Conformance suite proven bidirectionally: green against a correct mock, red (assert.rejects with tight regexes) against a claimed-as-computed mock and a payload-dropping mock. Verified: 728/728, lint, typecheck.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
src/channels/{contract,tagging,batch,conformance}.ts: the plugin interface with exhaustive computed/claimed truth-labeling built runtime-side from verified logs, hash-verified payload material, B7 batch semantics with unit decisions, recordChannelDecision through the human-only gate, and a shared conformance suite proven to fail non-conforming channels. 21 tests. Verified: 728/728, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
