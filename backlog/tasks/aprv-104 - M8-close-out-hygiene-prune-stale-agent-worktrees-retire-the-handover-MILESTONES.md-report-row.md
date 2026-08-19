---
id: APRV-104
title: >-
  M8 close-out hygiene: prune stale agent worktrees, retire the handover,
  MILESTONES.md report row
status: To Do
assignee: []
created_date: '2026-08-19 12:33'
labels:
  - hygiene
milestone: m-11
dependencies: []
priority: low
ordinal: 96000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Housekeeping for the M8 close. (1) Fourteen agent-* worktrees under .claude/worktrees/ (agent-a18b20baeef683dd7 a1b22f898af23c08b a294a6e52bddaa26d a4509ab419a4fec24 a4756845a04b6d1f1 a478062e337fe8816 a4ce467fa35b06771 a54c99a4dc1f3f925 a793b15edede3e2a4 a8cb7c806f30ce35e aaa11155a5a9c75c6 aad6cb479eb078d40 ab64cb51ab4f0c97d ad04d2a21fa9359cc) plus backlog-fork-strategy-ce4e7f and decompose-m0-m1-backlog-effd99 are left from merged builds; removal is the human call since a worktree may hold uncommitted work (git -C <wt> status before git worktree remove; then git worktree prune and delete the merged worktree-agent-* branches). (2) When M8 closes: MILESTONES.md row m-11 to done with the record PR, the M8 report, and docs/HANDOVER.md retired per its own header. (3) Note for the record: the remote-control worktree carried a stale node_modules without the SDK; builders should npm ci in a worktree rather than symlink.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Stale worktrees removed or explicitly kept, with the decision recorded in the notes
- [ ] #2 MILESTONES.md M8 row reads done with the record PR named; docs/HANDOVER.md retired or rewritten for the next session
<!-- AC:END -->
