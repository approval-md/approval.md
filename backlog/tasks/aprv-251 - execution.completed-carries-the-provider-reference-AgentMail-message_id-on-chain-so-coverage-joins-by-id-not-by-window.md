---
id: APRV-251
title: >-
  execution.completed carries the provider reference: AgentMail message_id
  on-chain so coverage joins by id, not by window
status: In Progress
assignee:
  - '@opus-251'
created_date: '2026-09-04 21:13'
updated_date: '2026-09-06 12:57'
labels: []
dependencies:
  - APRV-245
references:
  - src/adapters/agentmail.ts
  - src/core/coverage.ts
priority: medium
ordinal: 196000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-245 joins AgentMail sent messages to verified records by class and time window, because the message_id the adapter receives on send lands only in the CLI result (the receipt detail), never in the execution.completed record, which carries exit_code alone. An id-level join is stronger: it names the exact message a grant produced and makes a same-class send inside the window distinguishable from the gated one. This is a schema change (SPEC 8 event payloads, schema/), so it is its own task: an optional `provider_ref` object on execution.completed (adapter name plus an opaque id), written by the adapter contract from the act detail, validated at the write boundary, redacted like the rest of the detail, and read by the coverage join as exact evidence ahead of the window rule. No existing record changes; readers treat absence as the pre-amendment behaviour.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 SPEC.md 8 amendment marked pending sign-off: execution.completed MAY carry provider_ref {adapter, id}; the schema in schema/ admits it and rejects other shapes
- [ ] #2 executeThroughAdapter writes provider_ref when the adapter detail names one, through the same redaction sweep as the detail
- [ ] #3 The AgentMail adapter surfaces message_id as the provider reference for direct and draft sends; the mock and conformance suite cover it
- [ ] #4 src/core/coverage.ts prefers an exact provider_ref match as evidence and reports it distinctly from the class-and-window match; docs/cli-reference.md coverage section updated
- [ ] #5 npm test, lint, typecheck pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. SPEC.md §8: new bullet after 'Enum versioning' stating execution.completed MAY carry payload.provider_ref {adapter, id}, both non-empty printable-ASCII strings and nothing else, written by the runtime (adapter name from the registered adapter, id lifted from the adapter's own success detail), additive so a record without it is the pre-amendment record; marked '(Amended APRV-251, pending sign-off.)'.
2. schema/event.schema.json: an execution.completed-only conditional constraining payload.provider_ref to {adapter, id} with additionalProperties:false, both required, pattern ^[!-~]{1,N}$ (adapter 64, id 256). Fixtures: valid/execution-completed-provider-ref.json; invalid/execution-completed-provider-ref-extra-field.json, -empty-id.json, -missing-adapter.json, -non-string-id.json. Then npm run build, node scripts/regen-conformance-vectors.mjs, node conformance/run.mjs (schema fixtures feed the vectors). This is the first commit, on its own per CLAUDE.md.
3. src/core/execute.ts: FinishOptions gains providerRef?: {adapter, id}, recorded on execution.completed only, mirroring APRV-234's note — a report, never read back by the gate.
4. src/adapters/contract.ts: export PROVIDER_REF_DETAIL_KEY = 'provider_ref' as the convention by which an adapter's success detail NAMES a reference. In executeThroughAdapter, move the redaction sweep above the outcome append so the lifted id passes through the same sweep as the detail; lift only when the redacted value is byte-identical to the raw one (a redacted id is not an id and must not be written as one), is non-empty and fits the schema's shape; adapter name is the contract's own knowledge, never the detail's. Surface provider_ref on the ok result too.
5. src/adapters/agentmail.ts: receipt() adds provider_ref alongside message_id for direct and draft sends, when the provider returned a usable id. Update the module note that says the id reaches only the CLI result.
6. src/adapters/conformance.ts: happy-path check asserts the lifted reference — a detail naming one puts exactly {adapter: <this adapter>, id} on the completed record, a detail naming none puts nothing.
7. src/core/coverage.ts: a provider_ref index over execution.completed records; an effect whose (source, id) matches is evidence with match 'provider-ref', checked before the guard and the class-and-window rule, with no window test (an exact id names the exact effect). CoverageMatch gains 'provider-ref'; cli/coverage.ts evidenceText qualifies it.
8. docs/cli-reference.md coverage section: replace the 'join is by class and window, not by message id' paragraph with the id-level rule and what it does not do.
9. Tests: event-schema/fixtures (fixtures above), execute (providerRef on completed only), adapters-contract (lift, drop on redaction hit, drop on bad shape), adapter-agentmail (direct and draft receipts + record), coverage (id match beats window, cross-source id does not match), docs-guard/cli-coverage as needed. Second commit.
10. Verify: build, event-schema, fixtures, conformance, execute, adapter-agentmail, adapters-contract, coverage, docs-guard, cli-coverage, lint, typecheck.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Schema slice (commit 1). SPEC.md §8 gains a bullet, marked (Amended APRV-251, pending sign-off.): execution.completed MAY carry payload.provider_ref, an object of exactly two non-empty printable strings, adapter and id, both written by the runtime at the write boundary; it authorizes nothing, is bounded so an identifier cannot become a message body, and its absence is the pre-amendment record. schema/event.schema.json gains an execution.completed-only conditional constraining that shape with additionalProperties:false and printable-ASCII patterns (adapter <=64, id <=256). Five fixtures: one valid, four invalid (extra member, missing adapter, empty id, non-string id). Conformance vectors regenerated from the fixtures (schema-validation gains 5 vectors, 4 of them negative controls); conformance/run.mjs 293/293, exit 0. Invariants touched: 'validate at the write boundary' (the new field is constrained by the schema every append passes, and the closed object is what keeps the constraint meaningful) and 'raw secrets never appear in the log' (the id is an opaque provider identifier and never a credential; §11.1 invariant 4 is untouched because nothing reads the field back).
<!-- SECTION:NOTES:END -->
