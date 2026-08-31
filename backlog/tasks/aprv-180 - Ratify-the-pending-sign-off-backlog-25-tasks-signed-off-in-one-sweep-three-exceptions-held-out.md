---
id: APRV-180
title: >-
  Ratify the pending-sign-off backlog: 25 tasks signed off in one sweep, three
  exceptions held out
status: In Progress
assignee: []
created_date: '2026-08-31 23:08'
updated_date: '2026-08-31 23:11'
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
- [ ] #1 Every pending-sign-off marker except those of APRV-127, APRV-109, and APRV-58 reads (Amended APRV-n.), composite forms (40/58, 68/78, 88/103/105, the five §10.1 unpunctuated markers) handled correctly
- [ ] #2 Line 9's convention definition still shows the pending form verbatim as the convention text
- [ ] #3 grep -c "pending sign-off" SPEC.md equals the held-out marker count, stated in the notes
- [ ] #4 Every removal edit landed through a gate prompt; the grant seqs are cited in implementation notes as the ratification record
- [ ] #5 npm test (docs-guard included) and lint pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Inventory markers and confirm test/tooling pins of "pending sign-off" (grep tests/ src/ docs/).
2. Sweep via replace_all Edits so each gate prompt is small and legible: (a) ", pending sign-off.)" -> ".)" everywhere; (b) ", pending sign-off)" -> ")" for the §10.1 unpunctuated five; then restore the held-out forms: (c) line 9 convention text, (d) APRV-127 five markers, (e) APRV-109 marker, (f) the APRV-58 sentence. Each Edit is one Telegram tap; record grant seqs.
3. Verify remaining marker count = held-out set; npm test + lint; commit on the PR #161 branch and update the PR body.
<!-- SECTION:PLAN:END -->
