---
id: APRV-134
title: Harness grant spend checks the pinned policy hash
status: Done
assignee: []
created_date: '2026-08-25 12:43'
updated_date: '2026-08-26 17:41'
labels:
  - gate
  - hook
  - security
dependencies: []
priority: medium
ordinal: 126000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Born 2026-08-25 from the APRV-118 builder's out-of-scope observation. APRV-118 pins policy_sha256 into approval.requested and approval.granted and refuses a grant when the hash at grant time differs from the hash at request time. The harness carryover spend path (consumeHarnessGrant, APRV-117) is the remaining consumer that does not make the equivalent comparison: a post-timeout retry adopts a grant and spends it under whatever policy is attested when the retry runs. A policy re-attested between the human's tap and the agent's retry can therefore change the rules an already-granted command executes under. Outcome: consumeHarnessGrant compares the grant's pinned policy_sha256 against the attested hash in force at spend time and refuses on mismatch with the same policy-drift reason APRV-118 froze (or a distinct spend-time variant if review prefers; either way machine-readable and pinned). Records without the field (pre-118 grants) follow the additive rule: absence is not a mismatch. Touches §11.1 invariants 1 and 5; implementation notes must say so.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 consumeHarnessGrant refuses a spend whose grant carries a policy_sha256 differing from the attested hash at spend time, with a pinned machine-readable reason
- [x] #2 A grant without the field (pre-118 log) spends as today; absence is not a mismatch, tested
- [x] #3 npm test passes; lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built 2026-08-26, merged in PR #127 (commit 941640b). consumeHarnessGrant compares the grant's pinned policy_sha256 (falling back to the request's, so a log carrying only one is judged by the one it has) against the attested hash at spend time; refuses policy-drift — APRV-118's existing frozen code, deliberately not a spend-time variant (same fact, same remedy; a second code would be a distinction an agent cannot act on differently). Absence on both records is not a mismatch, tested across a re-attestation so the absence is doing the work. Closes the gap the APRV-118 builder flagged: a post-timeout retry now spends only under the policy the approver decided under.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A harness grant spends only under the attested policy it was granted under; a re-attestation in the human-tap-to-retry window refuses policy-drift. Merged in PR #127.
<!-- SECTION:FINAL_SUMMARY:END -->
