---
id: APRV-142
title: >-
  Attestation/policy read TOCTOU: two unsynchronized APPROVAL.md reads per gate
  op (red-team F5, medium)
status: Done
assignee: []
created_date: '2026-08-25 13:41'
updated_date: '2026-08-26 16:37'
labels:
  - security
  - hardening
  - cleanroom-review
dependencies: []
references:
  - ../approval-md-redteam (findings-report.md
  - F5)
  - src/core/gate.ts
  - src/core/attest.ts
priority: medium
type: bug
ordinal: 129000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
PLAUSIBLE, verified as a real window but narrow; the red-teams own race probe saw the file change mid-flight in 946/3000 attempts but observed 0 parser-side wins. A gate operation reads APPROVAL.md twice without synchronization (src/core/gate.ts around the attest-check and the parse, ~976-979), so in principle the attestation check and the policy parse can see different bytes. Fix direction: read the policy bytes once per gate operation and reuse the same buffer for both the attestation hash check and the parse, so a mid-operation file swap cannot split the decision. Low urgency given the narrow window, but cheap to make structurally impossible.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A gate operation reads APPROVAL.md bytes once and uses the same bytes for both the attestation check and the policy parse
- [x] #2 Test asserts that a file swap between the two former read points cannot produce an attested-but-different parsed policy
- [x] #3 npm test passes; lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built 2026-08-26 by an Opus subagent, reviewed by fable, merged in PR #126 (commit 3e08153). One policy read per gate operation at ALL FIVE sites (request, decide, withdraw, consumeHarnessGrant, expire), threaded through APRV-118's requireAttestation so the pinned policy_sha256 is by construction the hash of the parsed bytes. loadPolicy split into discovery + loadPolicyText; checkAttestationOfBytes is the no-I/O form; checkAttestation keeps its signature for CLI/doctor callers. Read seam GateOptions.policy.read (widens no authority). Side benefit: policyPathOf and loadPolicy's discovery can no longer pick different files on the gate path. Tested with a reader returning different bytes on every call. Merge note: PR #127's startHarnessExecution was reconciled onto this pattern during the conflict resolution, so the new writer obeys the one-read invariant too. Out of scope, noticed: resolveFile remains the discovery for non-gate loadPolicy callers (not a defect).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A gate operation reads APPROVAL.md once and both the attestation check and the parse consume the same bytes, at all five gate sites; a mid-operation file swap is structurally impossible. Verified with an every-call-different-bytes read seam; merged in PR #126.
<!-- SECTION:FINAL_SUMMARY:END -->
