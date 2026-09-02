---
id: APRV-234
title: >-
  Daemon advance stacks on the day's records branch and goes DIRTY when main
  moves the log: rebuild the branch on the remote tip, or fall back to a fresh
  branch
status: In Progress
assignee:
  - 'agent:opus-lane-r'
created_date: '2026-09-02 20:19'
updated_date: '2026-09-02 20:53'
labels:
  - daemon
  - bug
dependencies: []
priority: high
ordinal: 189000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Seen 2026-09-02: PR #240 (records-log-2026-09-02, opened by the daemon's cadence advance) went DIRTY after the seq 13704 ceremony commit landed on main with its own copy of the log; the daemon kept stacking new advance commits (13986, 13990, 13994, 13997, 14002, 14006) on the branch tip, each built on the branch rather than on origin/main, so the conflict persisted and the PR could not merge without a hand merge (done by the orchestrator with git merge -X ours origin/main; note that -X theirs truncates the log, since git's theirs is the branch being merged in). APRV-203 made the ceremony verbs build their commit on the remote tip through a scratch index; the daemon's same-day reuse of an existing branch bypasses that. Outcome: when the day's branch exists and origin/main has moved the log or QUEUE.md since the branch's base, the advance rebuilds the branch's commit on the current origin/main (the working log is a superset of main's by the log-advance preconditions, so the rebuilt commit is main plus the appended tail; if it is not a superset, refuse with the existing remote-diverged code) and pushes by refspec; when the branch has a queued or dirty PR, either update it in place or open a fresh branch (records-log-<date>-<n>) and say which. The daemon never merges (APRV-204), unchanged. Why: a records PR the daemon cannot land on its own is a tap it promised to remove.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A test with a bare remote where main gains a commit touching the log after the day's branch was pushed proves the next advance produces a branch that merges cleanly into main and whose log is byte-identical to the working log
- [ ] #2 A working log that is not a superset of main's committed log refuses with a distinct machine-readable code and pushes nothing
- [ ] #3 The daemon's advance DaemonEvent and the log-advance-cadence doctor row say whether the branch was rebuilt and on which base
- [ ] #4 npm test passes; lint clean
<!-- AC:END -->
