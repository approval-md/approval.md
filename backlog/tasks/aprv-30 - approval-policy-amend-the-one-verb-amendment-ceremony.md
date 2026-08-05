---
id: APRV-30
title: 'approval policy amend: the one-verb amendment ceremony'
status: To Do
assignee: []
created_date: '2026-08-05 12:19'
labels: []
milestone: m-6
dependencies: []
priority: high
type: feature
ordinal: 30000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up 3 (human-approved 2026-08-09), motivated by two live incidents in the committed log and history: seq 2, an eleven-minute amendment superseded after the dogfood pin correctly failed it, and the unsigned interregnum between commit f829e6c and its attestation, during which the edited policy was inoperative. One verb owns the ceremony: approval policy amend shows a semantic diff of the edited policy against the currently attested bytes (class resolutions that changed, approvers' channel reachability), runs load validation with advisory output (the seq 2 failure would have surfaced before attestation), supports --require-load to refuse attesting a policy that fails load, then attests, and prints or (--commit) runs the two-file git add/commit so the policy edit and its attestation land together. Absorbs and supersedes the earlier advisory-output follow-up. Human-only, same identity rules as attest.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval policy amend shows a semantic diff vs the attested bytes: per-class resolution changes (including classes newly falling to defaults) and approver channel reachability changes, computed by the real engine on both versions
- [ ] #2 Load validation runs with advisory output by default (a schema-invalid or fail-closed policy is reported loudly but may still be attested deliberately); --require-load refuses to attest on any load failure
- [ ] #3 On confirmation the verb attests (policy.updated with the new hash) and prints the exact two-file git add/commit commands, or runs them with --commit; the printed/executed commit message cites the attestation seq
- [ ] #4 Human-only with the attest identity rules; a dry-run mode shows everything and writes nothing; --json frozen; subprocess tests cover the seq-2-shaped incident (dogfood-breaking edit surfaced in the advisory before attestation)
<!-- AC:END -->
