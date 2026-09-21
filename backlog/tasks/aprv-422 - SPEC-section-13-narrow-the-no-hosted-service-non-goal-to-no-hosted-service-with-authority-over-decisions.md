---
id: APRV-422
title: >-
  SPEC section 13: narrow the no-hosted-service non-goal to no hosted service
  with authority over decisions
status: To Do
assignee: []
created_date: '2026-09-21 06:42'
labels:
  - spec
  - hosting
  - policy.edit
dependencies: []
priority: medium
ordinal: 323000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC.md section 13 lists as a non-goal: No hosted service (local-first; a sync story can come later). docs/proposals/hardened-authorization.md uses that clause to disqualify a hosted verifier, so it has teeth. GOVERNANCE.md already discloses that Bountify.ai operates a hosted daemon and reviewer layer, and design/hosted-daemon-identity.md states the hosting model. The clause and the practice now disagree. Proposed replacement: No hosted service with authority over decisions. A hosted process may deliver, render, transport, operate and, once decisions are independently signed by the approver (section 11 cryptographic identity), record. Below that level a hosted runtime operates under stated operator trust, and the local-first path remains complete without it. This keeps the local-first promise, admits relay and operated deployments under honest labels, and names signed decisions as the level at which the qualifier falls away. policy.edit.spec: the human applies and attests.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The section 13 sentence is replaced with wording equivalent to the proposal, cross-referencing section 11 and GOVERNANCE.md
- [ ] #2 docs/proposals/hardened-authorization.md's constraint 6 and its D3 row are updated to cite the new wording, or an explicit note says why D3 remains disqualified under it
- [ ] #3 approval policy attest --path SPEC.md is run by the human after the edit; the task notes record the attested seq
<!-- AC:END -->
