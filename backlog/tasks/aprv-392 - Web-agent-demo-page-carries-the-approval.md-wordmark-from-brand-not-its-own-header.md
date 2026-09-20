---
id: APRV-392
title: >-
  Web-agent demo page carries the approval.md wordmark from brand/, not its own
  header
status: Done
assignee:
  - '@claude'
created_date: '2026-09-19 23:47'
updated_date: '2026-09-20 00:16'
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
- [x] #1 The demo page header shows the brand/ wordmark, served locally, and the page renders offline with no external request
- [x] #2 rsi/index.html and the guest-mode variant use the same mark; a test or a docs-guard check pins that the served asset is the one under brand/
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read brand/wordmark.svg, brand/icon.svg, the demo page and server.mjs, rsi/index.html and the root index.html, and work out how the site composes the mark (page-font letters plus the bracket-tick glyph, viewBox 24 60 224 208, tick #17A15E).
2. Inline brand/wordmark.svg into the demo header verbatim, replacing the pages own <h1>approval<span>.md</span></h1>. Inline rather than link: the security contract at the top of server.mjs forbids a CDN and an external font, the page is projected behind a tunnel, and a second request is one more thing that can be missing in the room. Splice it with a script so the bytes are the assets exactly.
3. Size the asset box rather than the letters (--mark clamp(56px,9vw,88px), the type is 176/320 of the box), pull back the assets 72/1560 left margin so the mark starts on the pages left edge, and center the header row. The assets paper fill is this pages --paper to the byte, so the rest of the margin is invisible.
4. Leave rsi/index.html alone: it already draws the same geometry, with / rsi hung off the end, and its letters are set in the page font on purpose. Confirm the paths match the asset rather than rewriting them.
5. Add tests/demo-wordmark.test.ts: byte-identity of the inlined svg against brand/wordmark.svg, no external src/href/@import/stylesheet link anywhere on the demo page, public/ holds exactly one page (guest mode is an instance, not a second front end), and the two bracket paths plus the tick plus the green appear verbatim in index.html and rsi/index.html.
6. Render the page against a local static server and compare it with /rsi before and after. Four panels and the verify badge untouched.
7. npm run build, typecheck, lint, test; one commit on lane/demo-wordmark-392; PR against main.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The demo header is now brand/wordmark.svg itself, inlined into examples/web-agent-demo/public/index.html byte for byte, replacing the pages own <h1>approval<span>.md</span></h1>.

Inlined rather than served as a file from public/. Both shapes were open under AC1, and the deciding argument is the security contract at the top of server.mjs: it forbids a CDN and an external font because the page is projected behind a tunnel, sometimes on a room network and sometimes on none, so a header that costs a second request is a header that can be missing in front of an audience. Inlining also leaves that files route table untouched (it still serves exactly one path), which is worth more than a header, because every route on that server is part of a security argument. The asset was spliced in by script, not retyped, so the bytes are the assets exactly.

Sizing. The asset draws 176-unit type inside a 1560x320 box and carries its own paper margin on four sides, so the CSS sizes the BOX (--mark, clamp(56px,9vw,88px)): 88px of box puts the letters at the 48px the old h1 used, and the clamp tracks the one it replaced. The boxs fill is #F6F3EC, which is this pages --paper to the byte, so three of those margins are invisible. The fourth is not: 72/1560 of the width sits left of the a, and a negative margin of 72/320 of the box height pulls it back so the mark starts on the same left edge as the badge and the panels. The right margin is deliberately NOT pulled back, because where .md ends depends on the resolved monospace font and a negative margin there could overlap the meta line. header went from align-items:baseline to center, which is what an image-shaped h1 wants.

rsi/index.html was read and left alone. It already draws the same two bracket paths, the same tick and the same #17A15E, with / rsi hung off the end, and its letters are set in the page font on purpose, the same composition the landing page uses. Rewriting it to an inlined asset would have lost the / rsi lockup for no gain, so the change there is that the geometry is now pinned instead of merely matching.

The guest-mode variant is the same page. Guest mode is an instance (--instance guest, its own gate directory, its own empty vault), not a second front end: server.mjs is handed a --dir and serves this one file whichever instance that is. tests/demo-wordmark.test.ts pins that by asserting public/ holds exactly one page, so a second front end cannot appear without a mark check of its own.

Four panels and the verify badge are untouched; the diff is the header block and the h1 rules and nothing else.

Global invariants: none touched. No log path, no gate-typed event, no policy read, no protected path, no schema, no dependency.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The web-agent demo page wears brand/wordmark.svg, inlined byte for byte, instead of a header of its own; rsi/index.html already drew the same geometry and is now pinned to it.

Verified: tests/demo-wordmark.test.ts (4 new tests, all pass) pins the inlined svg byte-identical to brand/wordmark.svg, pins that the page carries no external src/href/@import/stylesheet link, pins that examples/web-agent-demo/public/ holds exactly one page (guest mode is an instance, not a second front end), and pins the two bracket paths, the tick and #17A15E verbatim in index.html and rsi/index.html. Rendered against a local static server and compared side by side with /rsi: the mark matches, it sits on the same left edge as the badge and the panels, and the four panels and the verify badge are unchanged. The browser network panel shows the loaded page making only its own same-origin /api/* polls, so the header costs no request and draws offline.

npm run build, npm run typecheck and npm run lint all exit 0. npm test: 4841 tests, 4818 pass, 22 fail, exit 1; every failure is the pre-existing local Node v26 SMTP class (adapter-email, smtp-probe, cli-setup email probes), one root cause, TLS servername refused on 127.0.0.1. CI on Node 22 is the truth.
<!-- SECTION:FINAL_SUMMARY:END -->
