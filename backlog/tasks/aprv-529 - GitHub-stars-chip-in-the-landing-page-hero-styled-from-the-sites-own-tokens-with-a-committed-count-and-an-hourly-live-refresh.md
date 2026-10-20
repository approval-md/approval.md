---
id: APRV-529
title: >-
  GitHub stars chip in the landing page hero, styled from the site's own tokens,
  with a committed count and an hourly live refresh
status: In Progress
assignee:
  - '@claude'
created_date: '2026-10-20 07:27'
updated_date: '2026-10-20 07:33'
labels:
  - site
dependencies: []
priority: low
ordinal: 404000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter (2026-10-20): tokenmaxxing.fyi shows its GitHub stars up front in a pill; approval.md should do the same in its own visual language. The landing page is static (GitHub Pages serves main at /, no build step, see APRV-407), so the count cannot be fetched at build time. The chip ships with a committed count, and the browser asks the public GitHub API for a fresher one at most once an hour (anonymous calls are capped at 60 an hour per IP, so a per-view call would fail for busy readers). Any failure keeps the committed number; the chip never shows an error, NaN, or an empty count. No token anywhere.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 index.html carries one stars chip in the hero header linking to https://github.com/approval-md/approval.md, with a star glyph, the count, and an aria-label starting 'GitHub stars'
- [x] #2 The chip is built from the existing tokens (mono type, 11px uppercase label, border-strong rule, surface fill, pill radius, green on hover) and reads correctly in light, dark and system themes and at 320px width
- [x] #3 The count is formatted as an integer below 1000 and as 1.2k / 1.2M style above, by one function a test exercises
- [x] #4 The live refresh calls api.github.com at most once an hour per browser (cached in localStorage, failures back off too), validates stargazers_count as a non-negative integer, and keeps the committed number on any failure
- [x] #5 A test pins the chip's repository URL to package.json and the JSON-LD codeRepository, the API URL to the same repository, and the absence of any Authorization header or token
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. index.html: add an <a id=gh-stars> pill as the hero's first child after the field canvas, absolutely placed top-right inside the hero's 46px top padding so the h1 layout does not move; star glyph (stroke, fills green on hover, the approval tick's green), GITHUB label in the .links style, a rule, then the count in --fg with tabular numerals. Hidden in print.
2. Main script: formatStars(n) plus a fetch of api.github.com/repos/approval-md/approval.md, cached in localStorage under approval-stars for one hour (success and failure both cached), stargazers_count validated as a non-negative integer, every storage access in try/catch, catch() silent.
3. tests/site-stars-chip.test.ts: chip present once inside the hero, href equals package.json repository and JSON-LD codeRepository, API URL names the same repository, aria-label, committed count well formed, formatStars extracted from the page and exercised at the boundaries, no Authorization header or token.
4. npm run build, the new test, the site tests, lint; serve the page with scripts/site-serve.mjs and screenshot light and dark.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented as planned in index.html (CSS block after the hero field rule, the anchor as the hero's first child after the canvas, the script section after the theme code) plus tests/site-stars-chip.test.ts. Decisions: the committed count is 7, read from the public API on 2026-10-20; the label word is GITHUB (the site's .links style names destinations, and the star glyph plus number carry the count) rather than tokenmaxxing's 'Star' button; a stale remembered count shows before the refresh because it is newer than the committed one; a failed refresh keeps any remembered count and still starts the hour, so a rate-limited browser makes one call an hour at most. The visitor's browser now makes one cross-origin call to api.github.com an hour; the page is already served by GitHub Pages. No dependency added, no token, no build step. The test runs the page's own stars section against a stand-in document, storage and fetch (success, network error, 403, string/NaN/negative/fractional/missing count, null body, fresh and stale cache, fresh back-off, unparseable storage, blocked storage). Validation: npm run build exit 0, npm run typecheck exit 0, npm run lint exit 0, node scripts/run-tests.mjs --only site-stars-chip site-version-guard demo-wordmark exit 0 (15 pass, 0 fail); headless Chrome screenshots at 1280, 375 and 320 widths in light and dark show the chip top-right of the hero clear of the heading. Follow-up when APRV-407 lands a site build script: write the count at build time and keep this refresh as the top-up.
<!-- SECTION:NOTES:END -->
