---
id: APRV-356
title: >-
  Terminal attestations store the attested policy text, so the policy in force
  is always recoverable
status: Done
assignee: []
created_date: '2026-09-17 20:09'
updated_date: '2026-09-19 12:29'
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
- [x] #1 approval policy attest and approval policy amend on the terminal path store the attested policy text in the payload store and bind its hash on the record they append (schema change called out); the phone path is unchanged; the text is re-hashed against the attested digest on every read
- [x] #2 inForcePolicyText recovers the in-force policy for a chain attested only at a terminal; with that, a phone attestation of an amendment that removes or changes the senders mapping is decided against the in-force mapping, and the APRV-324 residual is closed with a test that fails on the old behaviour
- [x] #3 Retention pruning never removes the payload holding the policy currently in force, with a test; a chain attested before this change keeps the documented fail-closed fallback
- [x] #4 SPEC 5.2 and 10.4 amended and called out; design/channel-sender-identity.md residual paragraph updated; build, typecheck, lint and the attest, amend, payload-store and sender-identity suites pass
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
FINISHED 2026-09-19 by lane 3. PR #458 (branch lane/attest-stores-text-356b, commits 5b1e1d1 the core and 626c4f9 the ceremony change), armed with gh pr merge 458; GraphQL confirmed isInMergeQueue true, mergeStateStatus CLEAN, autoMergeRequest null.

THE OPEN QUESTION, RULED. The orchestrator chose option 1 on 2026-09-19: the ceremony verbs also commit the attestation payload file. approval policy amend --commit, approval policy apply (which runs an amend) and approval log advance now carry it. The advance already carried .approval/payloads whole; amend and apply carry the one file beside APPROVAL.md, the log and the pins. This is a BEHAVIOUR CHANGE to three verbs, stated as such in the commit message and the PR body. The reason it is not a test edit: a committed log carrying a binding whose payload file was never committed has unrecoverable in-force bytes for every reader of the committed copy, which is the state this task exists to end, and the CI protected-path guard resolves payloads out of committed trees.

HOW THE PAYLOAD PATH IS KNOWN. Addressed from the live bytes rather than read back from the appended record, through attestedPolicyPayloadHash in src/core/attest.ts (which also gives the { text } store shape one author). That makes it a ceremony file from the START: --dry-run names it in the git add it would run, and --commit counts it as the ceremony own rather than as a stray in the index. The human path binds the attestation payload; the agent path binds the proposal payload, which is what carries the text on a chain attested from a phone. An edit landing between the addressing and the append moves the hash, and the append refuses on the digest before the path is used.

WHAT THE DIFF HIDES. (a) The headline and the staged-unrelated refusal both name all four files; a commit that carried more than it said would be the one commit that may not lie. (b) tests/cli-amend.test.ts checkoutState now filters the payload store as well as the working log, for one reason covering both: the attestation IS an append to the log and a write of the bytes beside it. (c) tests/cli-style-render.test.ts masks the store path before the no-64-hex rule, because a content-addressed file NAME is a path an operator types exactly, never a digest on display; shortening it would print a command that does not run. (d) Fixtures that asserted an empty payload store now assert the delta, because an absolute would be a claim about the fixture. (e) The unrecoverable-bytes refusal in inForcePolicyText named only policy.proposed and now names both kinds of record.

INVARIANTS. No SPEC section 11 invariant is weakened. The store stays content-addressed and re-verified on read, so nothing new is trusted, and the one new decision point fails closed: an unwritable store refuses the attestation rather than appending a binding nobody can resolve.

VERIFICATION. On the merged head: npm test 4694 tests, 4671 pass, 22 fail, exit 1 - all 22 are the pre-existing Node v26 SMTP/email failures on this laptop (TLS ServerName may not be an IP), untouched by this work; CI on Node 22 is green on all three shards. build, typecheck, lint clean; npm run conformance 374/374. The protected-path guard went red before the records advance and passed on re-run after it (records-log-2026-09-19, PR #459).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Every attestation, terminal or phone, now stores the attested policy text in the payload store and binds its hash on the record it appends, and the three ceremony verbs commit that file so the binding is resolvable from the committed tree. inForcePolicyText recovers from an attestation own binding as readily as from a proposal, which closes the APRV-324 residual: a phone attestation of an amendment that removes a sender mapping is decided against the in-force mapping rather than against the file being proposed. Verified by tests/sender-identity.test.ts case 26 (fails on the old behaviour), 26a and 26b (the pre-change fail-closed fallback, built through the real append path), tests/prune.test.ts (retention never takes the in-force text), and the amend, apply and advance path-set cases that now name the payload file the record binds. PR #458, armed and in the merge queue.
<!-- SECTION:FINAL_SUMMARY:END -->
