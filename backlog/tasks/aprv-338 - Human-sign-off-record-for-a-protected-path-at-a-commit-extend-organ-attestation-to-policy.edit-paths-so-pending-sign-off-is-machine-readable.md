---
id: APRV-338
title: >-
  Human sign-off record for a protected path at a commit: extend organ
  attestation to policy.edit paths so pending sign-off is machine-readable
status: To Do
assignee: []
created_date: '2026-09-14 22:25'
labels:
  - design
  - guard
  - spec
dependencies: []
priority: medium
ordinal: 256000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC.md's amendment-provenance rule (near line 11) says text that reached a protected file without a grant carries '(Amended APRV-n, pending sign-off.)' until a human ratifies it, and doubt resolves to pending. Nothing today records the ratification: no event, no verb, no way for CI or doctor to tell a ratified amendment from a pending one. Meanwhile APRV-272 already built the exact shape for the gate's organs: a human runs approval policy attest --organ <path>, the runtime appends gate.organ.attested carrying the repository-relative path and the SHA-256 of the bytes, and the protected-path guard (src/core/protected-path-guard.ts, the attested verdict, path plus digest at HEAD) accepts it as evidence that a human saw that content. It is deliberately limited to policy.core organs: organPathRefusal in src/core/attest.ts refuses path-not-organ, and isGateOrganPath in src/core/command-class.ts admits only the hook install files. Proposal: a sibling human-only record (name to decide, for example protected.path.signed_off) with {path, sha256}, appended by a human-only verb after reading the diff, accepted by the guard for policy.edit and policy.edit.* paths the way the organ record is for organs, with SPEC 5.2 and 10 amended and the pending-sign-off suffix defined as resolved by such a record. It is whole-file evidence and therefore weaker than a hunk grant, so the SPEC text must say when it is appropriate (ratifying text a human has read at that commit) and the guard must keep preferring hunk evidence in the reasons it prints. Motivation: PR #393 was blocked by the guard for two SPEC hunks the policy had let proceed unsampled (APRV-337 is the guard bug); the only ways out were re-editing under a grant or fixing the guard, and neither is what a human who has read the diff and agrees with it should have to do. Related: APRV-272 (organ attestation), APRV-316 (policy-authorized tier), APRV-337 (its absolute-path bug).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A new human-only record type carrying a repository-relative protected path and the SHA-256 of its bytes is defined in the event schema and validated at the write boundary; the runtime computes the digest, never the caller
- [ ] #2 A human-only verb appends it; run by an agent or without a human actor it refuses with a machine-readable code, and the gate mints nothing for it
- [ ] #3 The protected-path guard accepts the record as the attested verdict for policy.edit and policy.edit.* paths only when path and digest at HEAD both match, and its finding names the record; tests are built through the real append path, including a wrong-path and a wrong-digest case
- [ ] #4 SPEC 5.2 and 10 are amended to define the record, when it is appropriate, and that it resolves the pending-sign-off suffix; the amendment is called out to the human
- [ ] #5 approval doctor or approval status lists protected files whose text carries a pending-sign-off marker with no matching record
<!-- AC:END -->
