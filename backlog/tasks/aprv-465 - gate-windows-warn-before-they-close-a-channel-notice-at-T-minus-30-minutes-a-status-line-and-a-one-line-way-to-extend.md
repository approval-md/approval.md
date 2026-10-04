---
id: APRV-465
title: >-
  gate windows warn before they close: a channel notice at T minus 30 minutes, a
  status line, and a one-line way to extend
status: To Do
assignee: []
created_date: '2026-10-04 09:23'
labels:
  - ergonomics
dependencies: []
ordinal: 352000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Evidence 2026-10-04: the 24-hour window Carter opened on 2026-10-03 05:38Z lapsed at 05:38Z the next morning while three orchestrators were mid-work; the first sign was a clone request waiting nine minutes and failing, with no listener running to deliver the tap. Nothing announced the closure in advance and approval status did not show the window's remaining time.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The daemon sends one channel message (and prints one line) 30 minutes before a window closes and one when it closes, naming the time and the extend command
- [ ] #2 approval status and approval gate status print the open window's expiry and remaining time; the hook's refusal after closure says when the window closed
- [ ] #3 approval gate extend <duration> exists as the human's ceremony (same terminal rule as gate open) and is named in the warning
<!-- AC:END -->
