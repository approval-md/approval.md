---
id: APRV-101
title: >-
  hook claude-code: --dir must scope the log as well as the policy; refuse in a
  worktree when the primary log is unreachable
status: To Do
assignee: []
created_date: '2026-08-18 22:33'
updated_date: '2026-08-18 23:39'
labels:
  - bug
  - dogfood
  - cli
dependencies: []
priority: high
ordinal: 93000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found 2026-08-18: after a session in an agent worktree, the WORKTREE's .approval/log/events.jsonl held 21 task.registered (files.write.workspace) records by agent:claude-code while the primary checkout's log received nothing. Root cause in src/cli/hook.ts: .claude/settings.json invokes the hook with --dir pointing at the primary checkout, but --dir scopes only the policy (gateOptions); the log path is resolved from the process cwd, which in a worktree session is the worktree. Policy from the primary, records to a dead-end log that must never be committed (its chain forks from main's tail and merges do not reconcile hash chains). Silent, and exactly the 'unlogged work' failure mode CLAUDE.md names. Decision with the human: ONE log. The hook appends to the primary checkout's log through the existing append lockfile, and refuses closed with a machine-readable code when it cannot, rather than creating a log where it stands. Registration noise is a policy matter (class autonomy), not a reason to drop records. Rejected: per-worktree logs merged later (re-appending events is fabrication).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 When --dir is given and --log is not, the hook's log path is <dir>/.approval/log/events.jsonl, never cwd-relative; an explicit --log still wins
- [ ] #2 When neither is given, the hook resolves the primary checkout (the common git dir) and uses its .approval/log; a plain checkout resolves to itself
- [ ] #3 In a worktree with no reachable primary log, the hook refuses closed with a distinct machine-readable code and a one-line fix; it never creates .approval/log inside a worktree
- [ ] #4 Every append still goes through the append lockfile and compare-and-append (SPEC section 11 global invariants); the implementation notes say so
- [ ] #5 Tests use a throwaway worktree to prove records land in the primary log and none appear in the worktree; the refusal case is covered
- [ ] #6 The dogfood runbook and the agent-instructions wording are reconciled with the chosen behaviour (write-through to primary, or refusal); the human's pick is recorded in the notes
- [ ] #7 npm test and lint clean
<!-- AC:END -->
