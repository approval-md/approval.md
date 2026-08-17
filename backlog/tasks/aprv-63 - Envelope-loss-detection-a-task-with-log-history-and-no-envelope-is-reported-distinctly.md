---
id: APRV-63
title: >-
  Envelope-loss detection: a task with log history and no envelope is reported
  distinctly
status: To Do
assignee: []
created_date: '2026-08-17 16:17'
updated_date: '2026-08-17 16:17'
labels: []
milestone: m-8
dependencies:
  - APRV-65
priority: high
type: feature
ordinal: 62000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The defense half of APRV-60 (observed live: backlog task edit dropped the approval: key from APRV-51). The log knows which tasks have registered actions; a task file for such a task that now carries no envelope has lost it, whether by a third-party rewrite or a hand edit. Detect at the three read points that already exist: approval register (refuse re-registration of a file whose envelope vanished with a distinct code rather than treating it as a new no-envelope task), the daemon tick (envelope.drift with a distinct payload reason, envelope-missing, so it is not confused with a state mismatch), and approval doctor (a check listing tasks with log history whose files lack an envelope). Never silently repaired: the writer could re-emit the envelope from the log, but that turns a projection into a source, so restoration is a human verb at most (design a restore verb only if the human asks; report by default).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 register refuses, with a distinct machine-readable code, a file whose task has registered actions in the log but no envelope
- [ ] #2 Daemon appends envelope.drift with reason envelope-missing for such files, once, re-derived per tick
- [ ] #3 doctor lists tasks whose log history implies an envelope their file lacks
- [ ] #4 Reproduction of the loss with the pinned Backlog.md CLI is a test fixture
<!-- AC:END -->
