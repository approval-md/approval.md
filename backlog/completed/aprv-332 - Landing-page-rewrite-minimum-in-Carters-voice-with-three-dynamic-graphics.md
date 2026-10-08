---
id: APRV-332
title: 'Landing page rewrite: minimum, in Carter''s voice, with three dynamic graphics'
status: Done
assignee:
  - '@claude'
created_date: '2026-09-13 17:26'
updated_date: '2026-09-13 18:48'
labels: []
dependencies:
  - APRV-331
ordinal: 250000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replace the reference-style index.html with the shortest page that explains the framework: wordmark and "human approval for agent actions", the line "A harness-agnostic, open-source framework for approving agent actions with a human in the loop", the npm install block (version 0.2.0), an indie-dev step-by-step whose centerpiece is the human writing their own APPROVAL.md (both fenced blocks: yaml approval-policy and yaml approval-values), and three dynamic graphics: (A) an agent flow pausing at the gate until approval arrives, (B) a terminal window typing a literal APPROVAL.md, (C) an email leaving an agent window, held, then delivered after the tap. Copy is drafted with Carter in chat and Carter's wording wins. Three.js from a pinned cdnjs URL is permitted for one hero component chosen with Carter on threeui.com; it is the first external script on the site and must degrade to a CSS gradient when it fails to load. Green #17A15E stays reserved for the approve state. Depends on the /features split (APRV-331) so the reference content is already reachable.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 index.html opens with the wordmark, the tagline, Carter's one-line description, and the install block reading 0.2.0, in that order
- [ ] #2 The onboarding steps are the text Carter approved in chat, each step one short line plus at most one command, and every command runs as written against approval-md@0.2.0 (init, setup identity, policy attest, setup channel telegram, env, up, hook)
- [x] #3 The APPROVAL.md step and graphic B show both fenced blocks, yaml approval-policy and yaml approval-values, and say the policy block is the only thing that changes what an agent may do
- [x] #4 Graphics A, B and C are inline CSS/SVG/vanilla JS, loop or trigger on scroll, and render their final state under prefers-reduced-motion
- [x] #5 If a Three.js component is used it loads from one pinned cdnjs URL, the page renders fully without it, and the dependency is justified in the implementation notes
- [x] #6 The feature set, compare, invariants, exit codes and posture are absent from index.html and linked from one line of links to features/, README, GitHub and npm
- [x] #7 README quickstart text no longer says approval quickstart is source-checkout only
- [x] #8 No horizontal scroll at 375px; light and dark themes both correct; every link resolves; npm test and lint pass
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Onboarding copy approved by Carter in chat on 2026-09-13 (seven steps: Install, Scaffold, Configure your APPROVAL.md with the five autonomy levels loosest to strictest using supervised-retro and supervised-live+live_rate, Sign it with the re-attest sentence, Turn it on, Harness-agnostic with one line per harness (Claude Code hook, Cursor hook with failClosed, Agent SDK HookMatcher, MCP serve, Codex prepare experimental), Release your approved agents). A one-line quickstart shortcut sits under the steps. Carter's wording wins over the task description where they differ.

## Implementation (APRV-332)

**The page.** `index.html` is 1134 lines, down from 1523. Kept verbatim from the
reference page: the whole `<head>` (meta, JSON-LD, the pre-paint theme script, the
APRV-331 hash-forwarding script, the Google Fonts link), the CSS token block
(dark base, light overrides), the wordmark H1 with its inline SVG and the tagline,
the bold lead line, `#install` with both copy buttons and the "Latest features /
contribute" details, the footer, and the fixed three-way theme toggle with its JS.
Removed with all their CSS and JS: sidebar, loop card, feature grid, search, chips,
compare, invariants, exit codes, posture, read-on, the feature-index JSON and its
drift check. No orphaned rules were left behind (grep-checked for `.loop`,
`.card`, `.grid`, `.chip`, `.prose`, `.list`, `.side`, `.grp`, `table.exit`).

