---
id: APRV-333
title: Landing hero dot field stretches when the source-install details opens
status: Done
assignee:
  - '@claude'
created_date: '2026-09-13 22:30'
updated_date: '2026-09-13 22:31'
labels: []
dependencies: []
ordinal: 251000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On approval.md the hero dot-field canvas is height:100% of the hero, so opening the Latest features / contribute details grows the hero, stretches the canvas CSS box without re-rasterising it, and shifts the fade mask. Dots go oval and the field spills behind the expanded text. The field should keep its collapsed-hero size and re-render on toggle.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Opening the details leaves the dot field at the height it has when the details is closed, with dots at their normal pitch
- [x] #2 Closing the details restores the field to the same state
- [x] #3 No change to how the field looks with the details closed
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. In the field script, measure the hero minus the open details' body height. 2. Pin canvas.style.height to that and re-rasterise. 3. Re-run resize()+start() on the details toggle event. 4. Verify in a browser with the details open and closed.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Cause: #field is height:100% of .hero. Opening the details grows the hero; the canvas CSS box follows but the bitmap only re-rasterises on window resize, so dots stretch and the 52% fade line moves. Fix: fieldHeight() subtracts the open details' body (details height minus summary height) from the hero height, resize() pins canvas.style.height to that, and a toggle listener re-runs resize()+start(). Closed state is unchanged by construction (extra = 0, same h as before). Verified in the browser pane over a local http.server: with details open, hero 370px, canvas CSS height 280px, bitmap 560px at dpr 2, dots at normal pitch; initial closed render identical to before.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Pinned the hero dot-field canvas to the collapsed-hero height and re-rendered it on the source-install details toggle, so expanding Latest features / contribute no longer stretches the dots. Verified in a browser: canvas stays 280px while the hero grows to 370px.
<!-- SECTION:FINAL_SUMMARY:END -->
