---
id: APRV-356
title: >-
  Terminal attestations store the attested policy text, so the policy in force
  is always recoverable
status: To Do
assignee: []
created_date: '2026-09-17 20:09'
updated_date: '2026-09-19 11:12'
labels:
  - policy
  - attestation
  - payload-store
dependencies: []
priority: medium
ordinal: 273000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found while landing APRV-324 (PR #427, 2026-09-17). Attestation answers from the phone are now resolved against the policy IN FORCE rather than the file being attested, because whoever edited the proposed file could otherwise map their own account as the one that approves it. The in-force bytes are recovered by inForcePolicyText in src/core/policy-proposal.ts: it finds the attested digest, finds a policy.proposed record that bound exactly those bytes, reads the stored text from the payload store and re-hashes it against the digest. That only works for a policy that was proposed to a phone. approval policy attest and approval policy amend on their human terminal path append policy.updated and store nothing, so a chain only ever attested at a terminal (this repository included) has no recoverable bytes. The runtime then falls back to the fail-closed rule (attest-requires-terminal whenever the proposed policy maps senders for the channel), which is safe but leaves one documented residual: when the in-force bytes are unrecoverable, an amendment that REMOVES a sender mapping is indistinguishable from a policy that never had one, so a phone attestation of it falls back to the configured listener identity. Close it at the root: every attestation, terminal or phone, stores the attested policy text in the payload store and binds its payload hash on the record it appends, so inForcePolicyText succeeds for any chain attested after this lands. The store is content-addressed and re-verified on read, so this trusts nothing new. Consider payload retention: the in-force policy text must be exempt from pruning while it is in force. Carter approved filing on 2026-09-18. Related: APRV-324, APRV-109 (attest from the phone), APRV-341 (policy amend --pr), the payload retention rules in SPEC 10.4.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval policy attest and approval policy amend on the terminal path store the attested policy text in the payload store and bind its hash on the record they append (schema change called out); the phone path is unchanged; the text is re-hashed against the attested digest on every read
- [ ] #2 inForcePolicyText recovers the in-force policy for a chain attested only at a terminal; with that, a phone attestation of an amendment that removes or changes the senders mapping is decided against the in-force mapping, and the APRV-324 residual is closed with a test that fails on the old behaviour
- [ ] #3 Retention pruning never removes the payload holding the policy currently in force, with a test; a chain attested before this change keeps the documented fail-closed fallback
- [ ] #4 SPEC 5.2 and 10.4 amended and called out; design/channel-sender-identity.md residual paragraph updated; build, typecheck, lint and the attest, amend, payload-store and sender-identity suites pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. core/attest.ts: appendAttestation reads the policy once, stores { text } in the payload store beside the log, and binds the hash on the policy.updated it appends. A store write that fails REFUSES the attestation.
2. core/policy-proposal.ts: inForcePolicyText accepts an ATTESTATION carrying payload_hash as well as a proposal, re-hashing the recovered text against the attested digest.
3. schema: policy.updated payload gains an optional, described payload_hash. Additive; records written before it still validate.
4. Retention: nothing new to write. The binding sits on a record with no action key, so planPrune treats it as unattributable and therefore live forever. Pin it with a test.
5. SPEC 5.2 (a new bullet) and 10.4 (one sentence on the retention rule), one commit. design/channel-sender-identity.md residual paragraph rewritten as closed.
6. Tests: sender-identity 26 becomes the closure case (in force MAPPED, amendment UNMAPPED, tap attributed to human:carter) and fails on the old behaviour; 26a pins the bootstrap refusal; 26b pins the fail-closed fallback for a pre-change chain, built through the real append path.
7. Fall-out to finish: every suite that counts payload-store files or asserts the exact set of paths a commit carries.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
HANDED OVER INCOMPLETE on 2026-09-19. Branch lane/attest-stores-text-356b, commit 5b1e1d1, pushed with NO pull request and marked DO NOT MERGE. The core is done and green in its own suites; the fall-out is not.

DONE AND VERIFIED
- src/core/attest.ts stores the attested bytes and binds the hash (AC1 for the attest verb; the amend terminal path goes through the same function, so it is covered by construction).
- src/core/policy-proposal.ts recovers from an attestation own binding, re-hashing against the attested digest (AC2).
- schema/event.schema.json describes the optional payload_hash on policy.updated.
- SPEC 5.2 and 10.4 amended in that one commit; design/channel-sender-identity.md residual rewritten as closed (AC4 prose half).
- tests/sender-identity.test.ts: 32/32. Case 26 is the closure and FAILS on the old behaviour; 26a pins the bootstrap refusal; 26b pins the pre-change fallback through the real append path (AC2 and AC3 second half).
- tests/prune.test.ts: 12/12, including a case that the in-force policy text survives a prune far past any window and is still recoverable (AC3 first half).
- tests/attest.test.ts and tests/policy-proposal.test.ts green.
- build, typecheck, lint clean; conformance 374/374.

NOT DONE, and why it is not a five-minute job
npm test is 4689 tests with 44 failures: 22 are the pre-existing Node v26 SMTP set, 4 are a stale dist file from the previous branch, and about 18 are real fall-out from the extra stored payload. They fall into two kinds.
(a) COUNTS. doctor, status and the hook prompt suites assert how many files the payload store holds. Mechanical.
(b) A DESIGN QUESTION, and the reason this is handed back rather than pushed through. approval policy amend --commit, approval policy apply and approval log advance assert the EXACT set of paths their commit carries, and those assertions now fail. That is not a stale expectation: a committed log that carries a binding whose payload file was never committed is a chain whose in-force bytes are unrecoverable to every reader of the committed copy, which is precisely what this task exists to prevent, and the CI protected-path guard resolves payloads out of committed trees. So the commit-path verbs almost certainly MUST also commit the new payload file, and that is a behaviour change to three ceremony verbs that deserves its own reading rather than a test edit. Options: (1) the ceremony verbs add the attestation payload to the paths they commit, which is the coherent answer; (2) the attestation payload is written somewhere the advance already carries; (3) narrower, store the text only when the caller asks. This lane did not choose.

ALSO WORTH KNOWING: the SPEC and design edits are in commit 5b1e1d1, so whoever finishes this must NOT edit them again in a later commit on the same branch (the guard replay budget rule), and the branch will need a records advance before its guard can pass.
<!-- SECTION:NOTES:END -->
