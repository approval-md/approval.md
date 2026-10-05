---
id: APRV-500
title: >-
  Reserve the policy delegation block (validated, inert) and the model reviewer
  identity
status: In Progress
assignee: []
created_date: '2026-10-05 23:20'
updated_date: '2026-10-05 23:21'
labels:
  - policy
  - schema
  - judge
dependencies:
  - APRV-499
priority: high
ordinal: 384000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter's 2026-10-05 23:03Z ruling (lanes CLAIMS, GRANT line) sets up the judge: one top-level policy block delegation: {model, classes, max_autonomy, daily_cap, escalate_on, advice, reviewers} that will later hold the model reviewer, the adviser and the delegated approver. Before Oct 11 the block is RESERVED ONLY: core 0.4.2 parses and validates it and does nothing with it. Design: agentvillage docs/design/judge.md sections 2 and 3 (PR #204, draft 0.1).

Why reserve now: the policy schema is closed, so a template carrying the key would fail closed on every older core; reserving it in 0.4.2 lets the grammar be refuted before it holds any power and makes switching on a value change rather than a new key. Why refuse non-off values: a core that accepted daily_cap: 10 and did nothing would be a setting the author believes is in force that the runtime silently ignores (the promise in the policy schema description). So any non-off value fails the load closed with its own code, delegation-not-supported, and a fully-off block loads and changes nothing.

Also reserved, inert: the model:<name>@<version> identity kind (admitted by the identity parser for policy reviewers only; grants, attestations, reviews and channel decisions still require human:) and verdict_source: model on audit.reviewed (registered as reserved, refused at the write boundary, never produced by this release). Stacked on APRV-499 (#623) because both edit the policy schema. Target 0.4.2 with APRV-499.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 policy.schema.json admits an optional top-level delegation block with keys model (null or model:<name>@<semver>), classes (unique concrete class names), max_autonomy (manual|supervised-live|supervised-retro), daily_cap (integer 0..1000), escalate_on (unique subset of deny, low_confidence, irreversible, unknown_class), advice (boolean), reviewers (unique human:<approver id> or model:<name>@<semver>); unknown keys and wrong types are schema-invalid
- [ ] #2 Load-time grammar rules 1-7 of the design (classes are exact keys of classes; no human-only or autonomous class; the max_autonomy pin; escalate_on floors when daily_cap > 0; a model reviewer equals model and a human reviewer names an approver; no advice, cap or model reviewer without a model) fail the policy closed as schema-invalid with a distinct keyword each
- [ ] #3 Any block not in the exact off form (model null or absent, classes empty, max_autonomy manual, daily_cap 0, escalate_on empty, advice false, reviewers empty) fails the load with the new code delegation-not-supported, naming every non-off key; every class then resolves manual
- [ ] #4 A fully-off block (including delegation: {}) loads, and every class of every valid policy-md fixture, the scaffold and quickstart templates, the agent-village example and the repo's own policy resolves identically with and without it
- [ ] #5 approval policy check shows the declared block; policy diff reports delegation.* paths and the delegation-not-supported failure
- [ ] #6 A model:<name>@<version> identity parses for the reviewer role only; attest, grant, review and channel decisions by a model: actor are refused actor-not-human; verdict_source model is registered as reserved and refused at the event write boundary
- [ ] #7 Conformance regenerated with the documented command: new schema fixtures and policy-resolution vectors; the diff is read line by line and any change beyond the new entries is reported
- [ ] #8 Docs (cli-reference delegation section, loadFailure code), CHANGELOG Unreleased, and a SPEC section 5 and 10.3 amendment proposal in the task notes; SPEC.md itself untouched
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. schema/policy.schema.json: top-level delegation object (closed),  modelIdentity and delegationReviewer; key descriptions cite APRV-500 and say reserved/inert.
2. src/core/identity.ts (new): parseIdentity(text, role) for human:<id> and model:<name>@<semver>; model admitted only for role reviewer. MODEL_IDENTITY_PATTERN shared with the schema pattern.
3. src/core/delegation.ts (new): types, DELEGATION_OFF, delegationErrors(policy) for design rules 1-7 (keywords delegation-class-undeclared, delegation-class-level, delegation-max-autonomy-pin, delegation-escalation-floor, delegation-reviewer-model, delegation-reviewer-unknown, delegation-model-required), delegationEngaged(block) listing non-off keys.
4. src/core/policy-load.ts: Policy.delegation; new PolicyLoadErrorCode delegation-not-supported; grammar errors -> schema-invalid after the tools check; the off-form check is the last gate before returning the load.
5. policy-explain: one decision-path line when the block is declared (off). policy-diff needs nothing (vocabulary is read from the schema); a test proves it.
6. audit.ts: VERDICT_SOURCES and RESERVED_VERDICT_SOURCES; event.schema.json descriptions register model as reserved, write boundary unchanged (const explicit, actor ^human:).
7. Fixtures: policy valid delegation-off, delegation-grammar-full; invalid delegation-* grammar; event invalid audit-reviewed-verdict-source-model, audit-reviewed-model-actor. Regen policy-resolution vectors (off loads; non-off -> delegation-not-supported; pin -> schema-invalid). npm run build && node scripts/regen-conformance-vectors.mjs; bump versions; read the diff.
8. tests/policy-delegation.test.ts. Targeted runs only.
9. Docs: cli-reference section + loadFailure code; CHANGELOG Unreleased; SPEC proposal in notes.
<!-- SECTION:PLAN:END -->
