---
id: APRV-454
title: >-
  SPEC attestation batch: 383, 415, 421, 422, 423, 424, 428 and 445 in one
  ceremony
status: To Do
assignee: []
created_date: '2026-10-03 03:50'
labels:
  - spec
  - policy.edit
dependencies: []
references:
  - private/agentvillage-integration/06-gap-register.md
priority: medium
ordinal: 342000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The 2026-09-22 handover asked for one SPEC attestation batch (383 plus 421 plus 423 plus the 422 draft, no fourth copy). Since then APRV-424 (webhook, section 10.3), APRV-428 (section 11.2 preamble naming wait), APRV-415 (section 10.1 hermes row and the section 11.1 organ list with the .hermes spelling caveat) and APRV-445 (section 5.2 agent-requestable classes, section 9 payload store modes, section 10.1 propose and start, seven section 11.2 rows) added hunks, and PR 569 edited the spec file outside this repo's gate with pending-sign-off markers. Build the combined diff from each task's proposed hunk text, apply it on a branch, and hand Carter the one attestation ceremony. The section 13 wording for 422 is: No hosted service with authority over decisions. A hosted process may deliver, render, transport, operate and, once decisions are independently signed by the approver, record. Context: private/agentvillage-integration/06-gap-register.md G8.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 One branch carries every listed hunk applied verbatim from its source (design/hosted-daemon-identity.md section 7, APRV-421 notes, APRV-423 notes, APRV-424 notes, APRV-428 notes, docs/hermes-hook.md SPEC status section, PR 569's spec diff, the 422 wording) with the pending-sign-off markers removed and one Amended marker per task
- [ ] #2 The diff is reviewed against each source hunk by a verifier and the docs guard and conformance suites pass
- [ ] #3 Carter attests with approval policy attest --path and the policy.updated record for the spec file lands; the task notes record the seq
<!-- AC:END -->
