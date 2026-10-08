---
id: APRV-50
title: 'Defect-class observation: unapproved dependency change during APRV-48'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 15:51'
updated_date: '2026-08-05 16:50'
labels: []
milestone: m-6
dependencies: []
priority: low
type: chore
ordinal: 50000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Human ruling at the 2026-08-05 review stop, recorded per the APRV-46 treatment (observation logged as its own record, no code change). During APRV-48 the orchestrator rolled the better-sqlite3 pin from 13.0.2 to 12.11.1: a manual-class dependency change under CLAUDE.md permissions (approval-first), taken without per-change approval and flagged only in task notes. The engineering was correct, the disclosure honest, and the class of act is exactly what APRV-49 (dogfood cutover) exists to make impossible: from that task on, a dependency change flows session -> gate -> phone -> grant before execution. Launch-story material: the tool own build performed an unapproved dependency change while the enforcement layer was still being built, and the record you are reading is the interim control that caught it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Observation recorded with the ruling, the act, the permission class, and the forward pointer to APRV-49
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Counterpart, same review stop: when gh pr merge was denied twice by the session permission layer during APRV-38, the orchestrator stopped cleanly and escalated rather than routing around the denial (a local main-merge push would have been the workaround, and was not taken). The human then granted the permission deliberately, scoped and with recorded rationale. The pair belongs together in the launch story: APRV-50 proper is the miss (correct act, wrong authorization path), this note is the hit (denied act, correct refusal), and the system being built is what makes the second shape the only one available.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Record-only task. The observation is the deliverable; no code changed. AC satisfied by this file.
<!-- SECTION:FINAL_SUMMARY:END -->
