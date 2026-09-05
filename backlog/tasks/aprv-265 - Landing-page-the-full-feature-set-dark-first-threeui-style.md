---
id: APRV-265
title: 'Landing page: the full feature set, dark-first, threeui-style'
status: In Progress
assignee:
  - 'agent:opus-lane-d'
created_date: '2026-09-05 10:23'
updated_date: '2026-09-05 16:23'
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
- [x] #1 index.html is self-contained: inline CSS and JS, no external scripts, no build step; the only remote asset is the Google Fonts stylesheet for JetBrains Mono, behind a real monospace fallback stack
- [x] #2 The brand holds: brand/wordmark.svg is unchanged and the inline appr[check]val.md wordmark SVG is still the logo
- [x] #3 The interactive Try the loop approve/reject card survives, with copy refreshed to today's real event names and record fields
- [x] #4 Every feature claim on the page is true of main today, and each feature behind a policy key says plainly that it is
- [x] #5 Dark-first palette with a light theme and a three-way light/dark/system toggle in the bottom-left, persisted in localStorage and honouring prefers-color-scheme
- [x] #6 A left sidebar on wide screens with collapsible groups (Documentation, Product, Examples, Compare, Invariants) that becomes a top row on narrow screens
- [x] #7 A filter-chip row filters a card grid; each card carries a lowercase tag row, a one-sentence claim, and a link into the README section, doc or example
- [x] #8 A search box filters cards by text with no network, and Cmd/Ctrl-K focuses it
- [x] #9 Mobile-first responsive with no horizontal scroll at 360px
- [x] #10 The green accent is used only for the approve state and the tick; everything else is monochrome
- [x] #11 Accessibility: visible focus rings, aria labels on the toggle and the search box, and the tick animation respects prefers-reduced-motion
- [x] #12 Every link target exists on main: README anchors, docs files and examples paths verified by grep
- [x] #13 No em dashes and no not-X-but-Y constructions in the page copy
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read the sources: README.md all eleven sections, docs/cli-reference.md verb list and the 25 doctor rows, docs/claude-code-hook.md, docs/cursor-hook.md, docs/git-evidence.md, every examples/ entry, SPEC.md section 11 and 11.1, package.json. Confirm the policy-key features by grepping schema/ and src/ rather than trusting prose.
2. Build the content model first: a flat JS array of feature cards, each with id, title, one-sentence claim, tag list (shipped / behind a policy key / example / spec / human-only), chip facets (gate, channels, adapters, hooks, log, daemon, mcp, verification, examples), and a link target. Verify every link target with grep before it goes in the file.
3. Write index.html as one file: inline CSS tokens for the dark-first palette and the light theme, the three-way theme toggle bottom-left with localStorage plus prefers-color-scheme, the sidebar with collapsible groups, the H1 and subtitle, the search box with Cmd/Ctrl-K, the chip row, the card grid rendered from the array, the refreshed Try the loop card, and the footer.
4. Keep the wordmark: brand/wordmark.svg untouched, the inline appr[tick]val.md SVG carried over, the green reserved for the approve state and the tick.
5. Verify in the browser: dark, light, and mobile at 360px. Screenshot each, fix layout and contrast faults, and paste the observations into the notes.
6. Grep every href in the finished file against the tree to prove no link points at something that is not on main. No test run: no guard covers index.html (grep of tests/ and scripts/ finds no reference).

7. Second pass (prose + agent surface). Rewrite every card claim to one sentence of at most 18 words, cap section intros at two sentences, cut the Try-the-loop copy to labels and event lines, and remove metaphor, rhetorical framing and marketing adjectives while keeping every fact. Add the 2026 agent-readability surface: llms.txt and llms-full.txt at the repo root, canonical/alternate/robots/OpenGraph/Twitter head metadata, JSON-LD SoftwareApplication and BreadcrumbList, semantic landmarks with a skip link and one H1, every card an article with id/data-facet/data-tags/data-href, a machine-readable feature-index JSON block, copy buttons on the command blocks with a select-text fallback, / and Cmd/Ctrl-K search focus, focusable cards, and a print stylesheet. Verify in the browser at desktop dark, desktop light and 360px, and run a DOM count check.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built

