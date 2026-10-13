---
id: APRV-483
title: >-
  reviewSample checks the reviewer against the class's approvers roster,
  including the CLI --as path, the way grants do
status: Done
assignee: []
created_date: '2026-10-05 06:51'
updated_date: '2026-10-08 01:14'
labels:
  - agentvillage
dependencies: []
priority: high
ordinal: 368000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Supervised-retro core piece (in scope for Oct 11). Grants check the sender against the class's approvers roster; reviewSample does not, and the CLI --as path can name anyone. A review by a non-roster reviewer must not count.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A non-roster reviewer is refused with a named code, on every channel and on the CLI --as path
- [x] #2 A test covers roster, non-roster and --as
- [x] #3 Docs state the roster rule for reviews
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Commits 950cccef, eda31f99.

Done:
- reviewSample resolves the sample's class. It comes from the registration, falling back to the runtime-written sample's `class`. The class is resolved under the policy, and when the winning rule names `approvers`, a reviewer off the roster is refused `actor-not-approver`. The comparison is gate's own `namesApprover`, now exported.
- The check lives in core, so the CLI `--as` path and sender-mapped Telegram taps are held to the same list.
- A rule with no roster restricts nobody, the same as for grants.
- Docs: audit review section and Telegram section. Help text updated.

Security review findings (coordinator relay, src/core/audit.ts):

(1) "authorization-bypass": CONFIRMED, FIXED in eda31f99.
- 950cccef read the roster from whatever policy the caller pointed at. `approval audit review --policy <any file> --as human:<off-roster>` could therefore record.
- Now the roster is parsed only from the bytes of the file a grant reads (gate `policyPathOf`, exported), and only when they equal the latest attestation. Anything else is refused with the new code `policy-not-attested`.
- Test: tests/audit.test.ts "APRV-483 refutation: the roster cannot come from a file the reviewer chose or nobody attested". It covers the chosen file through core and through the CLI, an unattested edit, and a missing file.

(2) "fail-open": CONFIRMED for two inputs, FIXED in eda31f99.
- An unreadable or unparseable policy resolved to "no roster". It is now refused policy-not-attested.
- A sample with no class resolved as default, meaning no roster. It is now refused actor-not-approver.
- Test: "APRV-481/483 refutation: a sample that names no subject hash or no class is refused, never reviewed". It also pins: a missing sampled_subject_hash is refused not-sampled; a garbled verdict is refused verdict-required, never ok; and `namesApprover([], ...)` is false. An empty roster is otherwise unreachable, because policy.schema.json sets minItems 1.

Checked and not fail-open:
- reviewSample has no try/catch that swallows an error. loadPolicyText and resolve fail closed by returning a result.
- The Telegram handler rethrows after drawing TELEGRAM_HANDLER_FAILED, and nothing is appended.
- The reaction-tap path reaches the same core check (Telegram test "APRV-483: a mapped reviewer off the class roster ...").

Remaining by design, same as grants:
- An attested rule with no `approvers` lets any human:<id> review.
- The listener's configured identity is a config-declared trust boundary (§11).

Behavior change for orchestrator/human: a review now needs the policy attested, and before this it needed none. A policy edited and not yet re-attested holds the review backlog open until someone re-attests. This reverses the old "no attestation for review" rationale on purpose. The SPEC hunk proposes it, pending sign-off.

Touches §11.1 invariant 1 (verified records and attested policy) and invariant 6 (two new distinct codes).

PROPOSED SPEC HUNK (pending sign-off). §5.2, after the APRV-137 approvers text, add:
"A retrospective review is held to the same roster. Where the rule resolving the sampled action's class names `approvers`, a reviewer it does not name is refused `actor-not-approver`, and the roster is read only from the attested policy bytes: otherwise the review is refused `policy-not-attested` (Amended APRV-483)."
This reverses "review requires no attestation" in §10.1/§5.2 wherever stated.
§11.2 audit_refusal_codes, new rows after `actor-not-human`:
"| `actor-not-approver` | The reviewer is not on the approvers roster of the rule resolving the sample's class, or the sample names no class. |"
"| `policy-not-attested` | The policy the roster would be read from is unattested, edited since attestation, or unreadable. |"

