---
id: APRV-475
title: >-
  Every CLI harness hook drives its wait through the yielding driver, so SIGTERM
  mid-wait withdraws for claude-code, cursor, codex, grok and muse as it now
  does for hermes
status: To Do
assignee: []
created_date: '2026-10-05 01:55'
labels:
  - security
dependencies:
  - APRV-473
priority: medium
ordinal: 362000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From APRV-473 (PR #608, 2026-10-05): the gate path is now one generator chain with two drivers; approval hook hermes runs through the yielding driver (timers), so a signal during the wait reaches the withdrawing handler within one pause and no execution.started is appended after an interruption. The other CLI harness verbs (claude-code, cursor, codex, grok, muse) still run the synchronous driver, so their wait handlers never run mid-wait and a grant after the harness abandoned the call can still record a start for a tool that never ran. The change is a one-line switch per verb in src/cli/main.ts plus the per-harness directive each prints on interruption (those harnesses exit 1 with nothing on stdout today: decide and document what each harness reads as a block, since claude-code reads exit 2 plus a JSON decision and the others differ). Keep commandHook's synchronous API for the Codex bridge and the serve worker. Tests: the hermes-wait-interrupt cases parameterised over the harnesses; the 20x concurrent race; docs/claude-code-hook.md and the other harness docs updated. Also fold in the SPEC section 10.1 interrupt rule drafted in APRV-473's notes for the next attestation batch.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 All five CLI harness verbs use the yielding driver; a SIGTERM mid-wait withdraws and prints that harness's block form; tests per harness including the grant race
- [ ] #2 No execution.started after an interruption on any harness; the pause-before-spend is shared, not copied
- [ ] #3 Docs per harness state the interrupt rule; SPEC 10.1 hunk recorded for the batch
<!-- AC:END -->