index.html is one self-contained file: inline CSS and JS, no build step, no external scripts. The only remote asset is the Google Fonts stylesheet for JetBrains Mono, behind the fallback stack ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, DejaVu Sans Mono, monospace. brand/wordmark.svg, CNAME and .nojekyll are untouched; the inline appr[tick]val.md SVG is still the logo, with its bracket paths switched to fill:var(--fg) so the mark inverts with the theme while the tick keeps the #17A15E green.

Structure, top to bottom: a sidebar (Documentation, Product, Examples, Compare, Invariants) as a left rail at 900px and up and a horizontally scrolling row of collapsible dropdowns below that; a one-line H1 (the wordmark plus the claim); a two-line subtitle; the install line; the Try the loop card; the feature set (search box, chip row, card grid); How this compares; Global invariants; Exit codes; What this does not defend; Read on; footer.

66 cards across nine facets: gate 13, channels 7, adapters 6, hooks 6, mcp 5, log 7, daemon 8, verification 7, examples 7. Tag vocabulary: shipped, spec, example, behind a policy key, behind a flag, human-only. The brief listed guest MCP mode, streamable-HTTP MCP, log anchoring and git evidence among the policy-key features; they are behind flags rather than policy keys (--guest, --http, --anchor, --git-evidence), so they carry 'behind a flag' instead. That is the honest label and still says plainly that the feature is not on by default.

## Sources and the claims drawn from them

Read before writing: README.md in full, docs/cli-reference.md (verb headings plus the doctor, up, mcp serve, gate, coverage, log verify, log checkpoint, import agents-md sections at length), docs/claude-code-hook.md, docs/cursor-hook.md, docs/git-evidence.md, all seven examples/ entries, SPEC.md sections 5.2, 7 and 11/11.1, package.json, schema/policy.schema.json and schema/event.schema.json.

Two places where the page follows the source rather than the README:
- Autonomy levels. The README dictionary still says 'manual, supervised, autonomous' at classes.<pattern>.autonomy. schema/policy.schema.json line 309 is the shipped enum: human-only, manual, supervised-live, supervised, supervised-retro, autonomous, with supervised an alias of supervised-retro. The card states the five levels and the alias, and links to the schema rather than the README. Worth a follow-up task on the README dictionary row.
- doctor row count. The README says eleven lines from a fresh directory (a fresh directory skips many). The full ordered list in tests/cli-doctor.test.ts is 25 rows, which is what the card claims.

The Try the loop card's fields come from real records in the committed log: action_key, class, reversible, payload_hash and the chain head in the COMPUTED block, est_cost_usd and summary in the CLAIMED block, and the tail renders task.registered, approval.requested, approval.granted (with token_sha256), execution.started and execution.completed with exit_code, which are the payload shapes those events actually carry.

## Link verification

Every href was checked by grep against the worktree rather than by fetching. 19 distinct repo paths, all present on main. 8 README anchors and 18 docs/cli-reference.md anchors, each matched to an existing heading with grep -nE. 7 in-page anchors matched to their ids. The npm link was dropped: the package is not published yet, so it would have been the one dead link on the page. Only external hosts left are github.com, fonts.googleapis.com and fonts.gstatic.com.

## Interruption worth recording

Partway through the browser verification the harness hook began refusing every shell command with hook-gate-refused:policy-not-attested (attested ab75eb35..., live cbc003f9...), including approval journal write itself. Nothing was bypassed: shell work stopped, the remaining visual checks were done through the browser tools, and the gate returned on its own a few minutes later. A journal entry now records it.

## Visual verification

