---
id: APRV-513
title: >-
  SEC-2: fleet-wide keys live in every sandbox's env; move them behind the control-plane broker and add dual-key rotation for CONTROL_PLANE_API_KEY
status: In Progress
assignee:
  - '@claude-approval'
created_date: '2026-10-12 15:55'
updated_date: '2026-10-12 15:55'
labels:
  - agent-village
  - security
dependencies: []
priority: high
ordinal: 391000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Same finding as SEC-1 (section 4 of the findings file): the fleet-wide Groq key and other shared keys are written into every sandbox's Hermes .env, so one box's compromise (for instance through an installed plugin) leaks them fleet-wide. The approval seat's custody proposal (APPROVAL-CUSTODY.md section 5) takes six keys out of tenantEnv and serves them through the broker instead. Separately, the control-plane API key used by the app was exposed (Carter accepted the exposure for now, 12 Oct) and must be rotatable with zero downtime: the control plane accepts CONTROL_PLANE_API_KEY_PREVIOUS for a grace period while the app moves to the new key.

Owner: the approval seat (cp credential custody is its area in the 12 Oct plan). Design note first (lanes-approval/SEC-2-design.md), build after the lead's okay, deploy via the release seat's cp row, after Tuesday 13 Oct.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Design note lanes-approval/SEC-2-design.md names the keys that leave tenantEnv, the broker routes that serve them, and the rotation sequence for CONTROL_PLANE_API_KEY; the lead okays it on CLAIMS
- [ ] #2 The shared keys named in the note are no longer written to any sandbox's .env; the broker serves them per request; tests pin that tenantEnv contains none of them
- [ ] #3 The control plane accepts CONTROL_PLANE_API_KEY and CONTROL_PLANE_API_KEY_PREVIOUS during a grace period and logs which one matched (names only, never values); a test pins the grace path and its expiry
- [ ] #4 Deployed by Carter's cp row; the exposed key is rotated through the dual-key path with no failed app request (read-back by the verify seat on the app and cp logs)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-12 15:55: filed by float@b1 from BACKLOG.md SEC-2 and briefs/claude-approval.md item 3 (OPS-1 follow-up).
<!-- SECTION:NOTES:END -->
