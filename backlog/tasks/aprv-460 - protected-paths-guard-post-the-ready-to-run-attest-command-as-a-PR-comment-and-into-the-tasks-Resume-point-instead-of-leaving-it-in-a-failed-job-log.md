---
id: APRV-460
title: >-
  protected-paths guard: post the ready-to-run attest command as a PR comment
  and into the task's Resume point instead of leaving it in a failed job log
status: To Do
assignee: []
created_date: '2026-10-04 09:22'
labels:
  - dogfood
dependencies: []
priority: high
ordinal: 347000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Evidence 2026-10-04: core #569, #574, #575 and #576 all failed protected paths (grant cross-check) with a message that already contained the exact repair (approval policy attest --path <file> --dir <a checkout at this commit> --log <the primary log> --as human:<id>, which must hash to <digest>). Nobody saw it until an orchestrator read gh run view --log-failed; the human was told a vaguer version three times over Telegram relays and typed it wrong twice (wrapped lines, the log directory instead of the file). The guard runs in CI with the PR number and the task id in reach.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 On a no-evidence verdict the workflow posts (or updates, one comment per PR) a comment with one copy-paste block per failing path: the full attest line with the real worktree-agnostic form (--dir <path to a checkout at sha> spelled as a git worktree add line plus the attest line) and the digest, followed by the advance line
- [ ] #2 The same block is appended to the owning task's notes as Resume point when the PR title names a task id, via the backlog CLI, in a commit on the PR branch only if the branch is not protected-path-bearing (else comment only)
- [ ] #3 docs/ci-verdict.md and docs/claude-code-hook.md describe the comment
<!-- AC:END -->
