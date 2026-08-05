---
id: APRV-30
title: 'approval policy amend: the one-verb amendment ceremony'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 12:19'
updated_date: '2026-08-05 12:40'
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
- [x] #1 approval policy amend shows a semantic diff vs the attested bytes: per-class resolution changes (including classes newly falling to defaults) and approver channel reachability changes, computed by the real engine on both versions
- [x] #2 Load validation runs with advisory output by default (a schema-invalid or fail-closed policy is reported loudly but may still be attested deliberately); --require-load refuses to attest on any load failure
- [x] #3 On confirmation the verb attests (policy.updated with the new hash) and prints the exact two-file git add/commit commands, or runs them with --commit; the printed/executed commit message cites the attestation seq
- [x] #4 Human-only with the attest identity rules; a dry-run mode shows everything and writes nothing; --json frozen; subprocess tests cover the seq-2-shaped incident (dogfood-breaking edit surfaced in the advisory before attestation)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent in isolated worktree; fable review found nothing to override. Flagged design accepted, for the human's eyes in the m-4.1 report: the diff baseline is git HEAD's blob used ONLY when its SHA-256 equals the attested hash (proving the diffed text is the signed-for text); everything else drops to hash-only mode with a loud notice, and there is deliberately no --baseline flag since an operator-supplied baseline is unverifiable. Diff probes = union of both versions' class keys + the ten section 7 namespaces via the real resolve(); approver reachability includes danglingRules (patterns naming a no-longer-defined approver — the only reachability hole a loadable policy can have, since the schema forbids empty channel lists); fail-closed sides render as everything-manual with structural sections marked incomparable rather than fake-empty. Both motivating incidents (seq 2; the f829e6c unsigned interregnum) cited in the module doc; the seq-2-shaped test proves the advisory surfaces a load failure before attestation and --require-load refuses with a byte-identical log. --commit preconditions checked before attestation; the commit carries exactly the two files with the seq in its message. Noted for watchlist, untouched by this task: the cli-token 1s-TTL timing test failed once under load in a baseline run (passes consistently since). Verified on merged tree: 839/839, lint, typecheck.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval policy amend: semantic diff (real-engine resolutions, approver reachability incl. dangling rules, defaults, budgets) against a hash-verified git baseline with honest hash-only fallback, load advisory with --require-load, attestation, and the two-file git ceremony citing the attestation seq. 30 subprocess tests incl. the seq-2 incident shape. Verified: 839/839, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
