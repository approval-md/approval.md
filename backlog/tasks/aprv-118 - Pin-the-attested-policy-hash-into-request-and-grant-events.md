---
id: APRV-118
title: Pin the attested policy hash into request and grant events
status: To Do
assignee: []
created_date: '2026-08-20 14:46'
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
- [ ] #1 approval.requested and approval.granted events written by the gate carry the SHA-256 of the attested policy in force, assigned at the write boundary; a caller-supplied value is refused
- [ ] #2 A grant whose current policy hash differs from the hash recorded on the matching request is refused with its own stable machine-readable reason code, pinned by a test
- [ ] #3 Event schemas updated; records without the field (pre-change logs) still validate and verify
- [ ] #4 SPEC amended (§5.2 attestation and/or §8) describing the field and the refusal, marked as an amendment for human sign-off
- [ ] #5 npm test passes; lint clean
<!-- AC:END -->
