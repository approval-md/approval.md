---
id: APRV-296
title: >-
  Policy ceremony ergonomics: pin only the classes whose loosening is a
  regression, and stop the unknown-key false alarm on daemon.*
status: To Do
assignee: []
created_date: '2026-09-07 03:25'
updated_date: '2026-09-07 06:35'
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
- [x] #1 The pin set is reduced to the safety classes and fail-closed defaults, each pin's note says why loosening it would be a regression, and a declared class with no pin is accepted by the ceremony and by tests/dogfood.test.ts (a policy that declares a new supervised or autonomous class needs no code change)
- [x] #2 tests/dogfood.test.ts stops asserting approval_ttl's exact value and asserts only what fail-closed needs (a TTL exists, on_expiry rejects, default autonomy manual)
- [x] #3 The amend diff's key vocabulary is derived from the policy schema, so daemon.read_proof, daemon.full_reproof_every and daemon.full_reproof_after render as known keys; a test feeds the live APPROVAL.md through the diff and asserts no UNKNOWN KEY line
- [x] #4 docs/dogfood-cutover.md (or the ceremony doc) says which pins exist and why; CHANGELOG entry
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Landed on branch worktree-agent-a9e56290a63c321ad, one commit (f03ad1e).

WHAT CHANGED

(1) The pins are a safety floor, not an inventory. REPO_POLICY_EXPECTATIONS goes from 25 entries to 12, in three families, and every kept pin's note now says what loosening that class would cost:
  - human-only (4): vcs.history.rewrite, policy.core, log.mutate, account.credential. Loosening any of them mints agent authority over shared history, the policy file, the log, or the credentials that decide (SPEC 11.1 invariant 9).
  - manual (5): deps.add (unreviewed code enters the build), network.call (a write no local revert reaches), release.publish (a permanent publish under this name), policy.edit.ci (the other enforcement path, including the job that runs this check), files.delete.out_of_scope (a loss found by a reader, not by the gate).
  - the fail-closed default (3): communicate.email.external, deps.upgrade and bare read, pinned at manual/default precisely because the policy does not declare them, so a policy that stopped defaulting to manual fails here even though every declared class still resolves as written.
Dropped: vcs.pr.create, vcs.commit.branch, vcs.push.branch, vcs.push.main, log.advance, log.sync, deps.install, files.write.workspace, files.delete.scratch, vcs.remote.meta, policy.edit, policy.edit.design, policy.edit.spec, read.web, read.files.workspace. None of their notes stated a regression argument. Loosening a class that is already autonomous is not a direction; vcs.push.main's dangerous direction is the irreversibility floor, which tests/dogfood.test.ts pins on its own line; read.web and read.files.workspace are covered by the existing 'classifier read.* classes are covered by the read.* rule' test. policy.edit and its two sub-classes were the closest call, and they are dropped because policy.core (APPROVAL.md and .approval/*) stays human-only, policy.edit.ci stays manual, the protected-path guard is additive whatever the policy says, and any loosening of the remainder still prints in the ceremony's class-resolution diff under the human's eye before it is attested.

(2) checkPolicyExpectations accepts a declared class no pin names. The 'unpinned' failure kind and the ExpectationFailure.pinLine field are gone, and with them the pinsToAdd plumbing in src/cli/amend.ts (message sentence, runbook footer, the {pins:{add:[...]}} object beside the --json refusal). The declared-class loop keeps the APRV-266 reachability check. pinLine() stays exported as the spelling a human uses when adding a pin by hand. The 'resolution' refusal now prints the pin's note, so an operator is told the argument rather than just the delta.

(3) tests/dogfood.test.ts asserts of approval_ttl only that it is declared and positive, beside the defaults that are not an operator's to tune (autonomy manual, on_expiry reject). Two new tests: a declared class no pin names is accepted (and the suite fails if the live policy has none, so the test cannot pass vacuously), and a scratch copy of the live policy with log.mutate turned autonomous is refused as resolution:log.mutate.

(4) The amend diff's key vocabulary is read from schema/policy.schema.json's own top-level properties (policyTopLevelKeys(), memoised per process) instead of the hand-written copy that had fallen behind APRV-217. The old list survives only as the fallback for a schema that cannot be read, which errs loud (keys reported unknown) rather than silent. policy-diff keeps its empty runtime dependency graph on purpose: importing validate.ts for DEFAULT_SCHEMA_DIR would pull Ajv into every process that renders a diff (the Telegram channel included), so the schema path is derived from import.meta.url and tests/policy-vocabulary.test.ts asserts it is the same file validate.ts validates against. New tests: the live APPROVAL.md through the real renderDiff with no UNKNOWN KEY line (diffed against itself, the shape the incident had), the vocabulary equals the schema's properties, the daemon block renders as known keys, and a key the schema really does not declare is still named UNKNOWN KEY.

(5) Docs: docs/dogfood-cutover.md gains 'Which classes are pinned, and why (APRV-296)' with the three-family table, what still holds without the dropped pins, and the shape of a new pin line; its policy-suite-failed line no longer promises a pasteable pin. docs/cli-reference.md updated in three places (the policy-suite paragraph, the semantic-diff paragraph, the refusal-code list). CHANGELOG bullet under 0.1.0 (unreleased).

INVARIANTS (SPEC 11.1)

Fail closed is the invariant this task touches. The trimmed set still catches the direction that matters: a policy turning any manual or human-only class looser fails the pin check before the attestation, proved by tests/dogfood.test.ts ('the pins still catch a pinned class turned looser') and by tests/cli-amend.test.ts (deps.add loosened is still policy-suite-failed with nothing attested, committed or pushed). What is given up is the detection of a policy that loosens an already-autonomous or supervised class, which has no stricter direction to lose and is printed in the semantic diff regardless. No enforcement path reads anything new; the schema read added to policy-diff is display vocabulary and cannot change a verdict.

SPEC amendment text: none needed. SPEC.md does not describe the repository's own pin list or the amend verb's refusal union (policy-suite-failed appears nowhere in SPEC.md or conformance/), so nothing in the specification went stale. APPROVAL.md was not edited (policy.core, human-only).

TESTS
  npm run build: exit 0
  node --test dist/tests/dogfood.test.js + policy-pins + policy-vocabulary: 42 tests, 42 pass, 0 fail
  node --test dist/tests/cli-amend.test.js: 90 tests, 90 pass, 0 fail
  cli-policy + policy-load + policy-match + policy-explain + policy-proposal + cli-doctor: 221 tests, 221 pass, 0 fail
  npm run lint: exit 0
  npm test (full): 3841 tests, 3840 pass. The one red was the known ci-guard ENOENT on a missing node_modules/@modelcontextprotocol/sdk; after npm ci, ci-guard is 31/31 green. sandbox-probe passed in this run.
<!-- SECTION:NOTES:END -->
