---
id: APRV-170
title: 'rsi: event page at approval.md/rsi, site-styled, with day-of live connect'
status: Done
assignee:
  - '@claude'
created_date: '2026-08-31 01:11'
updated_date: '2026-08-31 02:25'
labels:
  - demo
  - site
dependencies: []
ordinal: 149000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Approved plan (2026-08-31, plan file anything-we-can-do-nested-elephant): a self-contained rsi/index.html at the repo root publishes https://approval.md/rsi via existing GitHub Pages (CNAME + .nojekyll, root serving; rsi/index.html gives /rsi/). Styled to match index.html exactly: paper #F6F3EC / ink #17191D / green #17A15E / muted #8A857B / hairline #E3DED2 / card #FDFCF8 / rust #B4552D, all-mono JetBrains Mono-led local stack, 760px column, uppercase letter-spaced h2, inverted ink terminal blocks, wordmark glyph paths inlined (never <img> brand/wordmark.svg, it bakes a background rect). Content: what the demo is, the four beats, a watch-live section with a connect box where the day-of quick-tunnel URL is pasted (persisted per-viewer in localStorage under try/catch); with a URL set the page polls <url>/api/state and renders queue, log tail (inverted block), and verify badge. Placeholder section for connect-your-agent (activates with the crowd-MCP track). No external requests of any kind.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 rsi/index.html exists at repo root, fully self-contained, tokens and idioms matching index.html side by side
- [x] #2 With no URL set the page is a complete static explainer; with a URL pasted it renders live queue/log/verify from /api/state and survives the URL being unreachable
- [x] #3 localStorage use is try/catch wrapped and the page works with storage unavailable
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read index.html in full (tokens, idioms, wordmark glyph paths). 2. Build rsi/index.html: explainer + four beats + connect box (localStorage, try/catch) + live /api/state polling with landing-page idioms. 3. Verify against a locally served demo instance and with no URL set.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built by an Opus subagent on branch rsi-page (base 64f9d0a, the merged demo stack), reviewed by fable. rsi/index.html, 403 lines, fully self-contained (grep proves zero subresources; the only https:// strings are the SVG namespace, placeholder/example text, and the two footer links). Verified against three canned /api/state stubs via the browser pane: no-URL (static explainer complete), bad-URL (quiet offline line, retrying), clean (green badge, queue rows incl. rust expired TTL, inverted log newest-first), torn (rust NOT-verified, sections degrade individually), empty; localStorage reconnect + Clear verified, all storage access try/catch; 375px no horizontal overflow. Divergences accepted in review: offline hides the badge entirely (the badge speaks only about the chain); one named token --rust for a hex the landing page already uses inline; footer right slot reads RSI Harnesses hack. Live cross-origin render completes once APRV-172's CORS lands (built in parallel, same PR wave).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
rsi/index.html: the approval.md/rsi event page in the site's paper theme with inlined wordmark, four-beat explainer, and a connect box that lights up live queue/log/verify from a pasted day-of tunnel URL. Verified across connected/offline/torn/empty states via stubs and the browser pane; zero external requests.
<!-- SECTION:FINAL_SUMMARY:END -->
