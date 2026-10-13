---
id: APRV-180
title: >-
  Ratify the pending-sign-off backlog: 25 tasks signed off in one sweep, three
  exceptions held out
status: Done
assignee: []
created_date: '2026-08-31 23:08'
updated_date: '2026-08-31 23:50'
labels: []
dependencies: []
ordinal: 148000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC.md carries 55 (Amended APRV-n, pending sign-off.) markers from 28 tasks, accumulated since APRV-103 invented the convention (2026-08-20) with an entry path but no exit cadence. Carter decided 2026-08-31: ratify all, with exceptions held out for explicit decision, the removal edit prepared by an agent and signed off by the gate tap (SPEC.md is a protected path; the Telegram prompt shows each edit whole, and the tap is the maintainer act the convention requires). Exceptions keeping their suffix until Carter decides: APRV-127 (supervised-live/retro autonomy split, 5 markers, flagged pending in session notes), APRV-109 (attest-from-phone design, flagged likewise), APRV-58 (the audit.skew_tolerance sentence inside the APRV-40 paragraph, a default-value judgment). Everything else describes behavior already built, tested, and in daily use; the sweep ratifies reality. The sweep must run where the hook provably fires (APRV-151 discipline): a SPEC edit applying with no prompt is an incident.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every pending-sign-off marker except those of APRV-127, APRV-109, and APRV-58 reads (Amended APRV-n.), composite forms (40/58, 68/78, 88/103/105, the five §10.1 unpunctuated markers) handled correctly
- [x] #2 Line 9's convention definition still shows the pending form verbatim as the convention text
- [x] #3 grep -c "pending sign-off" SPEC.md equals the held-out marker count, stated in the notes
- [x] #4 Every removal edit landed through a gate prompt; the grant seqs are cited in implementation notes as the ratification record
- [x] #5 npm test (docs-guard included) and lint pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Inventory markers and confirm test/tooling pins of "pending sign-off" (grep tests/ src/ docs/).
2. Sweep via replace_all Edits so each gate prompt is small and legible: (a) ", pending sign-off.)" -> ".)" everywhere; (b) ", pending sign-off)" -> ")" for the §10.1 unpunctuated five; then restore the held-out forms: (c) line 9 convention text, (d) APRV-127 five markers, (e) APRV-109 marker, (f) the APRV-58 sentence. Each Edit is one Telegram tap; record grant seqs.
3. Verify remaining marker count = held-out set; npm test + lint; commit on the PR #161 branch and update the PR body.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Executed 2026-08-31 by fable inline (six Edit calls, each a small legible gate prompt; grant seqs 3934, 3942, 3949, 3960, 3981, 3995 in the primary log — the taps are the ratification record). Sweep: ", pending sign-off.)" -> ".)" replace_all (≈50 markers incl. the 40/58, 68/78 and 88/103/105 composites), then ", pending sign-off)" -> ")" for the five unpunctuated §10.1 markers. Restores: line 9 convention text verbatim; APRV-127 ×6 (lines 132,135,136,221,269,463); APRV-109 (line 391); the APRV-58 sentence (line 292). Remaining "pending sign-off" count is 9 (1 convention definition + 8 held-out markers), verified by grep. No test, src, docs or examples file pins the phrase; docs-guard 6/6, oxlint clean; the full gate runs on PR #161, which this rides (Carter's batching rule). Process note, from Carter live during the sweep: six sequential prompts without a legend were confusing on the phone — the old listener rendering lacks the gloss/claimed improvements of APRV-161..165, and future multi-edit ceremonies should send Carter a legend in chat BEFORE the first prompt fires.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
All pending-sign-off markers except APRV-127, APRV-109 and APRV-58 now read (Amended APRV-n.); six gate grants (seqs 3934-3995) are the sign-off record; line 9 keeps the convention text. Verified by marker grep (9 remain: 1 definition + 8 held out), docs-guard, lint.
<!-- SECTION:FINAL_SUMMARY:END -->
