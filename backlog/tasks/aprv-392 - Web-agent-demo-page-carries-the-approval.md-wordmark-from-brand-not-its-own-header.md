---
id: APRV-392
title: >-
  Web-agent demo page carries the approval.md wordmark from brand/, not its own
  header
status: To Do
assignee: []
created_date: '2026-09-19 23:47'
labels:
  - demo
  - brand
dependencies: []
priority: low
ordinal: 302000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter noticed during the 2026-09-19 rehearsal that the demo page served by examples/web-agent-demo/server.mjs (examples/web-agent-demo/public) shows a header of its own rather than the wordmark under brand/. The page is projected at demos and is the first thing an audience sees, so it should carry the same mark as approval.md. Use the asset from brand/ (inline SVG or a file the server serves from public/, no external fetch, the page must work offline and behind a tunnel), keep the four panels and the verify badge as they are, and check the rsi/index.html and the guest-mode page for the same header so all three match.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The demo page header shows the brand/ wordmark, served locally, and the page renders offline with no external request
- [ ] #2 rsi/index.html and the guest-mode variant use the same mark; a test or a docs-guard check pins that the served asset is the one under brand/
<!-- AC:END -->
