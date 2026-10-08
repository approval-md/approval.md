---
id: APRV-387
title: >-
  Landing wordmark bracket invisible in dark mode; site has no favicon or share
  image
status: Done
assignee:
  - '@claude'
created_date: '2026-09-19 20:51'
updated_date: '2026-09-19 21:10'
labels: []
dependencies: []
type: bug
ordinal: 298000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On approval.md in dark mode the checked-box glyph that stands in for the o in the wordmark is invisible: the header SVG paths carry class bx but the landing page has no .mark .bx fill rule, so they take SVG's default black fill against the dark wall. The features page and judgy pages have the rule; rsi is light-only. Separately, no page on the site declares a tab icon, an Apple touch icon, a web manifest, or an og:image, so browser tabs show the generic globe and link shares (iMessage, Slack, X, LinkedIn) have no picture. The icon should be the brand's checked bracket glyph, served in the formats every browser and share crawler needs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 In dark mode and light mode on approval.md the bracket glyph in the header wordmark renders in the text colour with the green tick
- [x] #2 Every page under approval.md (landing, features, rsi, judgy, judgy live, judgy research) declares an SVG favicon, an ICO fallback, an Apple touch icon and a web manifest, all served from the site root
- [x] #3 The landing and features pages declare og:image and twitter:image with absolute URLs pointing at a 1200x630 PNG in the repo, and the twitter card is summary_large_image
- [x] #4 The icon assets exist in the repo and the ICO contains 16, 32 and 48 px layers
- [x] #5 Verified in a browser: tab icon shows the checked bracket, wordmark visible in both themes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. index.html: add .mark .bx{fill:currentColor} so the glyph follows the text colour in both themes. 2. brand/icon.svg: square master, paper tile, ink brackets, green tick. 3. Rasterise in the built-in browser (canvas export; the hook has no rule for rsvg-convert or magick) and package favicon.ico (16/32/48, PNG entries) with scripts/build-favicon-ico.mjs; favicon.svg, apple-touch-icon.png (180), icon-192.png, icon-512.png, site.webmanifest at the repo root (GitHub Pages serves root). 4. og-image.png 1200x630 rendered the same way so JetBrains Mono is real. 5. Head tags on all six pages, absolute root paths; og:image + twitter:image + summary_large_image on landing and features. 6. Verify in the built-in browser via scripts/site-serve.mjs, both themes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Cause: the landing header SVG paths carry class bx but index.html had no .mark .bx rule (features/ and judgy/ have one), so the brackets took SVG's default black fill against the dark wall. Fix is one line: .mark .bx{fill:currentColor}, so the glyph follows the text colour in both themes and on hover. rsi/ is paper-only and hardcodes ink, left alone.

Icon set: brand/icon.svg is the square master (paper tile, ink brackets, green tick, the same paths as the wordmark). Served from the repo root because GitHub Pages serves root and every page links them by absolute path: favicon.svg (Chrome, Firefox, Edge), favicon.ico with 16/32/48 PNG entries (Safari, which ignores SVG favicons, and old browsers), apple-touch-icon.png 180 (iOS home screen and Safari tab groups), icon-192/512 via site.webmanifest (Android, PWA installs). ICO is listed first with sizes=48x48 so Chrome still prefers the SVG. og-image.png 1200x630 plus og:image:*, twitter:card summary_large_image and twitter:image on the landing and features pages, absolute URLs as the crawlers require; judgy and rsi keep their own identity and only get the tab icon.

Toolchain: the hook has no rule for rsvg-convert, magick, xxd or od, so rasterising happens in the built-in browser. brand/render-assets.html draws every size on canvas with the real JetBrains Mono web font; scripts/site-serve.mjs (new, dev-only static server, also the site preview for .claude/launch.json) accepts POST /sink/<name>.png into brand/out/ only when started with --sink; scripts/build-site-icons.mjs copies the renders into place and scripts/build-favicon-ico.mjs packs the ICO (PNG-compressed entries, read by every current browser). brand/out/ is gitignored. Regenerating: node scripts/site-serve.mjs 8788 --sink, open /brand/render-assets.html?sink, node scripts/build-site-icons.mjs. First render hung the glyph from the text box top; Carter spotted it high, fixed to sit the bracket foot on the baseline as the header does.

Verification: served with scripts/site-serve.mjs in the built-in browser, dark and light colour-scheme emulation: bracket visible in both, green tick present; fetch of all seven assets returns 200 with the right content types; head tags present on all six pages. npm run lint clean. npm test: one pre-existing failure in tests/smtp-probe.test.ts (an authentication failure is smtp-535, gets smtp-protocol-error) that also fails alone and touches nothing in this diff; CI on main is green, so it reads as local environment.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Fixed the invisible wordmark bracket in dark mode with a .mark .bx fill rule; added a full icon set (SVG, ICO 16/32/48, Apple touch, manifest PNGs) and a 1200x630 share card with og:image and twitter:image tags, rendered from the brand glyph in the browser via new dev scripts. Verified in the built-in browser in both themes and by fetching every asset.
<!-- SECTION:FINAL_SUMMARY:END -->
