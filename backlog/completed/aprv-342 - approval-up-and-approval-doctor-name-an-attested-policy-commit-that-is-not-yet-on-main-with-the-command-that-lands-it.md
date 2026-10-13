---
id: APRV-342
title: >-
  approval up and approval doctor name an attested policy commit that is not yet
  on main, with the command that lands it
status: Done
assignee:
  - '@opus-lane-ergonomics'
created_date: '2026-09-16 17:59'
updated_date: '2026-09-17 01:32'
labels:
  - cli
  - doctor
  - ergonomics
dependencies: []
priority: medium
ordinal: 260000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
After a policy amend the attestation is in the log and the edited APPROVAL.md is in the working tree, and until the policy-amend branch merges, a fresh checkout of main carries the old policy without its attestation, where every gate operation refuses policy-not-attested. Today nothing between the amend and the merge says so: approval up ran its preflight on 2026-09-16 and reported only 'already at the remote tip', and doctor's attestation row passes because the local file is attested. Add a doctor row (and the same line in the up preflight) that compares the attested policy hash with the APPROVAL.md blob at origin/main: when they differ, report 'attested at seq N, not yet on main' with the one command that lands it (approval policy amend --pr once that exists, the runbook until then) or the open pull request if one is found for policy-amend-<seq>. Pass when the blobs match; not applicable when there is no attestation. Read-only: nothing here writes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A doctor row reports the attested policy hash versus the APPROVAL.md blob at origin/main, with the fix line naming the command or the open pull request; pass when equal, not applicable without an attestation
- [x] #2 approval up's preflight prints the same line when the two differ, and does not refuse on it
- [x] #3 Tests cover equal, differing, and no-attestation states through the real append path; docs/cli-reference.md lists the row
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. preflight.ts gains an exported checkAttestedPolicyOnMain, read-only: it takes the policy path, the log's verified records, the repo root and the remote branch, finds the latest attestation through core attest, hashes the APPROVAL.md blob at the remote tip, and answers a DoctorCheck. It lives beside checkMainBehindOrigin so doctor's row and the up line are one implementation.

2. Equal is pass, differing is fail with 'attested at seq N, not yet on main' plus a fix naming approval policy amend --pr, and the detail names policy-amend-<seq> when the remote-tracking ref for it exists, which is read from the last fetch and costs no network call. No attestation is a skip.

3. up and daemon pass a policy path into startupPreflight, which emits the same sentence as a preflight_policy event and never refuses on it.

4. Tests in tests-cli-up-preflight through the real append path: equal, differing, no attestation. Docs: the cli reference doctor rows.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented as checkAttestedPolicyOnMain in preflight.ts, beside checkMainBehindOrigin, so doctor's row and the up line are one implementation. It hashes the policy blob at the remote tip with core attest's policyBytesHash and compares it to the latest attestation's sha256. Read-only and networkless: the remote tip is the last fetch's remote-tracking ref, and the amend branch is looked for among those refs rather than asked of GitHub, because a report that reached the network to be more accurate would be acting on its own account.

The doctor roster grew from 29 to 30 rows and the fresh-directory skips from 18 to 19; tests-doctor-rows, the doctor suite's status list and the README prose the docs guard reads all move together. The new row skips outside a repository, with no remote-tracking ref, and with no attestation.

up and daemon pass a policy path into startupPreflight through a new shared preflightPolicyPath helper that resolves --policy, else --dir or cwd, against core policy-load's own POLICY_FILENAMES order, so the file compared is the file the runtime goes on to enforce. The line is emitted AFTER the fast-forward, because a merge that just landed the amendment is exactly the case where the answer changes; it is emitted only on a fail, and it never refuses. Cost: one whole-log verify at startup, in a process that reads the log on every tick.

SPEC 11.1: the comparison reads only verified records. The up line is built from verifyWithRecords and is skipped outright when the chain does not verify clean, so an unverifiable log produces no claim rather than a wrong one.

Verification: node scripts-run-tests --only cli-up-preflight is 43 tests, 43 pass, 0 fail, exit 0, with five new cases built through appendAttestation, the real append path: doctor passes when the remote carries the attested bytes, fails naming 'attested at seq 2, not yet on main' with the amend command and the policy-amend-2 branch, and skips with no attestation; up prints the same sentence and still exits 0; up says nothing when the hashes agree. A run over docs-guard, cli-doctor, cli-up-preflight, cli-help and cli-long-help is 166 tests, 166 pass, 0 fail, exit 0. Build, typecheck and lint exit 0.

Follow-up: the up line now answers the common case without opening the log. When the remote's copy of the policy is byte-identical to the one on disk, 'is the attested policy on the remote' has the same answer as 'is the policy on disk attested', which is doctor's attestation row and not this line's business, so the whole-log verify is skipped entirely. Doctor's row keeps the full check because it already holds the records.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A new doctor row, attested-policy-on-main, and the same sentence on approval up's preflight, compare the attested policy hash against the APPROVAL.md blob at the remote tip. They differ during the window between an amendment and its pull request merging, where a fresh checkout of main refuses every gate operation with policy-not-attested and nothing said so. Pass when equal, fail with 'attested at seq N, not yet on main' plus the amend command and the amend branch when the remote already carries it, not applicable without an attestation. Read-only and networkless, and up reports it without ever refusing. Verified by five new cases through the real append path: 43 tests, 43 pass, 0 fail, exit 0.
<!-- SECTION:FINAL_SUMMARY:END -->
