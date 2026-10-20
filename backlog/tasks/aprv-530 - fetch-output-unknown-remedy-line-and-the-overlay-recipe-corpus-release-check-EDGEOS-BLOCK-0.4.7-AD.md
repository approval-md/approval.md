---
id: APRV-530
title: >-
  fetch-output-unknown remedy line and the overlay recipe corpus release check
  (EDGEOS-BLOCK, 0.4.7 A+D)
status: In Progress
assignee:
  - '@claude-approval-edge2'
created_date: '2026-10-20 09:09'
labels:
  - classifier
  - hook
  - ci
  - release
dependencies: []
ordinal: 404000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
EDGEOS-BLOCK: core 0.4.6 (APRV-511) classes every curl/wget whose option-slot word starts with $ policy.core by rule fetch-output-unknown, which the overlay template reserves to humans, so every skills/edgeos curl recipe was denied outright (hook-class-human-only, Hermes plugin_block) from the 19 Oct rolls. The rule is right (the expansion could be -o <organ path>); the refusal said nothing about the shape that runs, and nobody ran the fleet's recipes through the new core before the tag. Brief: lanes-approval/briefs/APRV-0.4.7-fetch-output-unknown-brief.md items A and D.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A: when fetch-output-unknown fires because a $-first word sits in a curl/wget option slot, the human-only refusal ends with one fixed remedy line (pass the URL as --url "$VAR..."; wget: use curl --url)
- [ ] #2 A: other causes (unknown option, -K/config, ambiguous prefix, variable output value) keep 0.4.6's refusal text byte for byte; class, rule and code unchanged
- [ ] #3 A: argvWordUnknowable and fetchOutputs unchanged; mutant tests show the deny still fires for "$X/path", $X, "${X:-https://h}/p" and -K "$C"
- [ ] #4 D: scripts/overlay-recipes-check.mjs runs a vendored overlay recipe corpus (with its overlay sha) through classifyForHook and fails on an unlisted human-only class; CI job overlay-recipes runs it and the ci aggregator requires it
- [ ] #5 CHANGELOG names EDGEOS-BLOCK and the overlay --url convention for agent-facing recipes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. hook.ts: FETCH_DOLLAR_WORD_REMEDY + fetchOutputRemedy(segments, reserved), appended to both human-only deny sites (gated path and open window). 2. tests/cli-hook-fetch-remedy.test.ts. 3. scripts/overlay-recipes-extract.mjs (overlay recipesIn verbatim), corpus.json at overlay origin/main, allowlist.json, overlay-recipes-check.mjs, tests/overlay-recipes-check.test.ts. 4. ci.yml job + aggregator, ci-guard test. 5. CHANGELOG Unreleased, docs/hermes-hook.md.
<!-- SECTION:PLAN:END -->
