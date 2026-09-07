---
id: APRV-296
title: >-
  Policy ceremony ergonomics: pin only the classes whose loosening is a
  regression, and stop the unknown-key false alarm on daemon.*
status: To Do
assignee: []
created_date: '2026-09-07 03:25'
updated_date: '2026-09-07 06:03'
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

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/core/policy-expectations.ts: trim REPO_POLICY_EXPECTATIONS to the safety set (human-only: vcs.history.rewrite, policy.core, log.mutate, account.credential; manual whose loosening is a regression: deps.add, network.call, release.publish, policy.edit.ci, files.delete.out_of_scope; the manual DEFAULT for undeclared classes: communicate.email.external, deps.upgrade, bare read). Every kept pin's note states the regression a loosening would be. Drop the pins that protect nothing (vcs.pr.create, vcs.commit.branch, vcs.push.branch, vcs.push.main, log.advance, log.sync, deps.install, files.write.workspace, files.delete.scratch, vcs.remote.meta, policy.edit, policy.edit.design, policy.edit.spec, read.web, read.files.workspace).
2. Same file: checkPolicyExpectations stops failing 'unpinned'. The declared-class loop keeps the 'unreachable' check and loses the pin-coverage check; the ExpectationFailure kind 'unpinned' and its pinLine field go with it, as does the pinsToAdd plumbing in src/cli/amend.ts (message, runbook footer, --json pins.add). pinLine() itself stays as the documented spelling a human pastes.
3. tests/dogfood.test.ts: replace the approval_ttl exact-value assertion with a fail-closed one (a TTL is declared and positive); keep the defaults test (autonomy manual, on_expiry reject).
4. src/core/policy-diff.ts: POLICY_TOP_LEVEL_KEYS becomes policyTopLevelKeys(), derived from schema/policy.schema.json's own top-level properties (read lazily, memoized, with the hand-written list as the fallback when the schema cannot be read, so an unreadable schema still errs loud). No Ajv import: the schema path is derived from import.meta.url the way validate.ts derives DEFAULT_SCHEMA_DIR, and a test asserts the two agree.
5. Tests: dogfood.test.ts feeds the live APPROVAL.md through diffPolicies+renderDiff and asserts no UNKNOWN KEY line (the daemon.* case) plus that daemon is in the derived vocabulary; tests/cli-amend.test.ts's APRV-274 unpinned refusal becomes an acceptance case (a declared, emittable, unpinned deps.remove runs the ceremony clean); tests/policy-pins.test.ts loses the unpinned-failure cases.
6. Docs: docs/dogfood-cutover.md gains a 'which pins exist and why' subsection under the amendment ceremony; docs/cli-reference.md's policy-suite paragraph loses the unpinned-remedy claim; CHANGELOG bullet under 0.1.0 (unreleased).
7. Verify: npm run build, node --test dist/tests/dogfood.test.js, the policy/ceremony suites (policy-pins, cli-amend, cli-policy, policy-load, policy-match), npm run lint, full npm test.
<!-- SECTION:PLAN:END -->
