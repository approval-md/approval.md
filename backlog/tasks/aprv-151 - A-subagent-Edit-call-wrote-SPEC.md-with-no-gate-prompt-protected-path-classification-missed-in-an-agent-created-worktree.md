---
id: APRV-151
title: >-
  A subagent Edit call wrote SPEC.md with no gate prompt: protected-path
  classification missed in an agent-created worktree
status: To Do
assignee: []
created_date: '2026-08-29 20:41'
labels:
  - security
  - hook
  - dogfood
  - bug
dependencies: []
priority: high
ordinal: 136000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-08-29 during the APRV-145 design landing. A subagent session working in the worktree .claude/worktrees/aprv-145-land (created with git worktree add from the primary) applied an Edit-tool change to SPEC.md — a protected path whose edits classify policy.edit and require a Telegram tap — and NO prompt was raised: the edit applied silently and was committed (since reverted; the same edit was then re-applied from the orchestrating session, where the hook classified it policy.edit and prompted normally, proving the path is protected for that session). The same evening, other subagent sessions in workflow-created worktrees DID have their SPEC.md Edit calls classified and gated (policy.edit timeouts recorded overnight), so the bypass is not simply "subagents are unhooked"; something about that session or worktree let a protected-path write through. Impact: the dogfood control on SPEC/policy edits can be silently bypassed by an agent session with the wrong (or missing) hook wiring, and nothing surfaces the gap — the edit does not even leave a refused-request record. Investigate: which sessions carry the PreToolUse hook for Edit/Write and why this one did not (settings inheritance in spawned sessions? worktree cwd at session start? hook matcher scope?); whether the hook can fail CLOSED for tool-call classes it never sees (a session-level doctor check, or a repo guard that detects protected-path diffs lacking a matching grant in the log); and whether a CI-side guard should verify that every SPEC.md/APPROVAL.md change reaching a PR has a corresponding policy.edit grant in the committed log window. The last idea turns the append-only log into the audit trail for exactly this bypass and fails the PR rather than trusting session wiring.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Root cause identified and recorded: why this session Edit call on SPEC.md was never classified while sibling sessions were
- [ ] #2 A fail-closed detection exists for protected-path writes that bypassed classification (session doctor check, repo guard, or CI-side grant cross-check), tested
- [ ] #3 The overnight bypass instance is reconstructed in the notes: which commit, which worktree, and the remediation that re-applied the edit through a granted policy.edit
- [ ] #4 npm test passes; lint clean
<!-- AC:END -->
