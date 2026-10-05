---
id: APRV-500
title: >-
  Reserve the policy delegation block (validated, inert) and the model reviewer
  identity
status: In Progress
assignee: []
created_date: '2026-10-05 23:20'
updated_date: '2026-10-05 23:33'
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
- [x] #1 policy.schema.json admits an optional top-level delegation block with keys model (null or model:<name>@<semver>), classes (unique concrete class names), max_autonomy (manual|supervised-live|supervised-retro), daily_cap (integer 0..1000), escalate_on (unique subset of deny, low_confidence, irreversible, unknown_class), advice (boolean), reviewers (unique human:<approver id> or model:<name>@<semver>); unknown keys and wrong types are schema-invalid
- [x] #2 Load-time grammar rules 1-7 of the design (classes are exact keys of classes; no human-only or autonomous class; the max_autonomy pin; escalate_on floors when daily_cap > 0; a model reviewer equals model and a human reviewer names an approver; no advice, cap or model reviewer without a model) fail the policy closed as schema-invalid with a distinct keyword each
- [x] #3 Any block not in the exact off form (model null or absent, classes empty, max_autonomy manual, daily_cap 0, escalate_on empty, advice false, reviewers empty) fails the load with the new code delegation-not-supported, naming every non-off key; every class then resolves manual
- [x] #4 A fully-off block (including delegation: {}) loads, and every class of every valid policy-md fixture, the scaffold and quickstart templates, the agent-village example and the repo's own policy resolves identically with and without it
- [x] #5 approval policy check shows the declared block; policy diff reports delegation.* paths and the delegation-not-supported failure
- [x] #6 A model:<name>@<version> identity parses for the reviewer role only; attest, grant, review and channel decisions by a model: actor are refused actor-not-human; verdict_source model is registered as reserved and refused at the event write boundary
- [x] #7 Conformance regenerated with the documented command: new schema fixtures and policy-resolution vectors; the diff is read line by line and any change beyond the new entries is reported
- [x] #8 Docs (cli-reference delegation section, loadFailure code), CHANGELOG Unreleased, and a SPEC section 5 and 10.3 amendment proposal in the task notes; SPEC.md itself untouched
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Done

- Schema: optional top-level `delegation` (closed object) plus `$defs.modelIdentity` and `$defs.delegationReviewer` in `schema/policy.schema.json`.
- `src/core/delegation.ts` (new): `delegationErrors` (design rules 1-7, each a distinct keyword, failing `schema-invalid`), `delegationEngaged` (rule 8), `DELEGATION_OFF`, `describeDelegation`.
- `src/core/policy-load.ts`: `Policy.delegation`; new `PolicyLoadErrorCode` `delegation-not-supported`. Grammar errors are checked right after the APRV-499 tools check; the reservation is the last gate, after the routing floor, so it only refuses a file that is otherwise wholly valid.
- `src/core/identity.ts` (new): `parseIdentity(text, role)`. `model:<name>@<semver>` is admitted for role `reviewer` only. No enforcement path was rewired to it: every human-only verb keeps its own `^human:.+`, so a `model:` actor is refused `actor-not-human` everywhere (tested for grant, reject, revoke, channel decision, attest, audit review).
- `src/core/audit.ts`: `VERDICT_SOURCES = ["explicit"]`, `RESERVED_VERDICT_SOURCES = ["model"]`. `event.schema.json`: descriptions of `actor` and `audit.reviewed verdict_source` register `model:` and `model` as reserved; the patterns and the `const` are unchanged, so the write boundary refuses both (two new invalid event fixtures pin it).
- `policy check` adds one decision-path line when the policy declares an (off) block. `policy diff` needed no code: its vocabulary is read from the schema, and a test pins that it shows `delegation.*` paths and the `delegation-not-supported` failure.
- Conformance regenerated with `npm run build && node scripts/regen-conformance-vectors.mjs`: policy-resolution 4.0.0 -> 4.1.0 (+6 vectors), schema-validation 3.2.0 -> 3.3.0 (+21 fixture vectors). Diff read line by line: the only removed lines are the two version strings, the two counts, the policy-resolution algorithm line and the two manifest hashes; every other hunk is a pure insertion of the new vectors. No existing expectation moved; no other suite changed.
- Docs: `docs/cli-reference.md` "Delegation block, reserved in 0.4.2; no behaviour" under policy check, loadFailure code list; `docs/README-extended.md` group row and dictionary rows for `delegation` and its seven keys; CHANGELOG Unreleased "Policy".

## Decisions (for the refuter and Carter)

