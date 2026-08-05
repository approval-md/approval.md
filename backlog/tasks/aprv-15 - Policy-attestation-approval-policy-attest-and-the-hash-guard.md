---
id: APRV-15
title: 'Policy attestation: approval policy attest and the hash guard'
status: To Do
assignee: []
created_date: '2026-08-05 01:00'
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
- [ ] #1 `approval policy attest` appends policy.updated carrying the policy file's SHA-256 (hash of the exact bytes) and the attesting human actor; CLI documents it as a human-only verb
- [ ] #2 checkAttestation(logRecords, policyPath) returns attested / not-attested / hash-mismatch as machine-readable statuses, comparing the live file hash against the latest policy.updated event
- [ ] #3 The refusal reason for gate operations is a distinct machine-readable code (not folded into generic policy failure), exported for APRV-16 to consume, with tests for: never attested, attested-then-edited, attested-then-re-attested
- [ ] #4 SPEC section 5.2 defines attestation and SPEC section 11 states the config-declared-identity / local-machine trust boundary plainly — both in the implementing commit, drafted wording flagged for human review
- [ ] #5 Determinism and read-only: attestation checking never writes; only the attest verb appends, through the real append path
<!-- AC:END -->
