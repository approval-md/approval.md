---
id: APRV-444
title: Present Get Approved as a full-width hosted operations demo
status: In Progress
assignee:
  - '@codex'
created_date: '2026-09-30 15:27'
updated_date: '2026-09-30 16:10'
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
- [ ] #1 The Get Approved entry shows a wide desktop layout and a usable mobile layout without a nested iframe scrollbar.
- [x] #2 Iframe height messages are accepted only from the configured gateway origin and current iframe window, and only finite bounded heights can change the frame.
- [x] #3 The new-tab fallback works, and the deck and policy builder remain usable.
- [ ] #4 Local tests and rendered browser checks cover resizing, narrow screens, and existing entry controls.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Inspect existing entry and brand layout; widen only the Get Approved section; verify parent-child postMessage source and origin before applying bounded height; retain the new-tab link and test desktop/mobile plus deck and builder.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented a 1500px centered Get Approved canvas and finite iframe autoheight. Parent accepts height messages only from the configured gateway origin and current iframe window, clamps 520–30000px with a 4px border allowance, resets on close, and retains iframe scrolling beyond the cap. New-tab link, deck, and policy builder remain. Build and lint exit 0; CI-equivalent three test shards exited 0 (1800+1606+1976 passing, two expected skips), including Get Approved embed tests. Browser acceptance of the new published site and live resizing remains pending before AC1/AC4 and Done.
<!-- SECTION:NOTES:END -->