Fix round 1 (refutation of PR #614), lane claude-edge/A3-fix1.
- F1 (must-fix) FIXED in f7681239. reviewerRoster refuses when the attested bytes do not load, or the resolution came from the fail-closed path, with the NEW audit code policy-invalid (the SPEC §11.2 policy-not-attested row covers unattested, changed and unreadable bytes, never attested bytes that do not load, so the existing code did not fit). Test 'PR #614 refutation F1: an attested policy that does not load names no roster, so every reviewer is refused': glob entry, non-identifier, YAML typo, each attested; off-roster and on-roster reviewers and the CLI refused; record count unchanged. Fails with both predicates mutated off.
- F2 (ruling) FIXED in 52ba4de0. audit.sampled carries payload.policy_sha256 (latest attestation's sha256 at sampling; required on new records via audit_sampled_record, widened by audit_sampled_record_historical; old samples read as not pinned). The review reads the roster only when the policy file's bytes hash to the pin AND an attestation before the sample names that hash; otherwise policy-not-attested, naming the hash it needs. Unpinned (old) samples keep the latest-attestation reading. A class matching no rule in that policy is refused actor-not-approver with the reason. A sweep over a log with no attestation refuses policy-not-attested (unreachable: supervised execution already requires attestation). Tests: 'PR #614 refutation F2: a sample pins the attested policy, and a re-attestation that renames the rule cannot open the review' (renamed+re-attested refused for both reviewers; restored pinned bytes let carter record, bob refused), '... a class that matches no rule in the pinned policy is refused actor-not-approver', '... a sample written before samples pinned a policy reads as not pinned', event-schema F2 test. Each predicate mutated off fails.
- N7 FIXED in 3d81cf5e: reviewerRoster refuses actor-not-approver for a key declared by more than one task; boundPayloadHash returns no binding for one. Test 'PR #614 refutation N7: ...'. AUDIT_REVIEW_HELP has its Arguments: heading back.
- Follow-up filed: APRV-488 (N5, head-moved retry in reviewSample).
- DECISION FOR THE ORCHESTRATOR (consequence of the F2 ruling): after any re-attestation, samples pinned to the earlier policy are reviewable only with the earlier bytes back on disk, so a policy edit holds every older open sample until then (terminal included). The attestation records already store the attested text in the payload store (attestedPolicyPayload, APRV-356); reading the pinned text from there would lift that without weakening the pin. Not done: the ruling said refuse when the file does not match. Also: a class reaching supervised through defaults.autonomy (no rule) can never be reviewed.
UPDATED PROPOSED SPEC HUNKS (N4, pending sign-off). §5.2, replacing the APRV-483 hunk: 'A retrospective review is held to the same roster, read from the policy in force when the action was sampled: `audit.sampled` names that policy's hash (`payload.policy_sha256`), and the roster is read only from attested bytes with that hash. Where they are not on disk, or were never attested before the sample, the review is refused `policy-not-attested`; where they do not load, `policy-invalid`; where the rule resolving the class names `approvers` and not the reviewer, or no rule matches the class, or the key is declared by more than one task, `actor-not-approver` (Amended APRV-483, PR #614).' §10.3 (line ~539, APRV-324 text): 'a terminal, which authenticates no sender, is unaffected and remains the repair' becomes 'a terminal authenticates no sender and remains the repair for a sender refusal; a terminal review is held to the same attested roster as a tap'. §11.2 audit_refusal_codes new rows: actor-not-approver (as before, plus: no rule matches the class in the pinned policy; the key is declared by more than one task), policy-not-attested (unattested, changed or unreadable bytes, or bytes that do not hash to the policy the sample pinned), policy-invalid (the attested bytes the roster would be read from do not load), verdict-required (no verdict; judged after the roster), rendered-payload-mismatch (unchanged).

Fix round 2 (impact-scoped recheck of PR #614).
- NF-3 FIXED in 3449b538. sampleSupervised pins the latest attestation BEFORE the sampled execution.started's seq (executionPolicySha256), read from verified records; that equals the gate's APRV-447 stamp on harness starts by construction (append-only log, compare-and-append) and also covers approval run's unstamped starts. Only an execution older than every attestation falls back to the latest attestation (the pre-NF-3 reading); old unpinned samples keep the latest-attestation reading through the widening. Touches the global invariant "enforcement paths read only verified records": the pin is derived from readVerifiedRecords output only, never from a caller.
- Tests (audit): 'PR #614 recheck NF-3 (probe F2c): a policy attested between the run and the sweep does not re-roster the review'; '... (reverse): a policy that drops the rule before the sweep leaves the sample reviewable by the approver it ran under'; '... (probe F2a): a pin attested only after the sample is refused policy-not-attested'; '... (probe F2b): a pin no attestation names is refused policy-not-attested'. The F1 test now hand-writes its broken pin (handSample, through the real writer), since the sampler no longer pins bytes no execution ran under. Mutation (pin latest at draw) fails both NF-3 tests.
- DECISION FOR THE ORCHESTRATOR: the ruling said "taken at the gate"; this reads the same attestation from the log instead of adding a stamp to execute.ts's execution.started, because the two agree by construction and the log reading covers every existing start. If a stamp on approval run starts is wanted for followers, that is a separate additive change.
- RESIDUAL (outside NF-3, not fixed): eligibility and rate are still judged under the policy in force at the sweep (supervisedExecutions resolves the class under the current load). An action that ran supervised under P1 is never sampled if P2, attested before the sweep, resolves its class to manual or autonomous. Candidate for a follow-up task.
- UPDATED PROPOSED SPEC HUNK (§5.2, replacing fix round 1's wording): 'read from the policy in force when the action ran: `audit.sampled` names that policy's hash (`payload.policy_sha256`, the latest attestation before the sampled `execution.started`), and the roster is read only from attested bytes with that hash.' The rest of the round-1 hunk is unchanged. SPEC.md is not edited.
- NF-4: filed as APRV-490; nothing added.

Closed by the 2026-10-08 backlog sweep (claude-b3/SWEEP-APRV-1): all ACs ticked; shipped in PR #614 (APRV-480..483 supervised-retro core) merged 27980de0 on 2026-10-05; released in 0.4.1 (v0.4.1, PR #622 5f9b9c3d).
<!-- SECTION:NOTES:END -->