Order is hero (wordmark, tagline, lead, install) over the canvas field, graphic A,
the seven steps with graphic B inside step 3 and graphic C inside step 7, the
quickstart shortcut line, one row of links, footer. Single column, `max-width:720px`,
JetBrains Mono throughout, the reference page's scale kept (11px uppercase labels,
13 to 15px body, hairline `var(--border)` rules).

**Copy.** Carter's seven steps are verbatim; the only changes are HTML escaping
(`human:&lt;you&gt;`) and splitting step 6's opening into the bold headline plus its
second sentence. The autonomy block is a `<pre>` with the comments in `var(--muted)`
and no copy button, since it is policy to adapt rather than a command to run; every
actual command block reuses the install block's `.cmd` / `.copy` markup, CSS and
script. One sentence was added that Carter's steps do not contain, to satisfy AC #3
and SPEC §11.1 invariant 10: the caption under graphic B saying the
`yaml approval-policy` block is the only thing that changes what an agent may do and
that `yaml approval-values` widens nothing and narrows nothing.

**Versions.** JSON-LD `softwareVersion` and the install note now say 0.2.0. The
install note's details text is now "Use a source checkout to contribute or to run
unreleased work." The "Feature index: current source checkout" line is gone; the
licence text lives in the footer.

**Why no Three.js (AC #5).** The hero background is Canvas 2D, about 113 lines, no
library. The effect wanted was a monochrome dot grid with soft pulses running along
horizontal lanes, taken from threeui.com's "Predictive Arc: Signal Particles" and
calmed down: that is a 2D gaussian over a fixed lattice, which needs no scene graph,
camera, shader pipeline or 600KB of WebGL runtime. Bringing Three.js in would have
added the site's first external script, a CDN failure mode to degrade from, and a
WebGL context on a page whose whole point is restraint. So the answer to AC #5 is
that no Three.js component is used, and the page has no external script at all:
Google Fonts is still the only remote asset. Details: device pixel ratio capped at
2, resize debounced, dot and pulse colours read through `getComputedStyle` and
re-read on a `MutationObserver` over `data-theme` and on `prefers-color-scheme`
change, the RAF loop stopped by an IntersectionObserver when the hero leaves the
screen, and one still frame drawn under reduced motion. Dots at rest are collected
into a single path and filled once per frame, so only the handful a pulse is
crossing cost an individual fill; measured 120fps in the pane. The canvas is sized
in CSS (`position:absolute`, full height, 16px bleed into main's gutters) so it
causes no layout shift, and a two-layer mask dissolves it at the bottom and both
sides.

**The three graphics.** All inline SVG, CSS and vanilla JS, all `aria-hidden` with a
one-sentence visually-hidden description each, all sharing one 30-line scheduler that
runs a list of beats, rests about 2s, and starts and stops on an IntersectionObserver.
Green `var(--green)` appears only on approve ticks and approved states.
- A, the gate (53 lines of JS): agent and world captions on a hairline rail with the
  wordmark's bracket and tick scaled to 40px in the middle. A dot travels from the
  agent, halts short of the bracket, the bracket pulses, a phone pill shows
  "approve?", the tick in the pill goes green, the bracket's tick goes green, and the
  dot continues to the world. Then the bracket returns to rest and a second dot
  labelled `read.*` crosses without stopping.
- B, APPROVAL.md (104 lines): the literal file is in the document as plain text
  inside the terminal frame, so it is readable with JavaScript off and its natural
  height is reserved from first paint. The script tokenises it line by line (fences,
  fence info strings bold, keys in `--fg`, values in `--muted`) and reveals it over
  the hidden original at 12ms per character. The file is 938 characters, so a pass
  takes about 11 seconds rather than the 20 the task sketched; 12ms per character was
  taken as the binding figure, and 20s of typing on a landing page felt long. Long
  lines scroll inside the frame on a thin bar, so 375px never widens the page.
- C, the email (80 lines): agent and inbox window frames with the bracket between
  them, side by side above 560px and stacked below. The card's start, hold and
  delivery positions are measured from the live boxes on every pass and after
  `document.fonts.ready`, so the same code drives both layouts: the card halts just
  short of the bracket whichever side it approaches from. It dims, a pill shows
  `communicate.email.external · approve?`, the tap turns the tick green, the bracket's
  tick follows, the card lands in the inbox with a green delivered row, and the two
  log lines fade in.

Under `prefers-reduced-motion: reduce` every graphic paints its final state and no
transition or animation runs; verified by serving a scratchpad copy with the switch
forced on and reading the resulting DOM (dot at the world end, file fully typed
938/938, card delivered, both log lines shown, both ticks green).

**README.** The "Five minutes to a working gate" step 2 paragraph no longer says
`quickstart` is source-checkout-only pending a release: it says the command ships in
the published package, the block is now `approval quickstart`, and the source
checkout survives as one sentence for contributors. "For the published 0.1.0
package" is now 0.2.0.

**llms.txt and llms-full.txt.** Version 0.1.0 to 0.2.0 in the summary line, the npm
bullet and llms-full's banner. The three items CHANGELOG 0.2.0 lists as published
(APRV-321 adapter API, APRV-320 ZZZ adapter, APRV-311 to APRV-313 Codex) no longer
say "source checkout" or "source-only"; they say shipped in 0.2.0. Two stale
pointers to `index.html` as the home of the feature-index JSON now point at
`features/index.html` after the APRV-331 split.

**Verification.** `npm test`: 4114 tests, 4113 pass, 1 skipped, 0 fail, exit 0
(run again after the README and llms edits). `npm run lint`: exit 0. A scratchpad
script extracted all 17 unique hrefs and resolved every one: local paths exist,
`features/` has an index.html, each `blob/main/<path>` maps to a file in the working
tree, and `#gate-your-coding-agent` matches a real README heading slug. It found a
genuine miss first (`#readme` is GitHub's own README-panel anchor, not a heading
slug) which proved the checker fires; that case is now whitelisted with a comment.
Rendered at desktop and at the 375px preset in both light and dark: no console
output, `documentElement.scrollWidth` equals `innerWidth` at 375px, the theme toggle
recolours the canvas, and all three graphics loop.

**Not done here.** No commit was made (the session brief forbade it). The AC #2
claim that every printed command runs as written against approval-md@0.2.0 was not
executed; the commands were checked against the CLI reference and the README, not
run. llms-full.txt still narrates the loop card and the feature grid as if they sat
on the landing page, which is true of `features/` now; rewriting that file's
structure is larger than this task's "small edits only" and wants its own task.

Finalization 2026-09-13: Carter approved the page in the Browser pane and asked for three copy edits (version note reads v0.2.0 only, source-checkout sentence trimmed, shortcut line reads 'Alternatively run approval quickstart for a walkthrough'), applied. Added tests/site-version-guard.test.ts binding the landing page note, both pages' JSON-LD softwareVersion and llms.txt to package.json version (3 tests pass). Spacing fixes after review: gate height 178 to 150 with the rail at 96px, email graphic phone-wrap and logs margins tightened, white-space:pre moved from .logs to .logs div (line gap 54px to 18px). AC 2 left unchecked: approval init ran as written against the installed CLI in a scratch directory and wrote APPROVAL.md plus .approval/, and every other verb on the page exists in the CLI help, but the interactive identity, attest, channel and up ceremony was not executed end to end. Verified: npm test 4113 pass 0 fail, lint clean, no console errors, scrollWidth equals innerWidth at 375.

2026-09-13, after Done at Carter's request: llms-full.txt restructured to mirror the shipped pages. Top section is the landing page (install, the seven onboarding steps with the harness list and links, a one-paragraph description of the three graphics); a new heading marks everything from Try the loop onward as the content of approval.md/features/. Pushed to the PR 388 branch before merge. site-version-guard and docs-guard pass (19 tests).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Rewrote index.html to the hero, install block, Carter's seven steps and three inline graphics (gate, APPROVAL.md terminal with both fenced blocks, held-then-delivered email) plus a Canvas 2D signal field behind the hero; no external scripts. README no longer calls quickstart source-only; llms files say 0.2.0; a new site-version guard test binds the pages to package.json. Verified in the Browser pane at 1280 and 375 in both themes, npm test and lint.
<!-- SECTION:FINAL_SUMMARY:END -->
