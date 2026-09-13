---
id: APRV-332
title: 'Landing page rewrite: minimum, in Carter''s voice, with three dynamic graphics'
status: To Do
assignee: []
created_date: '2026-09-13 17:26'
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
- [ ] #1 index.html opens with the wordmark, the tagline, Carter's one-line description, and the install block reading 0.2.0, in that order
- [ ] #2 The onboarding steps are the text Carter approved in chat, each step one short line plus at most one command, and every command runs as written against approval-md@0.2.0 (init, setup identity, policy attest, setup channel telegram, env, up, hook)
- [ ] #3 The APPROVAL.md step and graphic B show both fenced blocks, yaml approval-policy and yaml approval-values, and say the policy block is the only thing that changes what an agent may do
- [ ] #4 Graphics A, B and C are inline CSS/SVG/vanilla JS, loop or trigger on scroll, and render their final state under prefers-reduced-motion
- [ ] #5 If a Three.js component is used it loads from one pinned cdnjs URL, the page renders fully without it, and the dependency is justified in the implementation notes
- [ ] #6 The feature set, compare, invariants, exit codes and posture are absent from index.html and linked from one line of links to features/, README, GitHub and npm
- [ ] #7 README quickstart text no longer says approval quickstart is source-checkout only
- [ ] #8 No horizontal scroll at 375px; light and dark themes both correct; every link resolves; npm test and lint pass
<!-- AC:END -->
