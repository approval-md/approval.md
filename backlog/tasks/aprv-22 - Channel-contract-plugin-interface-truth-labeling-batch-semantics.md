---
id: APRV-22
title: 'Channel contract: plugin interface, truth-labeling, batch semantics'
status: To Do
assignee: []
created_date: '2026-08-05 10:50'
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
- [ ] #1 A Channel interface (notify, decision intake, health) is defined with typed request/decision shapes; decisions flow only into log events through the existing gate verbs, and channels hold no state (SPEC 10.3), documented in the contract
- [ ] #2 Every field handed to a channel is pre-tagged computed or claimed by the runtime; the tagging is exhaustive (an untagged field cannot be constructed without a type error) and manual actions carry the full payload or its faithful rendering distinct from agent summaries per amended section 10.4
- [ ] #3 A shared conformance test suite, runnable against any channel implementation, asserts: no untagged or mis-tagged rendering, full-payload display for manual actions, decision round-trip to a log event, and the B7 batch rules (unit decisions with batch delivery id; forbidden-mix refusal)
- [ ] #4 Batch semantics per B7 are modeled in the contract with tests, independent of any concrete channel
- [ ] #5 Contract types and the conformance suite live so that cli, web, and telegram tasks import them unchanged (src/channels/ per SPEC section 14 layout)
<!-- AC:END -->
