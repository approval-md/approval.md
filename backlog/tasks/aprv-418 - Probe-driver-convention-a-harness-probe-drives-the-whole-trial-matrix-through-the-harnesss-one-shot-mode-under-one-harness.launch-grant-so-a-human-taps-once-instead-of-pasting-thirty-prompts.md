---
id: APRV-418
title: >-
  Probe driver convention: a harness probe drives the whole trial matrix through
  the harness's one-shot mode under one harness.launch grant, so a human taps
  once instead of pasting thirty prompts
status: In Progress
assignee:
  - '@lane-e'
created_date: '2026-09-21 02:34'
updated_date: '2026-09-22 00:33'
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

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read first, as the brief orders: CLAUDE.md, SPEC section 11.1, the three backlog guides, APRV-418, APRV-398, APRV-415, APRV-243, the Running the probe section of the Hermes doc, the Hermes probe and its suite, the Grok probe and its doc. Done. The Hermes probe is already modular and exported; the Grok probe is a top-level switch with no exports and no state injection, so it is restructured before it gains anything.

2. THE DRIVER SHAPE, decided once and applied twice. A probe gains a run verb that does in one process what the runbook asked a human to do in thirty steps. Its order is fixed and the order is the safety property: (a) spawn the harness binary with its version flag and record the RAW first line before any trial; (b) compare it against a floor carried as data in the probe and refuse outright below it, because a round measured on a build that ignores the key is a day lost and that is exactly what happened on 2026-09-21; (c) build the scratch project and write the hook block; (d) walk a declarative matrix, arming each trial through the same control file the manual path uses and spawning ONE one-shot invocation per trial; (e) print the report. No prompt is typed and no restart is asked for, because every one-shot invocation is its own process start, which is what makes the fail-closed pairs drivable at all: the config is read at startup, so rewriting it between trials needs no human.

3. Hermes, scripts/probes/hermes-hook.mjs. Factor the scratch-building half of setup into prepare() so setup and run share one implementation and cannot drift. Add HERMES_FAIL_CLOSED_FLOOR, parseVersionLine and floorVerdict as plain-JS copies of what core harness-version.ts holds, with a test pinning the copy field-for-field against the runtime constant, since the probe must run from a checkout before any build and cannot import the compiled module. Add ONE_SHOT with the prompt flag, the directory flag and the accept-hooks flag, overridable on the command line, and marked UNVERIFIED because this repository has never run the binary. Add MATRIX: five baseline prompts, the three fail-closed trials in both passes, the eight dialect trials and the modify trial, each a record with its phase, its armed trial, the fail-closed state it needs, its prompt, its artifact and its timeout. run() executes them in order, rewriting the config only when the required fail-closed state differs from the current one, and stops early with a diagnosis when the first trial produced no captured envelope at all, so a wrong one-shot flag costs one invocation rather than twenty.

4. The retry heuristic gets a sharper reading, which is what AC1 asks for. arm gains a step label, record copies it into the capture row, and the report's caveat now names whether the later call naming the same path came from the SAME one-shot session (a genuine model retry, the confound that misread the garbage trial) or from a LATER step (a different process, so the artifact is another trial's). A new report section lists each driven step with its exit code, its duration and whether its artifact landed.

5. Tests, tests/probe-hermes-hook.test.ts. A fake harness binary written by the suite into a temp directory: it answers the version flag from an environment variable, and on a one-shot invocation it reads the config the probe just wrote, invokes the hook command with a canned envelope on stdin, honours the fail-closed semantics the live probe measured, and creates the artifact when the call was not blocked. That makes the driver end-to-end without any install and exercises the config file itself, which is the artifact that cost a round. Cases: the version is recorded before any trial; a build below the floor refuses and runs nothing; an unreadable version refuses unless the override flag is passed; the matrix covers every trial name; the fail-closed pass pair is driven without a human; the early stop fires when nothing is captured; the report tells a same-session retry from a later step.

6. Grok, scripts/probes/grok-build-hook.mjs. Restructure into exported functions with the same injectable pointer and state the Hermes probe has, keep arm, record and report working exactly as before for the manual path, and add run with the same order. Its matrix is the three answers AC1 of APRV-243 asks for plus a control: the Claude-settings entry (the hazard), the native hook entry (the control that tells a harness which fires nothing from a harness that fires only its own), a deny in the Grok dialect at exit 2, and a plain allow. The probe stops editing this repository's own settings file: the entry goes in a scratch project the driver builds, which removes a hand-edit of a policy-core file from the runbook entirely. New suite tests/probe-grok-build-hook.test.ts on the Hermes suite's shape, with its own fake binary.

7. Docs. The Hermes doc's Running the probe section becomes four steps: install, set a key once, one tap on the driver request, read the report; the manual gateway pass stays and is reduced to three named messages the driver prints. A new docs/probe-driver-convention.md states the driver shape, the one-grant flow and the two credential options, cross-linked from the How to add an entry section of the register and from both hook docs. The Grok doc's probe section is rewritten to the one-tap command. CHANGELOG gets a bullet.

8. Verify: build, typecheck, lint, the named suites, the conformance runner. Then notes, AC checks with evidence, a note on APRV-243 that its probe is one tap now without checking its AC1, push, pull request, watch CI to a verdict.
<!-- SECTION:PLAN:END -->