Served over a loopback static server (a node script in the session scratchpad, 127.0.0.1:8899) because the browser pane renders a file:// page as a static snapshot with no scripting. Viewport emulated at 1100x2400, 980x740 and 360x1500.

Dark, 1100px wide, three columns: hero, install line and loop card read cleanly on #050608; hairline borders at rgba(247,248,248,.10) are visible without weight; the card grid is even and the tag row, claim and uppercase link line stack consistently. Compare and Invariants render as numbered hairline rows, and the exit-code table, the posture prose and the Read on chips close the page.

Light, 1100px: the wall #f3f3f2 against card surface #f7f7f6 with rgba(28,28,26,.07) borders is subtle and still legible; the wordmark brackets invert to #121211 while the tick stays green; the tail block sits on #ececeb so it reads as a terminal inset rather than a hole.

Mobile, 360px: document.documentElement.scrollWidth equals innerWidth (360), so there is no horizontal page scroll. The sidebar is a scrolling top row; an open group drops a wrapped chip list under it and only one group may stand open. The loop card stacks its rows, and the log tail scrolls inside its own overflow-x container rather than widening the page. The chip row wraps to three lines and cards go single-column.

Interaction: clicking Approve draws the tick, turns the verdict line green ('granted, token minted at the terminal'), appends approval.granted, execution.started, execution.completed and a log verify line to the tail, and disables both buttons. Filtering measured live: the mcp chip gives 7 of 66, mcp plus the search term 'vault' gives 1 of 66, all plus 'vault' gives 8 of 66, and clearing returns 66 cards. No console errors on load.

Three faults found and fixed during the pass:
1. The sidebar summaries shrank and their labels overflowed on the narrow row (fixed with flex:0 0 auto).
2. The wide rail lost its sub-links whenever the page had loaded narrow, because the old sync only ever closed groups and never reopened them. Replaced with a rule that closes groups on the transition to narrow and lets CSS own the wide state, plus a +/- disclosure marker on the rail.
3. Two dropdowns could stand open at once on mobile and stacked over the H1. A toggle handler now closes the others, a tap on a link closes the panel, and Escape closes it.

Also fixed: the inline code spans in the install note were inheriting the boxed style meant for the install command (scoped to a direct child), and the H1 was wrapping to two lines because .lede capped at 70ch.

## Second pass: prose and the agent surface (commits 20dfff7, eec5181, 66a012a)

### Prose

Visible page text went from 4337 words to 2941, a 32.2 percent cut, measured by stripping script, style, svg and tags from the body of the pre-pass file and the current one. Every one of the 66 card claims is now a single sentence of at most 18 words; a browser check counts zero card paragraphs and zero index claims over the cap, after five (fail-closed, import-agents-md, message-id, web-agent-demo, grok-demo) came back at 19 or 20 on the first measurement and were reworded. Section intros are at most two sentences. Cut and not replaced: the two paragraphs wrapped around the Try the loop card, 'the whole product in one card', the rhetorical framings, and the marketing adjectives. Where a sentence was the only home of a fact, the fact stayed and the manner went: protected_paths still names the floor it widens, the vault card still says there is no approval vault get, the hook card still says there is no ask answer.

Three deliberate content decisions:
- The loop card now shows five event lines rather than four. Dropping execution.started would have left a tail that no real approval produces, so the log verify flourish went instead and the events stayed.
- A resolved row was added to the COMPUTED block (manual, by the irreversibility floor) because the intro paragraph that carried that fact was cut.
- Two cards were retitled to match their trimmed claim: 'Two properties you can check in your own mailbox' is now 'The Message-ID ties the mail to the chain' (the other property is stated on the payload-binding card), and 'Three sharp edges' is 'Two edges' since the withdrawal edge is on the channel card.

### Agent surface

