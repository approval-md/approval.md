---
id: APRV-49
title: 'Dogfood cutover: manual-class repo actions route through the live daemon'
status: To Do
assignee: []
created_date: '2026-08-05 15:33'
labels: []
milestone: m-7
dependencies:
  - APRV-39
  - APRV-40
  - APRV-41
  - APRV-42
  - APRV-43
priority: medium
type: feature
ordinal: 49000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The M5 exit criterion, ordered 2026-08-05: once approvald is the sole log writer, the dogfooding escalation in CLAUDE.md stops being aspirational. Document and enable the workflow where agent sessions route manual-class repo actions (deps.add, network.call, release.publish) through approval request + approval wait against the running daemon, with the Telegram channel live: session proposes, gate holds, phone approves, execution proceeds, log records. Includes the CLAUDE.md edit this requires, drafted in this task for the human to apply by hand (CLAUDE.md is theirs; agents never edit it), replacing the stop-and-escalate interim rule with the daemon-mediated path. Closes with an end-to-end proof: one real dependency add or equivalent manual-class action flowing session -> gate -> phone -> grant -> execution, recorded in the repo public log on main.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Workflow documented: how a session registers, requests, and waits on a manual-class repo action against the running daemon, and what it does on grant, reject, and timeout
- [ ] #2 Repo policy classes for deps.add, network.call, release.publish exist in APPROVAL.md via a human-applied, human-attested edit (drafted here, applied by the human)
- [ ] #3 CLAUDE.md edit drafted for the human: daemon-mediated gate operations replace the stop-and-escalate interim rule; draft delivered in this task, never applied by an agent
- [ ] #4 End-to-end proof executed: one real manual-class action (dep add or equivalent) flows session -> gate -> Telegram on the human phone -> grant -> execution, and the resulting events verify on the committed log on main
- [ ] #5 The proof events are appended by the daemon as sole writer in the primary checkout, never from a worktree
<!-- AC:END -->
