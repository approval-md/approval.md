---
id: APRV-237
title: >-
  Human-to-agent signals: SPEC amendment, values schema, reaction enum, and the
  guidance-never-reaches-enforcement invariant
status: Done
assignee:
  - '@fable'
created_date: '2026-09-02 20:43'
updated_date: '2026-09-04 22:36'
labels:
  - welfare
  - spec
  - schema
dependencies: []
ordinal: 192000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
approval.md carries control signals in one direction only (gate, deny, sample, reconcile); the journal (APRV-195) lets the agent speak to the human, and nothing lets the human say what they value or what they thought of work the policy allowed. This task establishes the vocabulary and the boundary before any surface exists: an optional second fenced block `yaml approval-values` in APPROVAL.md, a graded `reaction` field on `audit.reviewed` and `approval.granted`, and SPEC §11.1 invariant 10 (guidance never reaches enforcement), pinned by a test that later tasks land against. Vocabulary: `dislike`/`like`/`love` (standing lists) and `disliked`/`indifferent`/`liked`/`loved` (events); absence is never `indifferent`; extremes carry a note. Proposed by Carter from a model-welfare and alignment viewpoint (2026-09-02).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 SPEC §5 amended: exactly one policy block and at most one optional `yaml approval-values` block; other fences and prose ignored; a values-block failure never makes the policy unloadable; carries an (Amended APRV-<this>, pending sign-off) marker
- [x] #2 SPEC §5.3 "The values block" added: vocabulary, key set with per-key rationale (version, love, like, dislike, wants, responds), absence-is-a-declaration with the exact sentence "the operator has declared no values here.", labelling duty on agent-facing surfaces, and the whole-file attestation consequence
- [x] #3 SPEC §5.2 review prose: `reaction` is additive to audit.reviewed and approval.granted; `verdict` stays the enforcement field; denied with liked/loved refuses `reaction-conflicts-verdict`; loved/disliked without a note refuses `note-required`
- [x] #4 SPEC §11.1 invariant 10 added ("Guidance never reaches enforcement"), citing tests/values-inert.test.ts
- [x] #5 SPEC §11.2 gains an audit_refusal_codes table covering every member of AUDIT_REFUSAL_CODES plus reaction-conflicts-verdict; the note-required row states both triggers
- [x] #6 SPEC §10.1 CLI block lists `approval values` and `approval feedback`
- [x] #7 schema/values.schema.json exists: additionalProperties false, required version const 1, love/like/dislike/wants as unique string arrays (max 20, item 1..200), responds string max 500; descriptions cite SPEC and record rejected keys
- [x] #8 schema/fixtures/values/valid has at least 3 documents and schema/fixtures/values/invalid at least 4; tests/fixtures.test.ts passes with no edits
- [x] #9 schema/event.schema.json constrains payload.reaction to the four-word enum on audit.reviewed and approval.granted; tests/event-schema.test.ts covers accepted words, a rejected fifth word, and a review with no reaction
- [x] #10 node scripts/regen-conformance-vectors.mjs run; conformance vectors and manifest updated; node conformance/run.mjs and tests/conformance.test.ts pass
- [x] #11 tests/values-inert.test.ts exists with the static guard (literal approval-values only in src/core/values.ts; reaction absent from enforcement modules) and passes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read SPEC §5, §5.2 audit prose, §10.1, §11.1-11.2 and policy.schema.json/event.schema.json for the house style.
2. Write schema/values.schema.json (closed, version const 1, love/like/dislike/wants arrays, responds string) with fixtures under schema/fixtures/values/{valid,invalid}.
3. Add payload.reaction enum to audit.reviewed and approval.granted in event.schema.json; extend tests/event-schema.test.ts.
4. Amend SPEC: §5 second optional block, new §5.3, §5.2 reaction prose, §10.1 CLI lines, §11.1 invariant 10, §11.2 audit_refusal_codes table (closing an existing gap) and the reaction-note-required gate row.
5. Regenerate conformance vectors and manifest; run conformance.
6. Write tests/values-inert.test.ts static guard (approval-values literal only in src/core/values.ts; reaction absent from enforcement modules), green by construction until APRV-238/239 land.
7. npm test full tier, lint, typecheck.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Schema half landed via an Opus subagent: schema/values.schema.json (closed; version integer const 1; love/like/dislike/wants share $defs/valueList with uniqueItems, maxItems 20, item 1..200; responds string max 500; rejected keys recorded in the description), fixtures under schema/fixtures/values/{valid,invalid} (3 valid, 6 invalid), payload.reaction enum on audit.reviewed and a new approval.granted conditional in event.schema.json, plus a third conditional making a note (minLength 1) required when reaction is loved or disliked, so the extremes-carry-reasons rule is true at the write boundary regardless of which surface wrote the record. tests/values-inert.test.ts is the static guard: the literal approval-values may appear only in src/core/values.ts and src/core/md-fence.ts, and the identifier reaction appears in none of ten enforcement modules; the behavioural-equivalence halves are named for APRV-238/239. Conformance vectors regenerated (schema-validation 134 -> 153): 13 are the new fixtures, the other 6 are the APRV-214 gate fixtures committed without a regen, which is the drift APRV-231 filed; it is swept in here. The regen script names schemas explicitly, so 'values' was added to its list. SPEC amendments written by fable: §5 opening, §5.2 reactions bullet, new §5.3, §10.1 CLI lines, §11.1 invariant 6 (audit union pinned) and new invariant 10, §11.2 audit_refusal_codes table (closing a pre-existing gap) and the reaction-note-required gate row. No test parses the §11.2 tables, so the two forward rows for APRV-239's codes are safe.

Validation: full npm test 3067/3068 (1 skipped) on the APRV-238 tree that includes this task; targeted event-schema, fixtures, values-inert and conformance suites green; node conformance/run.mjs green after the merge of origin/main (schema-validation now 148 vectors: main had meanwhile regenerated for APRV-231's drift, so the sweep-in here reduced to the 13 new fixtures). SPEC amendments committed separately (6b09ad1) because the SPEC.md commit sampled live on the policy.edit gate.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Established the human-to-agent vocabulary and boundary: SPEC §5 admits one optional yaml approval-values block, new §5.3 defines it, §5.2 gains graded reactions, §11.1 invariant 10 (guidance never reaches enforcement) and its audit-union pin, §11.2 gains the audit_refusal_codes table. Shipped schema/values.schema.json with fixtures, payload.reaction on audit.reviewed and approval.granted with a write-boundary note rule for the extremes, and tests/values-inert.test.ts as the static half of the invariant's pin. Verified by the targeted suites, node conformance/run.mjs, and a full npm test (3067/3068, one skip) on the tree that includes it.
<!-- SECTION:FINAL_SUMMARY:END -->
