---
id: APRV-265
title: 'Landing page: the full feature set, dark-first, threeui-style'
status: In Progress
assignee:
  - 'agent:opus-lane-d'
created_date: '2026-09-05 10:23'
updated_date: '2026-09-05 10:24'
labels: []
dependencies: []
ordinal: 200000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The page at https://approval.md (GitHub Pages from index.html at the repo root) still describes a pre-release with three cards of copy and a policy snippet whose autonomy vocabulary predates the APRV-127/185 split. 0.1.0 has shipped a much larger surface: two harness hooks, an MCP server over stdio and streamable HTTP with a guest mode, two email adapters over a vaulted credential, a supervised daemon with an up preflight, 25 doctor rows, log anchoring and human-signed checkpoints, and a language-neutral conformance suite. The landing page is the first thing anyone reads and it undersells all of it. Rebuild index.html as one self-contained page (inline CSS and JS, no build step, no external scripts) that presents the actual shipped feature set as a filterable card grid, keeps the interactive approve/reject card that shows the product in one card, and adopts a dark-first monochrome design with a light theme and a three-way theme toggle. Every claim on the page must be true of main today, and anything behind a policy key must say so.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 index.html is self-contained: inline CSS and JS, no external scripts, no build step; the only remote asset is the Google Fonts stylesheet for JetBrains Mono, behind a real monospace fallback stack
- [ ] #2 The brand holds: brand/wordmark.svg is unchanged and the inline appr[check]val.md wordmark SVG is still the logo
- [ ] #3 The interactive Try the loop approve/reject card survives, with copy refreshed to today's real event names and record fields
- [ ] #4 Every feature claim on the page is true of main today, and each feature behind a policy key says plainly that it is
- [ ] #5 Dark-first palette with a light theme and a three-way light/dark/system toggle in the bottom-left, persisted in localStorage and honouring prefers-color-scheme
- [ ] #6 A left sidebar on wide screens with collapsible groups (Documentation, Product, Examples, Compare, Invariants) that becomes a top row on narrow screens
- [ ] #7 A filter-chip row filters a card grid; each card carries a lowercase tag row, a one-sentence claim, and a link into the README section, doc or example
- [ ] #8 A search box filters cards by text with no network, and Cmd/Ctrl-K focuses it
- [ ] #9 Mobile-first responsive with no horizontal scroll at 360px
- [ ] #10 The green accent is used only for the approve state and the tick; everything else is monochrome
- [ ] #11 Accessibility: visible focus rings, aria labels on the toggle and the search box, and the tick animation respects prefers-reduced-motion
- [ ] #12 Every link target exists on main: README anchors, docs files and examples paths verified by grep
- [ ] #13 No em dashes and no not-X-but-Y constructions in the page copy
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read the sources: README.md all eleven sections, docs/cli-reference.md verb list and the 25 doctor rows, docs/claude-code-hook.md, docs/cursor-hook.md, docs/git-evidence.md, every examples/ entry, SPEC.md section 11 and 11.1, package.json. Confirm the policy-key features by grepping schema/ and src/ rather than trusting prose.
2. Build the content model first: a flat JS array of feature cards, each with id, title, one-sentence claim, tag list (shipped / behind a policy key / example / spec / human-only), chip facets (gate, channels, adapters, hooks, log, daemon, mcp, verification, examples), and a link target. Verify every link target with grep before it goes in the file.
3. Write index.html as one file: inline CSS tokens for the dark-first palette and the light theme, the three-way theme toggle bottom-left with localStorage plus prefers-color-scheme, the sidebar with collapsible groups, the H1 and subtitle, the search box with Cmd/Ctrl-K, the chip row, the card grid rendered from the array, the refreshed Try the loop card, and the footer.
4. Keep the wordmark: brand/wordmark.svg untouched, the inline appr[tick]val.md SVG carried over, the green reserved for the approve state and the tick.
5. Verify in the browser: dark, light, and mobile at 360px. Screenshot each, fix layout and contrast faults, and paste the observations into the notes.
6. Grep every href in the finished file against the tree to prove no link points at something that is not on main. No test run: no guard covers index.html (grep of tests/ and scripts/ finds no reference).
<!-- SECTION:PLAN:END -->