(a) llms.txt at the repo root follows llmstxt.org: H1 name, one-line blockquote summary, a context paragraph, then Start here, Reference, Harness integration, Examples, Verification and Optional, 22 bullet links each with a one-line description. Doc links use raw.githubusercontent.com so a fetch returns plain markdown. llms-full.txt (24318 bytes) carries the page content as markdown plus all 66 feature entries with facet, tags, claim and link, the comparison list, the ten invariants, the exit-code table and the posture section.
(b) Head: canonical, alternate text/plain to llms.txt and text/markdown to llms-full.txt, robots index,follow, a rewritten description, and Open Graph plus Twitter summary metas with no image (no third-party image fetch).
(c) JSON-LD graph with SoftwareApplication (name, description, DeveloperApplication, macOS and Linux, 0.1.0, Node 20, MIT, codeRepository, no installUrl while unpublished) and WebSite. No BreadcrumbList: this is one page with anchors and no hierarchy for a breadcrumb to describe, so the shape would have been decorative.
(d) Landmarks: skip link, header, nav aria-label, main, seven sections with aria-labelledby, footer. One H1 and no heading-level jumps. Every card is an article with an id, data-facet, data-tags and data-href. script#feature-index carries the 66-entry list as JSON, hidden by CSS as well as by default, and a runtime check warns in the console if the cards and the index drift.
(e) Both install commands are pre/code with a copy button. navigator.clipboard.writeText runs inside the click gesture (no permission prompt) and on rejection the code text is selected instead; the fallback was exercised and the button read Selected.
(f) Keyboard: / and Cmd/Ctrl-K both focus the search box, / is suppressed while typing in a field, chips are buttons with aria-pressed, cards are tabbable with a focus ring and follow their data-href on Enter, the theme toggle is a radiogroup with arrow keys.
(g) No analytics and no external request beyond the Google Fonts stylesheet; the network log for a page load shows the document only.
(h) Print stylesheet: sidebar, theme toggle, chips, search and buttons hidden, single-column grid, and every http link prints its URL after the text.

### Verification

Served the worktree over 127.0.0.1 with a scratch node:http script and drove it in the browser.

DOM check: 1 H1, 66 articles, 66 indexed features, ids match one for one in order, 0 links with empty text, 0 heading-level jumps, 0 articles missing an attribute, 0 claims over 18 words. Landmarks: 1 header, 1 nav with a label, 1 main, 7 aria-labelledby sections, 1 footer, skip link present, 1 JSON-LD block.

Link check (script over index.html, llms.txt and llms-full.txt): 320 link checks, 20 distinct repo paths all present in the worktree, every markdown anchor resolved against a real heading, no broken in-page anchors. Zero em dashes and no not-X-but-Y construction in any of the three files.

Dark at 1180: rail with Documentation and Product open, hero, two copy rows, loop card. Light at 1180: wall rgb(243,243,242), card rgb(247,247,246), muted text rgb(92,92,90), three-column grid, no overflow. Mobile at 375 and at 360: documentElement.scrollWidth equals innerWidth at both, so no horizontal page scroll; the only elements wider than the viewport are the sidebar row and the long clone command, each inside its own overflow-x container.

Interaction: the mcp chip gives 7 of 66, mcp plus the search term vault gives 1, all plus vault gives 8, clearing returns 66, and only one chip carries aria-pressed true. / and Cmd-K both land focus on #q. Enter on a focused card follows its data-href. Approve draws the tick (stroke-dashoffset 0), turns the verdict green, appends approval.granted, execution.started and execution.completed, and disables both buttons. No console messages at all, which also means the feature-index drift check found nothing.

One regression found and fixed in this pass: the sidebar only ever closed groups on a width change, so a page that had been narrow returned to the wide rail with every group collapsed. The groups the document marks open are recorded at load and restored on the transition to wide; verified by resizing 360 to 1180 and reading the open state.

No test run: a grep of tests/, scripts/ and .github/ finds no reference to index.html, llms.txt or llms-full.txt, so no guard covers these files.
<!-- SECTION:NOTES:END -->
