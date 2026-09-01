---
id: APRV-171
title: 'Demo frontend: restyle to the site''s paper theme'
status: Done
assignee:
  - '@claude'
created_date: '2026-08-31 01:13'
updated_date: '2026-08-31 02:27'
labels:
  - demo
dependencies: []
ordinal: 150000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Approved plan: examples/web-agent-demo/public/index.html swaps its projector-dark tokens for the landing page's paper/ink/green all-mono theme (palette and idioms as recorded in APRV-170's description). Log and transcript views become inverted ink terminal blocks (the landing page idiom); ok/bad/warn semantics map to green #17A15E / rust #B4552D / a muted amber. Behavior, element ids, and API contracts unchanged; the APRV-158 e2e twin must stay green untouched.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Visual match to index.html tokens and idioms (mono stack, cards, headings, inverted log blocks)
- [x] #2 No behavioral change: all APRV-158 tests green without edits to the test file
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read index.html tokens + current demo page. 2. Retheme public/index.html to paper, behavior/ids untouched. 3. APRV-158 twin green unchanged.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built by an Opus subagent on branch demo-paper-restyle (base 64f9d0a), commit 8aeabd0, reviewed by fable. public/index.html +170/-79: landing-page tokens and idioms throughout; log/transcript views as inverted ink blocks with the landing .log palette; gate tool calls green-on-ink bold; waiting banner ink-on-amber-wash. e2e twin green with zero test edits (run twice). Accepted divergences, each commented in-file: .wrap keeps its demo meaning (scroll container) with the page column on body max-width 960px; three colors outside the landing set (muted amber #A97C21+wash for waiting/ttl, lighter rust #E08A5E because #B4552D is unreadable on ink, #2c2e33 table rules on ink); agent actors --mut / humans green-bold since the landing palette has no blue; old variable names retained as aliases so either vocabulary lands on the same color.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Demo frontend reskinned to the site's paper theme, behavior and ids untouched; APRV-158 twin green unedited; divergences from the strict palette are minimal, legibility-driven, and commented.
<!-- SECTION:FINAL_SUMMARY:END -->
