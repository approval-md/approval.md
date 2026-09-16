---
id: APRV-342
title: >-
  approval up and approval doctor name an attested policy commit that is not yet
  on main, with the command that lands it
status: To Do
assignee: []
created_date: '2026-09-16 17:59'
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
- [ ] #1 A doctor row reports the attested policy hash versus the APPROVAL.md blob at origin/main, with the fix line naming the command or the open pull request; pass when equal, not applicable without an attestation
- [ ] #2 approval up's preflight prints the same line when the two differ, and does not refuse on it
- [ ] #3 Tests cover equal, differing, and no-attestation states through the real append path; docs/cli-reference.md lists the row
<!-- AC:END -->
