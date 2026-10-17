---
id: APRV-45
title: 'MILESTONES.md canonical map, guard test, standing rules'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 14:27'
updated_date: '2026-08-05 14:32'
labels: []
milestone: m-6
dependencies: []
priority: high
type: docs
ordinal: 45000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Human bookkeeping ruling: milestone ids drifted (m-3.1 virtual, m-4 deleted duplicate, m-5=M4, m-6=M4.1, m-7=M5); ids are never renumbered. MILESTONES.md becomes the canonical map (SPEC name, Backlog id, status, one-line scope); a guard test asserts every task milestone id appears in the map with matching display names; standing rules recorded: milestones are created only deliberately at decomposition, never via task-creation flags, and prose refers to milestones by SPEC name. Also: draft a short upstream Backlog.md issue on the implicit-creation footgun (the m-3.1 incident) for human review before filing.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 MILESTONES.md maps every milestone (incl. virtual m-3.1 and the removed m-4 duplicate, noted as such) with SPEC name, id, status, one-line scope
- [x] #2 A guard test asserts every task file milestone value appears in MILESTONES.md with a matching display name; drift fails npm test
- [x] #3 Standing rules stated in MILESTONES.md; upstream issue draft included for human review, not filed
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Fable-implemented inline. MILESTONES.md maps all eight milestones incl. virtual m-3.1 and retired m-4 with the three standing rules; tests/milestones-guard.test.ts asserts every task milestone id appears in the map and milestone file titles match display names; docs/upstream-backlog-issue.md drafts the implicit-creation footgun report with the real m-3.1/m-4 incident sequence, awaiting human review before filing. Prose-by-SPEC-name rule applies from now on; existing prose grandfathered.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
MILESTONES.md canonical map + drift guard test + standing rules + upstream issue draft. Verified: 952/952 at landing.
<!-- SECTION:FINAL_SUMMARY:END -->
