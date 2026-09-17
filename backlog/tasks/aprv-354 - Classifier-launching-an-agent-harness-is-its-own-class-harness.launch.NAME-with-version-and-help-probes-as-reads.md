---
id: APRV-354
title: >-
  Classifier: launching an agent harness is its own class, harness.launch.NAME,
  with version and help probes as reads
status: To Do
assignee: []
created_date: '2026-09-17 08:49'
labels:
  - classifier
  - harness
  - policy
  - muse
  - codex
dependencies: []
priority: high
ordinal: 271000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter chose this on 2026-09-17 (option B for APRV-349 AC4). Today any command whose first word is an agent harness binary (codex, muse, grok, claude, cursor-agent) is hook-unclassified and refused. That is fail closed, and it is also blunt: Lane 4b could not read a harness version (it read package.json instead), the APRV-349 probe spawns codex app-server which no rule names, and launching a harness is not a policy-visible act an operator can reason about. Add a class family harness.launch.NAME (harness.launch.codex, harness.launch.muse, harness.launch.grok, harness.launch.claude, harness.launch.cursor), matched by policies as harness.launch.* or per harness, with the argv bound. Version and help probes (--version, -V, --help, -h, help as the only argument) classify as reads with their own rule id, because they start no session. Everything else is a launch. The family is never inferred autonomous: an unknown class already falls to defaults.autonomy, and this repository policy line is manual for the family and human-only for Muse. Two hazards are the reason this is a task and not a table row, and both must be written into SPEC and the docs. First, laundering: a launched harness runs its own tools OUTSIDE this gate unless its own adapter is installed and attested, so a grant covers the launch and never the inner actions; the blessed Codex entry point is the confined approval codex start (APRV-325.3), and the docs say so. Second, Muse: Carter has ruled that Muse Code must never run with a Contributor model selected (model ids ending -contributor trade price for permission to train on prompts and completions) and must not run over real repositories until its adapter, the read jail policy line and his own confirmation are in place; harness.launch.muse is therefore human-only in this repository proposal, and the classifier additionally binds the --model argument when present so a prompt can show it, and marks a muse launch whose --model ends in -contributor with a distinct rule id so policy and prompts can see it (self-reported, so it may raise scrutiny and never lower it). Binary spellings to cover: bare name, absolute and home-relative paths (/opt/homebrew/bin/codex, ~/.local/bin/muse), env-prefixed forms (FOO=1 codex ...), and package-runner forms (npx @openai/codex, npx codex); a wrapper the classifier cannot see through stays unclassified. approval codex start and the other approval verbs keep their existing classes. Related: APRV-349 (its AC4 becomes satisfiable: the probe spawn is classifier-readable), APRV-311, APRV-325.3, APRV-350, APRV-352 (same shape of change), APRV-353.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval hook classify returns harness.launch.NAME with argv bound for a session-starting invocation of each of the five harnesses in bare, absolute-path, home-relative, env-prefixed and package-runner spellings; version and help probes classify as reads with a distinct rule id; approval verbs and unrelated commands are unchanged; a wrapper that hides the binary stays unclassified; tests cover each spelling and each harness
- [ ] #2 A muse launch binds the --model value when present, and a --model ending in -contributor carries a distinct rule id; tests cover present, absent and contributor values; nothing in the classifier treats a Standard model id as lowering scrutiny
- [ ] #3 SPEC 7 gains the harness.launch.* row and a paragraph stating what a grant of the class covers and does not cover (the launch, never the inner actions), that the family is never inferred autonomous, and the Codex confined entry point; the amendment is called out; docs/claude-code-hook.md lists the family and docs/codex-hook.md, docs/grok-hook.md and the Muse docs or register entry point at it
- [ ] #4 docs/proposals/ carries the Current and Replace-with pair adding harness.launch.* as manual and harness.launch.muse as human-only to this repository APPROVAL.md, with the contributor-model reason in the comment, anchored on a line that occurs exactly once
- [ ] #5 APRV-349 notes record that codex app-server now classifies harness.launch.codex, so its AC4 wording is satisfiable; conformance vectors cover the family; build, typecheck, lint and the classifier suites pass
<!-- AC:END -->
