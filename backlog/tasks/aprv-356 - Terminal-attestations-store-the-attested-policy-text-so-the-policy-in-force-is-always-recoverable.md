---
id: APRV-356
title: >-
  Terminal attestations store the attested policy text, so the policy in force
  is always recoverable
status: To Do
assignee: []
created_date: '2026-09-17 20:09'
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
