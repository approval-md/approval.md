---
id: APRV-142
title: >-
  Attestation/policy read TOCTOU: two unsynchronized APPROVAL.md reads per gate
  op (red-team F5, medium)
status: To Do
assignee: []
created_date: '2026-08-25 13:41'
labels:
  - security
  - hardening
  - cleanroom-review
dependencies: []
references:
  - ../approval-md-redteam (findings-report.md
  - F5)
  - src/core/gate.ts
  - src/core/attest.ts
priority: medium
type: bug
ordinal: 129000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
PLAUSIBLE, verified as a real window but narrow; the red-teams own race probe saw the file change mid-flight in 946/3000 attempts but observed 0 parser-side wins. A gate operation reads APPROVAL.md twice without synchronization (src/core/gate.ts around the attest-check and the parse, ~976-979), so in principle the attestation check and the policy parse can see different bytes. Fix direction: read the policy bytes once per gate operation and reuse the same buffer for both the attestation hash check and the parse, so a mid-operation file swap cannot split the decision. Low urgency given the narrow window, but cheap to make structurally impossible.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A gate operation reads APPROVAL.md bytes once and uses the same bytes for both the attestation check and the policy parse
- [ ] #2 Test asserts that a file swap between the two former read points cannot produce an attested-but-different parsed policy
- [ ] #3 npm test passes; lint clean
<!-- AC:END -->
