---
id: APRV-447
title: execution.started carries policy_sha256 for policy-authorized starts
status: In Progress
assignee:
  - '@claude-c7'
created_date: '2026-10-03 03:49'
updated_date: '2026-10-04 09:59'
labels:
  - schema
  - gate
  - agent-village
dependencies: []
references:
  - private/agentvillage-integration/06-gap-register.md
priority: medium
ordinal: 335000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A harness execution record for an autonomous or supervised class carries class, payload_hash, execution harness and grant_origin, and no policy hash; only approval.requested and approval.granted may carry policy_sha256 today (schema/event.schema.json). A manual start can recover the policy in force through grant_seq; a policy-authorized start cannot, and a reader must reconstruct it from the latest policy.updated before that seq. The Agent Village follower (agentvillage-data docs/spec-addenda.md section 7.7, ruling 4) therefore cannot set policy_version on any action.* event and the research condition bounded_agent_led is unreachable for every co-located tenant, which on day one is every tool call (the whole recorder layer resolves autonomous). Stamp the attested policy hash the gate resolved against onto execution.started at the write boundary for every harness path (hook, propose/start), additive and optional in the schema, covered by the record hash, never a caller parameter, never an input to a verdict. Context: private/agentvillage-integration/06-gap-register.md G9.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 execution.started written by startHarnessExecution and consumeHarnessGrant carries policy_sha256 equal to the attested hash the gate resolved the class against, stamped by the runtime and ignored if supplied by a caller, proven by tests on both paths
- [x] #2 schema/event.schema.json admits policy_sha256 on execution.started as optional; every historical record validates unchanged; conformance schema-validation vectors regenerated
- [x] #3 SPEC section 8 record-fields hunk proposed in the implementation notes as pending sign-off, not applied
- [ ] #4 docs/README-extended.md names the field and the agentvillage-data follower mapping note is updated or a pointer filed there
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. core/gate.ts: stamp payload.policy_sha256 = attested.sha256 (requireAttestation over the single policy read the attempt already resolved the class against) on the execution.started built by attemptHarnessStart (startHarnessExecution: hook autonomous/supervised, propose/start policy path) and attemptHarnessConsume (consumeHarnessGrant: hook grant spend and carryover, propose/start grant path). Built from runtime-held values only; no input or option field carries it.
2. schema/event.schema.json: new allOf block constraining payload.policy_sha256 on execution.started to the 64-hex shape, optional and additive. Fixtures: one valid (harness start carrying it), one invalid (truncated digest). Regenerate conformance vectors; schema-validation 2.8.0 -> 2.9.0 (minor, collision rule checked against origin/main).
3. Tests (tests/execution-policy-stamp.test.ts): both core write paths stamp the hash equal to the policy.updated sha256 at the seq approval status reports; caller-supplied values (input/options extras, a payload field) ignored; re-attest changes the next start's stamp; hook route (autonomous + supervised) and propose/start (policy + grant) carry it; a record without the field validates; no verdict reads the field.
4. docs/README-extended.md names the field; CHANGELOG Unreleased entry.
5. Implementation notes: invariants touched, SPEC section 8 amendment text for APRV-454 batch, agentvillage-data follower contract note.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
What was done. src/core/gate.ts: attemptHarnessStart (startHarnessExecution) and attemptHarnessConsume (consumeHarnessGrant) now build execution.started with payload.policy_sha256 = attested.sha256, through one helper (harnessStartPolicyStamp). attested is the result of requireAttestation over the single policy read each attempt already makes (APRV-142), the same bytes the class was resolved from, so the stamp is the attested policy the verdict was computed under. Every harness surface reaches one of these two functions: the hook route (src/cli/hook.ts, and approval serve's hook route through src/serve/hook-worker.ts -> commandHook), autonomous and supervised starts, grant spends and carryover, and approval start for proposals (startProposed -> consumeHarnessGrant on the grant path, startHarnessExecution on the policy path, where proposalPolicyStartRefusal runs inside the same attempt). Granted (manual) starts are stamped too, by the same code path; on that path the stamp equals the grant's own pin, because a spend under a different attested policy is refused policy-drift before the payload is built.

Not stamped (out of scope, no harness marker): approval run / core/execute.ts starts, the adapter contract's starts, and the codex workspace broker. A follow-up can extend the same helper if the follower needs policy_version on those.

Schema: schema/event.schema.json gains one allOf block constraining payload.policy_sha256 on execution.started to ^[a-f0-9]{64}$, optional and additive. Fixtures: valid/execution-started-policy-sha256.json, invalid/execution-started-truncated-policy-sha256.json. Conformance regenerated with scripts/regen-conformance-vectors.mjs: schema-validation 2.8.0 -> 2.9.0 (minor, 215 -> 217 vectors, no expectation moved; origin/main is also at 2.8.0, so no collision at the time of writing; if another branch lands a 2.9.0 first, the merge takes one minor above both per conformance/README.md). Historical records: approval log verify over this repository's committed log (79713 records) with the new schema reports clean.

Decision: approval status reports the attestation seq, not a hash. The tests resolve the status-reported attestation to its policy.updated record and compare that record's sha256 (also cross-checked against policyBytesHash of the file on disk). No status output change was made.

Invariants touched (SPEC section 11.1). Invariant 1 (enforcement paths read only verified records): the stamp is read from the attestation check the gate already performed over the verified records and the one policy read, never from the envelope, the request input, the options or the action payload; neither HarnessStartInput nor ConsumeHarnessOptions has a field for it, and tests pass a forged value through all three routes and through a proposal payload and see it ignored. Invariant 4 (self-reported fields never reduce scrutiny): untouched, the field is runtime-written and nothing that decides reads it; core/state.ts reads policy_sha256 from approval.requested only and grantedPolicyHash reads it from approval.granted only. Invariant 8 (a verdict whose event cannot be appended is a refusal): unchanged, the stamp rides the same append and a schema refusal of it would be append-failed. Invariant 2 (no caller timestamps) and invariant 3 (no raw secrets): unaffected, the value is a public digest already on approval.requested.

Cross-repo contract: the agentvillage-data follower (DATA-212 Lane C, D3 follower half, R21) reads payload.policy_sha256 on execution.started and maps it to policy_version on action.* events. The field NAME policy_sha256 is therefore a contract with that repository; renaming it is a breaking change for the follower. No pointer was filed in agentvillage-data from this lane (another repository); this note is the pointer, and the overnight plan in private/handover/lanes/CLAIMS.md already directs the follower to build against this exact name.

SPEC amendment text (apply by hand), for the APRV-454 batch, as a new bullet in section 8 after 'The provider reference.':

- **The policy a harness start was resolved under.** An `execution.started` that a harness path records (`execution: "harness"`) carries `payload.policy_sha256`, the SHA-256 of the attested policy bytes the gate resolved the action's class against when it recorded the start: the value `approval.requested` and `approval.granted` carry (section 5.2), taken from the same attestation check and the same single read of the policy file that the class resolution used. The runtime writes it at the write boundary, as it writes `ts`, and no caller parameter, option or field of the action's payload supplies it; a value of that name arriving by any of those routes is ignored. A start under a policy that is not attested, or whose bytes changed since attestation, is refused before anything is appended, so no stamp names bytes nobody attested. A policy-authorized start (autonomous, supervised, an unselected supervised-live draw) has no other record naming its policy, and the field lets a reader of the start alone say which rules authorized it. A granted start, which could already recover its policy through `grant_seq`, carries it from the same code path, and there it equals the grant's own pin, since a spend under a different attested policy is refused `policy-drift`. It authorizes nothing: no verdict, budget, draw, loop floor or refusal reads it back, so section 11.1 invariant 4 is untouched. It is covered by the record hash like every other payload field. It is OPTIONAL and additive: every record written before the field existed still validates and still verifies, a start written by a non-harness path (`approval run`, an adapter's `act`) records none at v0.1, and a reader treats absence as the pre-amendment behaviour, reconstructing the policy from the latest `policy.updated` before the record's seq. (Amended APRV-447, pending sign-off.)

Branch note: the lane was cut from origin/carter/data-212-propose (PR #569), which predates #581, so this task file was brought into the branch from origin/main with git checkout origin/main -- <file>; merging main later shows an add/add on this file, resolved by keeping the lane's version.

Validation (local, 2026-10-04): npm run build exit 0; npm run typecheck exit 0; npm run lint exit 0; tests/execution-policy-stamp.test.ts 10/10 exit 0; targeted run (execution-policy-stamp gate execute cli-propose propose-recheck propose-refutation serve-propose evidence-append human-only conformance conformance-regen event-schema fixtures concurrency audit budgets clock state) 628/628 exit 0; full npm test exit 1 with 5571 tests, 5569 pass, 1 skip, 1 fail: tests/cli-hook-hermes-rules 'SIGTERM mid-wait still ends in the block directive at exit 2' (child exit null under load; the file and behaviour come from #569 and this diff does not touch the hermes path), rerun alone 17/17 exit 0. approval log verify over the committed 79713-record log: clean. AC 4: docs/README-extended.md names the field (new subsection 'Which policy authorized a start'); the agentvillage-data side has no pointer filed from this lane (other repository), so AC 4 stays open for the orchestrator to tick once the follower note lands.
<!-- SECTION:NOTES:END -->
