---
id: APRV-192
title: >-
  Dark-session detector: the daemon expects log records from the git activity it
  can see
status: To Do
assignee: []
created_date: '2026-09-01 03:20'
labels:
  - security
  - daemon
  - dogfood
dependencies: []
priority: high
ordinal: 162000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Born from APRV-151's root cause: a session whose harness never invokes the hook leaves NO records, and nothing session-local can notice its own absence. The log needs an expectation of what should be in it, derived from artifacts a session cannot help producing. A daemon (or doctor-on-primary) sweep cross-checks observable session evidence against the log: a new worktree appearing under .claude/worktrees/, commits authored in the incident window, file mtimes on tracked paths, each expected to have matching hook task ids (hook:<session>:<tool-use>) or execution records in the primary log within the same window. A worktree or commit with zero corresponding records is a dark session: raise a machine-readable alarm (event appended through the real path, surfaced by doctor and the Telegram digest), never silently tolerate it. Extends the APRV-42 git-evidence direction from 'log entries must match git' to 'git activity must match log entries'. Detective control, complements the APRV-151 CI grant cross-check (which only sees diffs that reach a PR) by catching sessions that ran dark regardless of what they touched.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A sweep (daemon-scheduled or doctor verb) enumerates worktree creations and commits in a window and cross-checks each against hook/execution records in the verified log
- [ ] #2 A dark session (git activity, zero records) produces a machine-readable alarm event through the real append path, visible in doctor output
- [ ] #3 The two APRV-151 incident shapes, replayed as fixtures, are both detected
- [ ] #4 No false alarm on the primary checkout's human commits (policy ceremony, genesis) - a documented allowlist or heuristic, fail-noisy rather than fail-quiet
- [ ] #5 npm test passes; lint clean
<!-- AC:END -->
