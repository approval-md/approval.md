---
id: APRV-34
title: 'Seven minutes: correct the incident figure against the log'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 13:46'
updated_date: '2026-08-05 14:31'
labels: []
milestone: m-6
dependencies: []
priority: medium
type: docs
ordinal: 34000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Human ruling (2026-08-05): the log is authoritative — seq 2 at 11:56:07 to seq 3 at 12:03:35 is seven minutes, not the misremembered eleven. Correct README.md and amend.ts module header, and add one README sentence noting the figure was corrected against the log after being misremembered, because that correction is itself the thesis.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 README and amend.ts say seven minutes, citing the chain timestamps
- [x] #2 README notes the correction-against-the-log itself
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Date corrected in place per the 2026-08-05 human ruling (bookkeeping item 2): the description previously claimed 2026-08-10; this task's own created_date (2026-08-05 13:48) is the cited source. The wrong date was orchestrator confabulation, part of a systematic drift reported in APRV-46.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
README and amend.ts corrected to seven minutes with chain timestamps cited; README notes the correction-against-the-log as the thesis in action. Guard regex tolerant of both wordings; suite 900/900.
<!-- SECTION:FINAL_SUMMARY:END -->
