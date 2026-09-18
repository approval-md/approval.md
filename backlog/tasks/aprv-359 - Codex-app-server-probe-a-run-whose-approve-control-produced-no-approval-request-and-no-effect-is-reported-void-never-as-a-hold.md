---
id: APRV-359
title: >-
  Codex app-server probe: a run whose approve control produced no approval
  request and no effect is reported void, never as a hold
status: To Do
assignee: []
created_date: '2026-09-18 00:19'
labels:
  - probe
  - codex
  - bug
dependencies: []
priority: medium
ordinal: 276000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On 2026-09-18 the probe ran five trials against codex-cli 0.152.1 with ~/.codex/config.toml pinning model gpt-6-astra. Every turn ended in task_complete with a 400 (the model requires a newer Codex) before any tool call, so zero approval requests were recorded and no marker landed anywhere, including the approve control. The report still printed the hold sentence (No effect landed on deny, crash, no-reply or malformed... silence and refusal both held), which is a false positive: a run that never reached a tool call proves nothing about interception. The verdict must be conditioned on the approve control having asked and landed, and the turn error text (the error notification and task_complete.error) must be captured in results.json so the reader does not have to open Codex rollouts to learn why.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 When the approve trial records zero approval requests or lands neither marker, the report prints a VOID verdict naming the reason and never prints the hold sentence
- [ ] #2 The error and warning notification payloads, and any task_complete error, are stored verbatim (redacted) per trial in results.json and printed in the report
- [ ] #3 The existing leak (FAILURE TO BLOCK) path is unchanged and still fires when a must-not-execute trial lands a marker
- [ ] #4 Unit coverage for the three report outcomes: hold, leak, void
<!-- AC:END -->
