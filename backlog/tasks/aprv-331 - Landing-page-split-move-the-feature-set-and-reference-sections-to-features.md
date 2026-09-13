---
id: APRV-331
title: 'Landing page split: move the feature set and reference sections to /features'
status: In Progress
assignee:
  - '@claude'
created_date: '2026-09-13 17:26'
updated_date: '2026-09-13 17:39'
labels: []
dependencies: []
ordinal: 249000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The approval.md landing page (index.html) carries the sidebar, the 70-card feature grid with search and filter chips, compare, invariants, exit codes, posture and read-on. Carter wants the landing page reduced to the minimum that explains the framework (see the sibling task). The reference content is good and keeps its style; it moves verbatim to a new features/index.html so nothing becomes unreachable. Lands before the landing page rewrite. Hosting stays GitHub Pages from the main root, so the new page is a plain file with inline CSS and JS, Google Fonts the only remote asset.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 features/index.html exists with the sidebar, feature grid, search, filter chips, compare, invariants, exit codes, posture, read-on, footer, the hidden feature-index JSON and its drift-check script, and the three-way theme toggle, moved from index.html
- [ ] #2 Every card href on the features page resolves to a real README, docs or examples anchor (grep-verified), and relative paths are corrected for the features/ directory
- [ ] #3 Old landing-page anchors (#features, #compare, #invariants, #exit, #posture, #readon, #loop) keep working: a small script on index.html redirects a matching location.hash to features/#<id>
- [ ] #4 Version strings on the moved page say 0.2.0 (install note, JSON-LD softwareVersion, feature-index version)
- [ ] #5 No horizontal scroll at 375px; theme toggle works in both directions; npm test and lint pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Copy index.html to features/index.html verbatim, then delete from the copy the hero sub/lede prose that belongs to the landing page (keep wordmark H1 so the page is branded) and keep the sidebar, loop card, feature grid, compare, invariants, exit, posture, readon, footer, theme toggle, feature-index JSON and the behaviour script.
2. Fix relative hrefs for the features/ directory (README.md, SPEC.md, docs/, examples/, llms.txt, brand paths, canonical URL, JSON-LD url) and bump 0.1.0 to 0.2.0 in the install note, JSON-LD softwareVersion and feature-index version.
3. Leave index.html untouched except for one small inline script that maps a location.hash in {features, compare, invariants, exit, posture, readon, loop, install} to features/#<id> (install stays on the landing page, so exclude it). The landing page rewrite is APRV-332.
4. Verify: grep every href on features/index.html and confirm each target file and anchor exists; open in the browser at desktop and 375px, both themes; run npm test and npm run lint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Implementation (APRV-331)

**What moved.** `features/index.html` (1501 lines) is `index.html` at fbc4eef with the landing-page hero prose and the install block removed, and nothing else taken out: sidebar, `#loop` card, the 70-card `#features` grid with search and chips, `#compare`, `#invariants`, `#exit`, `#posture`, `#readon`, footer, three-way theme toggle, the hidden `feature-index` JSON and the behaviour script (drift check included) are all present. The wordmark H1 keeps the tagline and is now a link to `../`, with one new CSS rule (`h1 a.home,h1 a.home:hover{color:inherit}`) so the site-wide green hover does not paint the wordmark: green stays the approve state. The now-unused `.install`, `.cmd` and `.copy` CSS and the copy-button script are left in place untouched, since APRV-332 rewrites the landing page and may want them.

**Hrefs.** Every documentation, example and schema link on the page was already an absolute `https://github.com/approval-md/approval.md/...` URL, so the move needed no path rewriting there. Relative work was limited to: sidebar `#install` to `../#install` (install stays on the landing page), canonical and `og:url` to `https://approval.md/features/`, and a new JSON-LD `WebPage` node (`@id https://approval.md/features/#page`, `url https://approval.md/features/`, `isPartOf` the existing `#site`) so the page does not claim to be the site root. The two `/llms.txt` and `/llms-full.txt` links are root-absolute and resolve unchanged from a subdirectory. `<title>`, meta description, og and twitter titles and descriptions now say this is the feature set and reference page.

**Versions.** JSON-LD `softwareVersion`, the `feature-index` `version` and the footer line now say 0.2.0. The footer carries the version because the install block that used to hold "Feature index: current source checkout" is gone; it now reads "Feature index for approval-md 0.2.0 · Apache 2.0 code · CC0 specification and schemas · releases approved through approval.md."

**Cards corrected.** Three cards claimed "source checkout": `adapter-api`, `zzz` and `codex-hook`. CHANGELOG.md's 0.2.0 entry lists all three as published (APRV-321 public adapter API and the `./adapters` export, APRV-320 ZZZ adapter, APRV-311 to APRV-313 experimental Codex hook), and `package.json` ships `dist/src` plus the `./adapters` exports map, so the claim was stale. Their tag now reads "shipped in 0.2.0" and their `data-tags` token moved from `source` to `shipped`, matched in the JSON index; `source` is dropped from the JSON tag vocabulary. The `experimental` key tag on `codex-hook` is untouched, so the known fail-open gaps stay flagged. No other card text mentioned a version.

**Landing page.** `index.html` has exactly one change (+16 lines): an inline head script that calls `location.replace` to `features/<hash>` when the incoming hash is one of `#loop`, `#features`, `#compare`, `#invariants`, `#exit`, `#posture`, `#readon`. `#install` is deliberately absent. It runs on load, so inbound links and bookmarks land on the features page; clicks on index.html's own in-page sidebar links still scroll the landing page, which APRV-332 resolves when it rewrites that sidebar.

**Verification.** A scratchpad script extracted all 65 unique href and src values: 49 repo links (file existence plus a GitHub heading-slug check on every `.md#anchor`), 4 local, 7 same-page anchors, 5 external. Result: no misses. A negative control with a deliberately broken anchor made the slug checker fire, so the check is real. A second script confirmed the redirect list against the ids present on both pages: 7 of 7 forwarded fragments exist on the features page, and `#install` stays on the landing page. Rendered in a browser: 70 cards, the count reads "70 cards", no console output (so the feature-index drift check is silent), the theme toggle applies and reverts across light, dark and system, search and chips filter correctly, and the loop card still approves. At 375px `documentElement.scrollWidth` equals `innerWidth`, so no horizontal scroll; the only `min-width` values in the CSS are `0` or media-query breakpoints.

`npm test`: 4114 tests, 4113 pass, 1 skipped, 0 fail, exit 0. `npm run lint`: exit 0.

**Left for a later task.** `llms.txt` and `llms-full.txt` still say "Version 0.1.0" and still mark those same three features "source checkout", and index.html's install note still says v0.1.0 and points at "features marked source checkout". Both sit outside this task's one-change-to-index.html scope: the llms files need their own task, and the install note is APRV-332's.
<!-- SECTION:NOTES:END -->
