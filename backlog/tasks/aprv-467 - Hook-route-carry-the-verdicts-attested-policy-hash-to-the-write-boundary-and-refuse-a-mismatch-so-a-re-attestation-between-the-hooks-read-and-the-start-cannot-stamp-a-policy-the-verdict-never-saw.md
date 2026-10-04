---
id: APRV-467
title: >-
  Hook route: carry the verdict's attested policy hash to the write boundary and
  refuse a mismatch, so a re-attestation between the hook's read and the start
  cannot stamp a policy the verdict never saw
status: To Do
assignee: []
created_date: '2026-10-04 11:23'
labels:
  - agent-village
dependencies:
  - APRV-447
ordinal: 354000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Raised by the refuter on PR #587 (APRV-447, 2026-10-04). On the hook route the verdict comes from the hook's own earlier read of the attested policy, and the start reads the policy again at the write boundary; a re-attestation that lands between the two leaves execution.started stamped with the policy in force at the append, not the one the verdict was computed from. The gap predates APRV-447 (it is a two-read window), and APRV-447's SPEC hunk now states the SHOULD: an implementation carries the verdict's attested hash to the write boundary and refuses a mismatch. Build it: the hook passes the attested sha256 it resolved the class against into startHarnessExecution (and the serve hook route into its worker), the write boundary compares it with the hash it re-checks, and a mismatch refuses with a distinct machine-readable code (policy-drift is the existing neighbour; decide whether to reuse it or add policy-changed-since-verdict) and appends nothing; the hook then re-evaluates against the new policy rather than carrying a stale verdict. Not a caller-supplied field in the SPEC sense: it is the runtime's own earlier read, and a mismatch can only refuse.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 startHarnessExecution and the serve hook route accept the verdict's attested hash from the runtime's own read; a re-attest between the two reads refuses with a distinct code and appends nothing; tests for both routes
- [ ] #2 The hook re-evaluates after such a refusal and either proceeds under the new policy or refuses as that policy says; a test shows a class that became manual is not started
- [ ] #3 SPEC §8's SHOULD sentence (APRV-447) becomes a MUST in the next attestation batch; the hunk is drafted in the notes
<!-- AC:END -->
