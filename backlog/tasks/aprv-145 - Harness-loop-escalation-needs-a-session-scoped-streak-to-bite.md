---
id: APRV-145
title: Harness loop-escalation needs a session-scoped streak to bite
status: To Do
assignee: []
created_date: '2026-08-26 13:34'
labels:
  - security
  - hook
  - spec
  - design
dependencies: []
priority: medium
ordinal: 130000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Born 2026-08-26 from the APRV-139 builder's observation. The hook's task id is hook:<session>:<tool-use-id>, minted per invocation, and the hook never appends execution.failed (it never sees an exit status). So the loop-escalation check APRV-139 added to the unattended guard fires only when something else recorded failures under that exact task id: the guard is correct and near-vacuous by construction on the harness path. If loop safety is meant to bite for harness-executed commands, the streak needs a scope that survives across tool calls (the session id is the natural candidate) and a source of failure signal (the harness posts no exit status to the gate today; PostToolUse hooks or the APRV-141 execution records plus a completion counterpart are candidate sources). This is a SPEC question (what is a loop, on a surface that cannot see failures?) before it is code; the task is to write the design and flag the SPEC amendment for sign-off, then build.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A written design states the streak scope, the failure signal, and what the guard refuses, with the SPEC amendment drafted and flagged for sign-off
- [ ] #2 If built: a session-scoped failing streak on the harness path routes the next non-manual command per the design, tested
<!-- AC:END -->
