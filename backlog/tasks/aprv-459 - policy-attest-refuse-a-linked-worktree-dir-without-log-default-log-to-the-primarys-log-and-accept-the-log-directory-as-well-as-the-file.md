---
id: APRV-459
title: >-
  policy attest: refuse a linked worktree --dir without --log, default --log to
  the primary's log, and accept the log directory as well as the file
status: To Do
assignee: []
created_date: '2026-10-04 09:22'
labels:
  - dogfood
dependencies: []
priority: high
ordinal: 346000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Evidence 2026-10-04 (Carter at the terminal, the primary at /Users/carter/dev/approval-md). On 2026-10-03 21:32Z Carter ran approval policy attest --path SPEC.md --dir <the PR #569 worktree> --as human:carter with no --log; the sign-off was appended to that worktree's own copy of .approval/log/events.jsonl as seq 72713, a fork of the committed chain the protected-paths guard never reads, and PR #569 stayed red for about twelve hours while everyone believed SPEC was attested. When the command was redone with --log it was first given the log DIRECTORY and failed EISDIR: illegal operation on a directory; the guard's own fix text says --log <the primary checkout's log>, which reads as the directory. The verb knows it is in a linked worktree (git rev-parse --git-common-dir differs from --git-dir) and knows the primary's log path from it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 In a linked worktree, attest without --log refuses with a distinct code naming the primary's log path and the exact command, or (flagged choice) defaults --log to the primary's events.jsonl and prints that it did so; a test covers the worktree case
- [ ] #2 --log accepts the .approval/log directory and the events.jsonl file alike; the guard's fix text and docs/cli-reference.md print the file path
- [ ] #3 approval doctor warns when a linked worktree's log copy is ahead of the committed baseline by a human record (a stranded sign-off), with the recovery sentence
<!-- AC:END -->
