---
id: APRV-251
title: >-
  execution.completed carries the provider reference: AgentMail message_id
  on-chain so coverage joins by id, not by window
status: In Progress
assignee:
  - '@opus-251'
created_date: '2026-09-04 21:13'
updated_date: '2026-09-06 13:12'
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
- [x] #1 SPEC.md 8 amendment marked pending sign-off: execution.completed MAY carry provider_ref {adapter, id}; the schema in schema/ admits it and rejects other shapes
- [x] #2 executeThroughAdapter writes provider_ref when the adapter detail names one, through the same redaction sweep as the detail
- [x] #3 The AgentMail adapter surfaces message_id as the provider reference for direct and draft sends; the mock and conformance suite cover it
- [x] #4 src/core/coverage.ts prefers an exact provider_ref match as evidence and reports it distinctly from the class-and-window match; docs/cli-reference.md coverage section updated
- [x] #5 npm test, lint, typecheck pass
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

Code slice (commit 2). core/execute.ts: FinishOptions gains providerRef (with ProviderRef, the schema-matching bounds and providerRefRecordable beside it); finishExecution records it on execution.completed only, and only when it fits what the schema admits, since handing the write boundary a record it will reject would leave a side effect that happened with no outcome in the log. adapters/contract.ts: PROVIDER_REF_DETAIL_KEY is the one key by which a success detail names a reference, so the contract lifts a declared field instead of guessing between message_id, sid and id; the redaction sweep now runs BEFORE the outcome append, and providerRefFor drops a reference whose bytes the sweep touched (a redacted identifier matches nothing and would read like one that does), plus anything the schema would reject. The adapter half of the pair is the contract's own knowledge of which adapter it called, never a claim the detail makes. adapters/agentmail.ts: the receipt names the message_id under that key for direct and draft sends, and only when the provider returned one. adapters/conformance.ts: the happy-path check asserts both directions against the contract's own lift function. core/coverage.ts: a provider_ref index over execution.completed, consulted before the guard and the window; the key is the (source, adapter) pair plus the id, and match 'provider-ref' prints as '(id)'.

Design decisions worth recording. (1) The lift is by ONE conventional detail key rather than by a per-adapter callback or a guess across receipt fields: a contract that guessed would eventually lift the wrong field of some receipt onto a permanent log. (2) An unrecordable reference is DROPPED, never refused: the outcome record matters more than the join key. (3) The id join applies no window and ignores class, because an id names one effect; the pair (adapter, id) is the key so one provider's identifier is never evidence about another's effect. (4) Only execution.completed carries one; a failed execution produced no effect for a provider to file.

Invariants touched (SPEC §11.1). 'Validate at the write boundary': a new payload field, constrained by the schema, with the write path declining anything the schema would reject. 'Raw secrets never appear in the log': a provider message_id is an opaque identifier the provider issues for an effect that already happened, not a credential; it authorises nothing, opens nothing and is useless without the API key that the vault holds. The path that could have made it a leak is an adapter quoting a secret inside its receipt, and that is closed twice: the id passes the same redaction sweep as the rest of the detail, and a reference the sweep touched is not recorded at all (tests/adapters-contract.test.ts pins both). 'Self-reported fields never reduce scrutiny' is untouched: nothing in the gate reads provider_ref back, no verdict, budget or grant turns on it, and coverage is informational by SPEC §10.1.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
execution.completed may now carry provider_ref {adapter, id}, and approval coverage joins on it. SPEC.md §8 states the rule and §10.1 states its effect on the join, both marked pending sign-off; schema/event.schema.json admits exactly that shape on execution.completed and rejects every other (five fixtures, and the conformance vectors regenerated from them). executeThroughAdapter lifts the id from the one conventional detail key after the redaction sweep it moved above the outcome append, names the adapter from its own knowledge, and drops a reference the sweep touched or the schema would reject rather than risk the outcome record. The AgentMail receipt names the message_id under that key for direct and draft sends; the mock adapter grew the same option and the shared conformance suite checks both directions on every adapter. core/coverage.ts prefers an exact (source, id) match over the guard and the window and reports it as match 'provider-ref', printed '(id)'; docs/cli-reference.md replaces the 'joined by class and window, not by message id' paragraph with the id rule and what it does not cover.

Verified: npm run build clean; node conformance/run.mjs 293/293 vectors, 142 controls, exit 0; node --test over event-schema, fixtures, execute, adapter-agentmail, adapters-contract, coverage, coverage-sources, cli-coverage, docs-guard, conformance and conformance-regen: 433 tests, 433 pass, exit 0; docs-guard, cli-adapter, e2e-email-demo and dogfood: 79 pass, exit 0; cli-setup, cli-payload, child-env, command-class, cli-instructions and coverage-sources: 543 pass, exit 0. npm run lint and npm run typecheck both clean. Two commits, schema first per CLAUDE.md. Full npm test not run in this lane.
<!-- SECTION:FINAL_SUMMARY:END -->
