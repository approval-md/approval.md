---
id: APRV-444
title: Present Get Approved as a full-width hosted operations demo
status: Done
assignee:
  - '@codex'
created_date: '2026-09-30 15:27'
updated_date: '2026-09-30 16:40'
labels: []
dependencies: []
type: enhancement
ordinal: 338000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A judge currently sees the private demo in a narrow fixed-height frame. Make the live entry readable as one continuous page while preserving the existing deck, policy builder, and a new-tab fallback. The embedded runtime remains an isolated session on one Maritime machine.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The Get Approved entry shows a wide desktop layout and a usable mobile layout without a nested iframe scrollbar.
- [x] #2 Iframe height messages are accepted only from the configured gateway origin and current iframe window, and only finite bounded heights can change the frame.
- [x] #3 The new-tab fallback works, and the deck and policy builder remain usable.
- [x] #4 Local tests and rendered browser checks cover resizing, narrow screens, and existing entry controls.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Inspect existing entry and brand layout; widen only the Get Approved section; verify parent-child postMessage source and origin before applying bounded height; retain the new-tab link and test desktop/mobile plus deck and builder.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented a 1500px centered Get Approved canvas and finite iframe autoheight. Parent accepts height messages only from the configured gateway origin and current iframe window, clamps 520–30000px with a 4px border allowance, resets on close, and retains iframe scrolling beyond the cap. New-tab link, deck, and policy builder remain. Build and lint exit 0; CI-equivalent three test shards exited 0 (1800+1606+1976 passing, two expected skips), including Get Approved embed tests. Browser acceptance of the new published site and live resizing remains pending before AC1/AC4 and Done.

Public Pages HTML matches reviewed source (SHA256 71f240ac46ffbe1c2f1f7c84bfee891441de8d7c100699751569f0b60b590bfc). PR561 merged as 3a612f0c9b6f562b7949a227cb7cf72d61968420 after all PR and Node20/22 merge-group gates passed. Desktop1440: section1408px; payload expansion grew frame1574 to2295px and collapsed back1574, with body and iframe viewport matching exactly. Mobile390: outer390/390, inner312/312, body/viewport3947/3947; visual inspection passed. App telemetry/live human decisions verified separately; exact current context and canonical payload remain accessible.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Published the wider Get Approved entry with authenticated origin/source-checked content sizing. Desktop and mobile public checks confirm frame growth and shrinkage without nested scrolling; deck, policy builder and new-tab fallback retained.
<!-- SECTION:FINAL_SUMMARY:END -->
