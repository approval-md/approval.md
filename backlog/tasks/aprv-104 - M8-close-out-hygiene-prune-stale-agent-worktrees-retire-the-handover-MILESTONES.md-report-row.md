---
id: APRV-104
title: >-
  M8 close-out hygiene: prune stale agent worktrees, retire the handover,
  MILESTONES.md report row
status: To Do
assignee: []
created_date: '2026-08-19 12:33'
updated_date: '2026-08-20 08:54'
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
- [x] #1 Stale worktrees removed or explicitly kept, with the decision recorded in the notes
- [ ] #2 MILESTONES.md M8 row reads done with the record PR named; docs/HANDOVER.md retired or rewritten for the next session
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Worktrees pruned 2026-08-19 by fable on the human instruction: all 22 agent-* worktrees plus backlog-fork-strategy-ce4e7f and decompose-m0-m1-backlog-effd99 were verified merged into origin/main (git branch --merged) and clean of tracked changes other than hook-written .approval/ files; the one exception, agent-a4756845a04b6d1f1 (APRV-69 era), carried an uncommitted early draft of the README Ceremony four section that main already contains in a later form, superseded; all removed with git worktree remove --force and git worktree prune; the 58 merged local worktree-agent-* branches deleted with git branch -d. Remaining worktrees: the primary and the live session worktree remote-control-f54e71. Remaining for this task: the M8 close (MILESTONES.md row, the M8 report, retiring docs/HANDOVER.md), which waits on APRV-88 AC 2 and APRV-89.

Second live log fork, 2026-08-20, root cause distinct from APRV-101: the human committed the seq 27-47 log advance on a branch (PR 93); switching back to main rewound the WORKING TREE file to the 26-record committed version; the hook (correctly writing to the one primary log per APRV-101) then appended new records onto that rewound file, forking a 7-record tail (seq 27-33: registrations, requests and withdrawals for two denied gated attempts, nothing granted, nothing executed) that chains off seq 26 and can never follow the real seq 47. Resolved per the APRV-101 ruling: main chain kept, forked tail discarded (a copy retained off-repo as evidence); re-chaining is fabrication. FOOTGUN FOR THE RUNBOOK (docs/dogfood-cutover.md) and a v0.2 candidate fix: a branch switch with an uncommitted log rewinds the working file under the daemon and the hook. Mitigations to weigh: commit the advance from the branch WITHOUT switching back until merged and pulled; a doctor check comparing the working log head against the committed head that names the fork; or the append path refusing when the file head hash does not match the last verified head it knew (a stronger cure needing design). Also observed working as intended: the hook fail-closed on the conflicted (corrupt) log, and every stale prompt from the denied attempts was withdrawn on the phone.
<!-- SECTION:NOTES:END -->
