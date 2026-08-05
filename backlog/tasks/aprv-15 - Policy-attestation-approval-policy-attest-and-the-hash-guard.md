---
id: APRV-15
title: 'Policy attestation: approval policy attest and the hash guard'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 01:00'
updated_date: '2026-08-05 01:14'
labels: []
milestone: m-3
dependencies: []
priority: high
type: feature
ordinal: 15000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Formalizes SPEC section 5.2's mtime/hash guard, per the human-settled design (2026-08-06): a new human-only verb `approval policy attest` appends a policy.updated event carrying the live policy file's SHA-256. Every gate operation — request intake, grant recording, token minting — MUST refuse with a distinct machine-readable reason when the live file's hash differs from the latest attestation, or when no attestation exists. This is what makes "agents cannot modify APPROVAL.md" mechanical: an edited policy is simply inoperative until a human re-attests. Two SPEC edits land same-commit: section 5.2 gains the attestation definition, and section 11 states plainly that human identity is config-declared and the trust boundary is the local machine (no pretense of stronger identity). Amendment wording is drafted in this task and flagged for human review, per the duration-grammar precedent — the design is pre-approved, the prose is not yet.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `approval policy attest` appends policy.updated carrying the policy file's SHA-256 (hash of the exact bytes) and the attesting human actor; CLI documents it as a human-only verb
- [x] #2 checkAttestation(logRecords, policyPath) returns attested / not-attested / hash-mismatch as machine-readable statuses, comparing the live file hash against the latest policy.updated event
- [x] #3 The refusal reason for gate operations is a distinct machine-readable code (not folded into generic policy failure), exported for APRV-16 to consume, with tests for: never attested, attested-then-edited, attested-then-re-attested
- [x] #4 SPEC section 5.2 defines attestation and SPEC section 11 states the config-declared-identity / local-machine trust boundary plainly — both in the implementing commit, drafted wording flagged for human review
- [x] #5 Determinism and read-only: attestation checking never writes; only the attest verb appends, through the real append path
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/core/attest.ts: policyFileHash (SHA-256 of exact bytes), checkAttestation(records, policyPath) -> attested | not-attested | hash-mismatch (+ attested hash, event seq); refusal code exported for APRV-16.
2. CLI: approval policy attest [--policy <path>] [--json] appending policy.updated {payload: {sha256}} with human actor from config — actor identity source designed here (config-declared, local trust boundary), documented plainly.
3. SPEC 5.2 attestation definition + section 11 trust-boundary statement, drafted wording flagged for human review, same commit.
4. Tests: never-attested, attest-then-edit (mismatch), re-attest heals, check is read-only, attest via real append path.
5. Opus subagent (isolated worktree, parallel with APRV-14); fable reviews, merges, gates, finalizes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent in isolated worktree; fable review found nothing to override. Both drafted SPEC paragraphs (section 5.2 attestation mechanics; section 11 config-declared identity / local-machine trust boundary, "someone with local control, not who") landed same-commit — wording awaits human review at the M3 report. Accepted decisions (all documented): actor refusal reuses AppendErrorCode "validation" since log.ts is a closed union this task may not edit (dedicated code flagged as possible follow-up); corrupt-tail on attest maps to exit 3 not 4 (3 is the frozen torn-tail meaning; calling it io would misdescribe a crashed write); payload.policy_path is the basename so exported logs never bake in a home directory; checkAttestation compares bytes only, deliberately not filtering by filename, so APPROVALS/APPROVAL drift surfaces as mismatch; unreadable outranks not-attested; a non-human --as never falls back to env; discovery stops on an unreadable candidate rather than silently attesting the fallback file; clock read only at the CLI edge. Smoke: attest of the real APPROVAL.md produced sha256 c218ecd0...70cf9d, byte-identical to the dogfood suite pin. Verified on merged tree: 477/477, lint, typecheck green.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval policy attest (human-only, config-declared identity) + src/core/attest.ts: policyFileHash, appendAttestation (human-actor enforced), checkAttestation (attested/not-attested/hash-mismatch/unreadable), and the exported policy-not-attested refusal APRV-16 consumes; both SPEC paragraphs same-commit as drafts for review. 37 tests. Verified: 477/477, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
