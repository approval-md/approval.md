---
id: APRV-134
title: Harness grant spend checks the pinned policy hash
status: To Do
assignee: []
created_date: '2026-08-25 12:43'
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
- [ ] #1 consumeHarnessGrant refuses a spend whose grant carries a policy_sha256 differing from the attested hash at spend time, with a pinned machine-readable reason
- [ ] #2 A grant without the field (pre-118 log) spends as today; absence is not a mismatch, tested
- [ ] #3 npm test passes; lint clean
<!-- AC:END -->
