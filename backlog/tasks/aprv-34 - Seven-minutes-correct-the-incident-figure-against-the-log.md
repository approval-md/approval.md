---
id: APRV-34
title: 'Seven minutes: correct the incident figure against the log'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 13:46'
updated_date: '2026-08-05 13:47'
labels: []
milestone: m-6
dependencies: []
priority: medium
type: docs
ordinal: 34000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Human ruling (2026-08-10): the log is authoritative — seq 2 at 11:56:07 to seq 3 at 12:03:35 is seven minutes, not the misremembered eleven. Correct README.md and amend.ts module header, and add one README sentence noting the figure was corrected against the log after being misremembered, because that correction is itself the thesis.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 README and amend.ts say seven minutes, citing the chain timestamps
- [x] #2 README notes the correction-against-the-log itself
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
README and amend.ts corrected to seven minutes with chain timestamps cited; README notes the correction-against-the-log as the thesis in action. Guard regex tolerant of both wordings; suite 900/900.
<!-- SECTION:FINAL_SUMMARY:END -->
