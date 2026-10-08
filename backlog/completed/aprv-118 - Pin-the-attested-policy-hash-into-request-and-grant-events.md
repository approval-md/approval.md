---
id: APRV-118
title: Pin the attested policy hash into request and grant events
status: Done
assignee: []
created_date: '2026-08-20 14:46'
updated_date: '2026-08-25 12:42'
labels:
  - gate
  - schema
  - emilia-review
dependencies: []
priority: high
ordinal: 110000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A grant records a decision but not the policy it was evaluated under. Attestation gates operations on the live file matching the latest policy.updated event, but nothing in the approval.requested or approval.granted record says which attested policy version resolved the class, so a policy edit landing between request and grant leaves the log unable to show whether the approver decided under the rules the requester was routed by (Emilia Protocol calls this policy drift, RT-027, and commits policy_hash into every binding: a signature over a context with policy hash X must not satisfy a requirement evaluated under policy hash Y).

Outcome: gate-written approval.requested and approval.granted events carry the SHA-256 of the attested policy in force at the moment the runtime evaluated them, assigned at the write boundary like ts (never caller-supplied), and the gate refuses a grant when the policy hash at grant time differs from the hash at request time, with a distinct machine-readable reason: the pending request is void and must be re-requested under the new policy.

Schema change is in scope and called out per CLAUDE.md: the two event schemas gain the field. Enum/verifier compatibility follows the SPEC §8 precedent for additive changes (readers of a v0.1 log may encounter records with and without the field; a verifier must accept both). SPEC §5.2/§8 amendment for human sign-off is part of the task. Touches §11.1 invariants 1, 2 and 5 (verified reads, runtime timestamps, compare-and-append); implementation notes must say so.

Reference: emiliaprotocol/emilia-protocol docs/security/THREAT_MODEL.md threat 3 ("no accept-with-warning path"), CANONICAL_BINDING_FIELDS in docs/security/REPLAY_RESISTANCE.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval.requested and approval.granted events written by the gate carry the SHA-256 of the attested policy in force, assigned at the write boundary; a caller-supplied value is refused
- [x] #2 A grant whose current policy hash differs from the hash recorded on the matching request is refused with its own stable machine-readable reason code, pinned by a test
- [x] #3 Event schemas updated; records without the field (pre-change logs) still validate and verify
- [x] #4 SPEC amended (§5.2 attestation and/or §8) describing the field and the refusal, marked as an amendment for human sign-off
- [x] #5 npm test passes; lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built 2026-08-25 by an Opus subagent, reviewed by fable, merged in PR #118 (schema commit 4291d82, gate commit 56210bf, SPEC amendment commit by fable after the human approved the re-proposed prompt — the first rejection was flood-clearing, not a considered denial). payload.policy_sha256 on approval.requested/approval.granted, optional and shape-constrained (64-char lowercase hex). requireAttestation returns the matched hash; request() stamps it; decide() re-reads at decision time, never copies from the request. Refusal code policy-drift, added to the frozen GATE_REFUSAL_CODES union, deliberately distinct from policy-not-attested (unverified file vs verified different file). Caller-supplied values refused structurally: no field on RequestInput/DecideOptions; a test casts past the types to prove the runtime's value lands. INVARIANTS TOUCHED (§11.1): 1 verified reads — hash comes from checkAttestation over chain-verified records, drift comparison reads the request's hash from the same derivation; 2 write-boundary assignment — structural refusal mirroring ts; 5 compare-and-append — unchanged, drift refusal happens before any append (event-list assertion proves nothing written). AC 3 verified: pre-change records without the field validate, verify, and grant. SPEC §5.2 amended, (Amended APRV-118, pending sign-off.). Follow-up noted, out of scope: consumeHarnessGrant (APRV-117) does not compare the grant's pinned hash at spend time — a harness grant spends under whatever policy is attested when the retry runs. Verified: 5 new gate tests, 9 exact-payload assertions updated across e2e suites, 2044 tests, lint clean, merged through the queue.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Request and grant events pin the attested policy hash they were evaluated under, assigned at the write boundary like ts; a grant under a re-attested policy refuses policy-drift with nothing appended. Verified by new gate tests incl. the re-attestation drift path and pre-change log compatibility, merged in PR #118.
<!-- SECTION:FINAL_SUMMARY:END -->
