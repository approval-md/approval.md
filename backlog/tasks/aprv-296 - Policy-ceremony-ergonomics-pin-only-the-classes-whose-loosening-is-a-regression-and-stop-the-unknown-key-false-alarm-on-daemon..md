---
id: APRV-296
title: >-
  Policy ceremony ergonomics: pin only the classes whose loosening is a
  regression, and stop the unknown-key false alarm on daemon.*
status: To Do
assignee: []
created_date: '2026-09-07 03:25'
labels:
  - policy
  - dogfood
dependencies: []
priority: medium
ordinal: 217000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two frictions from the 2026-09-07 ceremony (seq 27110), which turned a one-line TTL change plus one declared class into three failed runs. (1) Every declared class must be pinned in src/core/policy-expectations.ts, and tests/dogfood.test.ts pins defaults such as approval_ttl, so any deliberate policy tuning is also a code change built before the ceremony accepts it. Pins earn their keep on the classes whose loosening would be a security regression (human-only classes, log.mutate, deps.add, release.publish, policy.edit.ci, the manual default for undeclared classes) and on fail-closed defaults (autonomy manual, on_expiry reject). Pinning vcs.pr.create as supervised or approval_ttl as 24h protects nothing and blocked Carter's tuning twice tonight. (2) The amend diff printed 'daemon.full_reproof_after: 60s -> 60s (UNKNOWN KEY: ... the policy FAILS CLOSED to all-manual until it is removed)' for three daemon.* keys that were unchanged, that doctor's read-proof row reads, and that the same ceremony then loaded clean and resolved every pin against. The diff renderer's vocabulary is behind the schema, and a false fail-closed warning in a ceremony output teaches operators to ignore warnings.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The pin set is reduced to the safety classes and fail-closed defaults, each pin's note says why loosening it would be a regression, and a declared class with no pin is accepted by the ceremony and by tests/dogfood.test.ts (a policy that declares a new supervised or autonomous class needs no code change)
- [ ] #2 tests/dogfood.test.ts stops asserting approval_ttl's exact value and asserts only what fail-closed needs (a TTL exists, on_expiry rejects, default autonomy manual)
- [ ] #3 The amend diff's key vocabulary is derived from the policy schema, so daemon.read_proof, daemon.full_reproof_every and daemon.full_reproof_after render as known keys; a test feeds the live APPROVAL.md through the diff and asserts no UNKNOWN KEY line
- [ ] #4 docs/dogfood-cutover.md (or the ceremony doc) says which pins exist and why; CHANGELOG entry
<!-- AC:END -->
