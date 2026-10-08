---
id: APRV-388
title: >-
  Landing APPROVAL.md terminal graphic retypes forever; it should fill once and
  stay readable
status: Done
assignee:
  - '@claude'
created_date: '2026-09-19 20:56'
updated_date: '2026-09-19 21:11'
labels: []
dependencies: []
type: enhancement
ordinal: 299000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The APPROVAL.md terminal on the landing page (graphic B) types the example file character by character, waits 2.4 s, wipes it and starts again, and also restarts every time it scrolls back into view. Nobody can read the policy it is showing. It should type once, then stay filled so the example reads as a document; leaving and returning to the viewport must not wipe it. While there, the example's approver changes from carter to alice so the sample policy reads as a sample.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The terminal types the file once on first entering the viewport and remains fully shown afterwards
- [x] #2 Scrolling away and back does not clear or retype the file; a pass interrupted mid-type resumes from where it stopped
- [ ] #3 Reduced-motion behaviour is unchanged: the file is shown in full at once
- [x] #4 The example APPROVAL.md names alice as the approver, with the surrounding prose and llms text consistent
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Replaced the pass/cycle loop (type, wait 2.4 s, wipe, retype; restart on every re-entry) with resume/pause: typed counts characters shown, resume() continues from that count with startedAt offset back by typed*MS_PER_CHAR, pause() cancels the frame. Once typed reaches the end nothing runs again. The reduced-motion branch (still: reveal all at once) is untouched but not re-exercised, since the browser pane cannot emulate prefers-reduced-motion, so AC3 stays unchecked. Approver renamed carter to alice in the approvers map, the manual class line, and the granted-event actor in graphic C so the sample stays consistent; llms.txt and llms-full.txt do not carry the sample.

Verification in the built-in browser: after scrolling the terminal into view the live pre reaches 936/936 characters (the ghost length); scrolling to the top and back leaves it at 936 with no retype; the rendered text contains approvers: [alice].
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The APPROVAL.md terminal now types once and stays filled, pausing and resuming if it leaves the viewport mid-pass; the example approver is alice. Verified by DOM measurement in the built-in browser across a scroll away and back.
<!-- SECTION:FINAL_SUMMARY:END -->
