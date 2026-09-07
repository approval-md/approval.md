---
id: APRV-300
title: >-
  approval up preflight handles an untracked backlog task file that the
  fast-forward would overwrite
status: To Do
assignee: []
created_date: '2026-09-07 23:35'
labels:
  - dogfood
dependencies: []
ordinal: 220000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On 2026-09-07 approval up refused its preflight fast-forward because backlog/tasks/aprv-299 existed untracked in the primary (filed there with backlog task create) while main carried the same path committed by the lane's PR; the primary copy was a strict subset of main's. The refusal's next-steps text pointed at git status and offered no way to tell whether the file was disposable.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 When the fast-forward would overwrite an untracked file under backlog/tasks/, the preflight diffs it against the incoming tree's copy; byte-identical means it is removed and the merge continues.
- [ ] #2 When the untracked copy differs, the preflight moves it aside to a named location outside the repo (printed in the output) and continues, only if every line of the untracked copy also appears in the incoming copy; otherwise it refuses with the two paths and a line count of what the untracked copy has that main lacks.
- [ ] #3 Files outside backlog/tasks/ keep the current refusal.
- [ ] #4 Tests through the real preflight path in tests/cli-up*.test.ts or the equivalent; docs/dogfood-cutover.md sync section describes the behaviour.
<!-- AC:END -->