1. Off form is STRICT: model null/absent, classes [], max_autonomy manual, daily_cap 0, escalate_on [], advice false, reviewers []. The brief listed four keys; the design's rule 8 listed four different ones. Refusing every non-default value is the reading under which no key can hold a value nobody enforces (a human reviewer or a non-empty escalate_on would otherwise be accepted and ignored).
2. Key grammar follows the design doc §2.2, where it differed from the brief: `model` is `model:<name>@<semver>` (the brief said provider/name@version; that form is refused by the schema, fixture `delegation-model-provider-form`), `max_autonomy` is manual|supervised-live|supervised-retro (the brief said autonomous|supervised|manual; `autonomous` is pointless under rule 2 and `supervised` is the deprecated alias), `daily_cap` is 0..1000 (brief: >= 0). Narrower now is cheap to widen later; the reverse is a breaking change.
3. Order: schema -> rules 1-7 (`schema-invalid`) -> rule 8 (`delegation-not-supported`). So `advice: true` with no model is `schema-invalid` (rule 7), and with a model is `delegation-not-supported`.
4. `delegation:` with no value (YAML null) is `schema-invalid`, as for every other object-typed block.
5. The pin compares the class key's DECLARED autonomy (the exact key always wins resolution), using the resolver's own STRICTNESS table; `supervised` reads as `supervised-retro`.
6. The event schema's generic actor pattern was NOT widened to admit `model:`: widening it would let a `model:` actor validate on every event type that does not narrow its actor. Reservation is by registration (descriptions, TS constant), and refusal stays at the write boundary.

## Known, not fixed here

- `tests/docs-guard.test.ts` "dictionary has a row for every policy key" fails on the base branch (PR #623, APRV-499): no rows for `tools` and `defaults.unmapped_tool`. This branch adds the `delegation` rows; the two APRV-499 rows belong to that lane.

## SPEC amendment PROPOSAL (Carter attests; SPEC.md untouched)

§5.2, new bullet after "Agent-requestable classes":

**The `delegation` block is reserved.** A policy MAY carry one top-level `delegation` block with the keys `model` (null, or a judge identity `model:<name>@<major>.<minor>.<patch>`), `classes` (exact keys of `classes`), `max_autonomy` (`manual`, `supervised-live` or `supervised-retro`; absent means `manual`), `daily_cap` (an integer from 0 to 1000; absent means 0), `escalate_on` (a subset of `deny`, `low_confidence`, `irreversible`, `unknown_class`), `advice` (boolean; absent means false) and `reviewers` (`human:<approver id>` or `model:<name>@<version>`). Implementations MUST validate the block's relationships to the rest of the file and fail the policy closed when one does not hold: every `classes` entry is an exact key of `classes` whose declared autonomy is neither `human-only` nor `autonomous`; every listed class declares an autonomy at least as strict as `max_autonomy` (a pin between the block and the class rows, so loosening a delegated row without rewriting the block fails the load); a `daily_cap` above 0 requires `escalate_on` to contain `irreversible` and `unknown_class`; a `model:` reviewer equals `model`; a `human:` reviewer names a key of `approvers`; and `advice: true`, a cap above 0 or a `model:` reviewer requires `model`. An implementation that does not implement delegation MUST load the block only when every key is absent or at its off value (`model: null`, `classes: []`, `max_autonomy: manual`, `daily_cap: 0`, `escalate_on: []`, `advice: false`, `reviewers: []`), where it changes nothing, and MUST refuse any other value with the load code `delegation-not-supported`, so the policy resolves every class `manual`. A setting its author believes is in force is never silently ignored. Delegation never changes a class's autonomy; it changes who may supply a decision or a review. (Amended APRV-500, pending sign-off.)

§10.3, a new paragraph after "Review delivered through a channel (amended APRV-299)". SPEC.md does not yet name `verdict_source` (PR #614 F5 added it to the event schema only), so the first sentence also states it:

Every `audit.reviewed` written records how its verdict was given in `payload.verdict_source`: `explicit`, the reviewer said it. A second value, `model`, is RESERVED for a review given by a judge identity `model:<name>@<version>` that the attested policy's `delegation.reviewers` admits. No implementation that refuses `delegation` writes it, and the write boundary refuses it together with any `model:` actor. A reader that meets `model` MUST NOT count the review as a human approval, and MAY ignore it. The identity kind `model:` is reserved on the same terms: it is admitted in `delegation.reviewers` only, and every human-only verb (grant, reject, revoke, attest, review, checkpoint and every channel decision) continues to require `human:`. (Amended APRV-500, pending sign-off.)

§11.2: no gate refusal code is added. `delegation-not-supported` is a policy load code (beside `schema-invalid`, `protected-route-floor`, `sender-ambiguous`); if the registry is to list load codes, add it there with the meaning above.

## Remaining

- Carter: attest the SPEC proposal above (or amend it).
- Refuter (orchestrator dispatches): see the noticed-and-accepted list in the PR body.
- Template (R2) carries the block only with a fleet-wide 0.4.2 pin.
<!-- SECTION:NOTES:END -->
