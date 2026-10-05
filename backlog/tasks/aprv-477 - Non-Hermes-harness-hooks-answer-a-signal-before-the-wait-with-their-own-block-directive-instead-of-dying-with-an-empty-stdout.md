---
id: APRV-477
title: >-
  Non-Hermes harness hooks answer a signal before the wait with their own block
  directive instead of dying with an empty stdout
status: To Do
assignee: []
created_date: '2026-10-05 02:58'
labels:
  - security
dependencies:
  - APRV-475
priority: medium
ordinal: 363000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From APRV-475 (2026-10-05). Every CLI harness hook now waits through the yielding driver, so a SIGTERM or SIGINT mid-wait withdraws the question and prints that harness's own hook-interrupted deny. Outside the wait the five non-Hermes harnesses (claude-code, cursor, codex, grok, muse) register no signal listener: a signal during the dist/ load, the stdin read, classification, registration or a pre-wait spend takes Node's default disposition, so the process dies with an empty stdout and nothing spent. That is safe for the log (no execution.started can follow the signal), but several of these harnesses read a dead hook as no opinion and run the call: Claude Code treats a non-2 exit as a non-blocking error, Grok's contract treats a crash as no opinion, Codex's crash row proceeds, Muse fails open on a crash. Cursor with failClosed blocks. Hermes already has both layers (cli.js guard from APRV-466, hermesFailClosed's early guard from APRV-445). Evidence: tests/harness-wait-interrupt.test.ts pins today's behaviour ('a SIGTERM during the stdin read ends the process and the call records no start': death by SIGTERM, empty stdout). Decide per harness whether a stray signal (one the harness did not send) should be answered with the harness's deny, and if so add an early guard for those harnesses on the CLI route only (never on the synchronous in-process, serve or Codex-bridge callers), stepping aside for the wait's handler, plus the post-event rule (a post event must not print a pre-tool verdict).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A signal before the wait on each non-Hermes harness the decision covers prints that harness's hook-interrupted deny at its deny exit code and records no execution.started; post events print no verdict
- [ ] #2 The guard is registered only on the yielding CLI route and steps aside for the wait's handler, so exactly one object is printed
- [ ] #3 Docs per harness updated; tests per harness including a signal held through the stdin read
<!-- AC:END -->
