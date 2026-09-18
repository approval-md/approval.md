---
id: APRV-364
title: >-
  Bridge proves the Codex auto-reviewer is off before it runs, and refuses when
  it is not: a preflight and a doctor row
status: To Do
assignee: []
created_date: '2026-09-18 01:30'
labels:
  - codex
  - bridge
  - doctor
dependencies:
  - APRV-361
priority: high
ordinal: 281000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From docs/codex-app-server-bridge.md follow-up 4 (APRV-349). A server-side auto-reviewer (guardian) runs before the client path and can resolve an approval with a model call, telling the client afterwards through item/autoApprovalReview notifications. Zero were observed on 2026-09-18 under the operator configuration, which says nothing about other configurations. A session with a reviewer in front of the gate is one whose silence means nothing, so the bridge preflight must establish it is off (from the effective configuration the app-server exposes, or by a probe turn) and refuse to run otherwise, and approval doctor gains a row reporting the same fact while a bridge is live. Any autoApprovalReview notification seen mid-session is recorded as an audit event and stops the bridge.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Bridge start refuses with a distinct code when the auto-reviewer cannot be shown off
- [ ] #2 An autoApprovalReview notification during a session appends an audit record and ends the bridge session
- [ ] #3 approval doctor shows a codex-auto-reviewer row with pass, fail or skip and a fix
<!-- AC:END -->
