---
id: APRV-418
title: >-
  Probe driver convention: a harness probe drives the whole trial matrix through
  the harness's one-shot mode under one harness.launch grant, so a human taps
  once instead of pasting thirty prompts
status: To Do
assignee: []
created_date: '2026-09-21 02:34'
labels:
  - probes
  - harness
  - hook
dependencies: []
priority: medium
ordinal: 322000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter's feedback after the Muse (APRV-350) and Hermes (APRV-398) probes on 2026-09-21: both were very manual, with prompts, restarts and file checks copied into terminals by hand, and more harnesses are coming (Grok Bot, others). The manual cost came from three sources and only one is the gate: launching a harness is harness.launch.* and manual by policy, which is right and costs one tap; the probes assumed an interactive TUI session, which is a design choice; and the model key must be in the harness home, which agents do not touch. Convention to build: scripts/probes/<harness>.mjs gains a run mode that drives the entire matrix itself through the harness's one-shot invocation (hermes -z PROMPT --in DIR --accept-hooks; claude -p; codex exec; the Muse equivalent), including writing the hook block, running each armed trial as a child process, waiting out the hang trial, reading the effects, and writing the report, with canned-envelope tests so the driver is verified before any install. The lane then files ONE request classified harness.launch.<kind> for the driver invocation (with APRV-401 the grant binds the driver bytes), the human taps once, and the report comes back to the lane. The driver records the exact version string before any trial and refuses to report against a build below a known floor (the Hermes probe ran its first pass on a build 670 commits behind and every result was wrong for that reason). The report distinguishes an armed call that was blocked from a file that exists, by reading its own capture for later calls naming the same path, which is the heuristic that misread the Hermes garbage trial. Credentials: document the two options, a key placed once by the human in the harness home, or a vault entry injected through approval run's credential window. The messaging-gateway pass stays a short manual step (a bot cannot message a bot) and the driver prints exactly the messages to send. Retrofit the Hermes probe first as the reference; Muse second if its one-shot mode exists. Related: APRV-350, APRV-398, APRV-415, APRV-401, APRV-243 (Grok Build probe), APRV-246 (Grok Bot).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 scripts/probes/hermes-hook.mjs run drives the full matrix (baseline, fail-closed pairs, dialect trials) through hermes -z with no human input after one launch grant, records the version first and refuses below the floor, and its report reads its own capture to tell a blocked call from a later retry; canned-envelope tests cover the driver
- [ ] #2 docs/hermes-hook.md Running the probe becomes: install, set a key once, one tap on the driver's harness.launch request, read the report; the manual Telegram pass is three named messages
- [ ] #3 A short convention page under docs/ (or a section in docs/integrations-considered.md How to add an entry) states the driver shape, the one-grant flow and the credential options for the next harness probe
<!-- AC:END -->
