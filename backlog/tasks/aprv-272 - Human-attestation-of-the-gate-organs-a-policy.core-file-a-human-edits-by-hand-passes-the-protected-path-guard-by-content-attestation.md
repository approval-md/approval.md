---
id: APRV-272
title: >-
  Human attestation of the gate organs: a policy.core file a human edits by hand
  passes the protected-path guard by content attestation
status: Done
assignee:
  - '@claude'
created_date: '2026-09-05 19:31'
updated_date: '2026-09-05 20:44'
labels: []
dependencies: []
references:
  - scripts/protected-path-guard.mjs
  - src/core/protected-path-guard.ts
  - src/core/attest.ts
  - 'https://github.com/approval-md/approval.md/pull/300'
priority: high
ordinal: 202000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
PR #300 (the human-committed PostToolUse entries in .claude/settings.json) failed the protected-path guard, and under the rules as built it cannot pass: the file is policy.core, the gate refuses to mint any record for a human-only class (class-human-only, nothing appended), so the granted-file and granted-command verdicts can never exist for it, and the attested verdict is wired to the policy file alone. Both earlier hook-file commits (APRV-83, APRV-133) predate the guard (APRV-151), which is why nobody hit this. The runtime already has the right primitive: attestation records that a human saw these exact bytes, needs no grant, and is content-level. Extend it to the gate organs (.claude/settings.json, .cursor/hooks.json, .cursor/hooks/, .cursor/agents/, and whatever else the classifier routes to policy.core outside .approval/): a human runs one verb, the log carries the digest, and the guard passes the path when the blob at head hashes to a digest a human attested. The record must not be mistaken for a policy attestation by the gate: whatever shape is chosen (a policy.updated with the organ path in file, or a distinct event), the gate latest-attestation lookup for APPROVAL.md must ignore organ records, with a test that proves an organ attestation neither makes an unattested policy operative nor invalidates a standing one. SPEC 5.2 and 8 amendment, marked pending sign-off. Until this lands PR #300 stays blocked; when it lands Carter attests the settings file once, the daemon advance carries the record to a records branch, and the guard-rerun workflow clears the check.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A human-only verb (for example `approval policy attest --organ <path>`, agent actors refused at exit 2) appends an attestation carrying the organ path and the SHA-256 of its bytes; the runtime computes the digest, the caller supplies no hash
- [x] #2 The gate latest-attestation lookup ignores organ attestations: tests show an organ record neither makes an unattested policy operative nor changes policy_sha256 on requests and grants
- [x] #3 The protected-path guard passes a guarded path when the blob at head hashes to a digest a human attested for that same path, reported as attested with the seq; a digest attested for another path is not evidence; the failure text for a policy.core path names the attest verb as the human route
- [x] #4 approval doctor gains an informational row listing gate organs whose current bytes carry no attestation, so a hand edit is visible before a PR fails
- [x] #5 SPEC 5.2 and 8 amended and marked pending sign-off; docs/claude-code-hook.md Installing it and the backstop section describe the human route; schema fixtures cover the record
- [x] #6 npm test, lint, typecheck pass; the guard run on this repository over origin/main~20..origin/main still passes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. A distinct event gate.organ.attested (human actor only; payload organ_path, repo-relative, and sha256 computed by the runtime), so every policy.updated reader is untouched by construction. 2. approval policy attest --organ <path>: one path per call, must classify policy.core outside the approval home and not be the policy file; agent and system actors refused; --json. 3. Guard: an organ passes as attested when its blob at head hashes to a digest attested for that same path; other-path digests and stale digests fail; the script computes per-path digests at head; the failure text names the human route. 4. Doctor row gate-organs, informational. 5. SPEC 5.2 and 8, docs, schema fixtures, conformance vectors, tests.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built by an Opus lane whose session died before it could report; the tree was reviewed on disk. Record shape: a distinct event gate.organ.attested rather than a policy.updated variant, so the gate's latest-attestation lookup cannot see an organ record; tests prove an organ attestation neither makes an unattested policy operative nor changes policy_sha256 on requests and grants. Organ set is the classifier's policy.core surface outside the approval home (the settings file, the Cursor hooks and agents). Verb refusals: policy file (own code), approval home, ordinary file, absolute or .. path, agent or system actor. Guard verdict is path-bound: a digest attested for another organ is never evidence, and editing after attestation leaves the new bytes unattested. Doctor gate-organs row is informational. SPEC 5.2 paragraph and 8 enum sentence marked pending sign-off. Touches 11.1: human-only classes stay inert to agents (the verb refuses agent actors twice, CLI and core); the log stays append-only; the guard reads verified records only.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval policy attest --organ <path> appends a distinct gate.organ.attested record (human only, runtime-computed digest); the guard passes an organ whose head bytes hash to a digest attested for that same path; doctor gains gate-organs; SPEC 5.2 and 8 amended pending sign-off. Verified by the full suite (0 fail), lint and typecheck, and the guard over main's last twenty commits; the gate-isolation tests drive the real gate.
<!-- SECTION:FINAL_SUMMARY:END -->
