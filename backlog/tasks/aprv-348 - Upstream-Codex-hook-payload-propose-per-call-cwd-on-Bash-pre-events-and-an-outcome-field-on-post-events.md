---
id: APRV-348
title: >-
  Upstream Codex hook payload: propose per-call cwd on Bash pre-events and an
  outcome field on post-events
status: To Do
assignee: []
created_date: '2026-09-17 01:25'
labels:
  - codex
  - upstream
  - hook
dependencies: []
priority: medium
ordinal: 265000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Lane 4b (APRV-311, PR #408, 2026-09-17) confirmed against the installed @openai/codex 0.152.1 envelope that every Bash PreToolUse event carries tool_input keys exactly ["command"], with no per-call cwd or workdir (the event cwd and the hook process cwd both stay at the session root), and that PostToolUse carries no success or failure signal (exit 0 and exit 7 raise the same event with the same empty tool_response and there is no PostToolUseFailure). Those two omissions are what keep native Codex Bash gating refused (hook-unsupported-execution-context) and keep APRV-311 AC1 and its outcome-correlation clause unprovable. Codex is open source, so the fix is an upstream proposal rather than a workaround: an issue and, if welcomed, a pull request against openai/codex adding (a) the effective execution directory of the shell call to the Bash pre-event payload and (b) an outcome field (exit status or success/failure plus a stable call id) to the post-event, with our probe evidence (docs/codex-hook-probe.md, docs/codex-boundary-probe.md, the APRV-311 notes and tests/cli-hook-codex.test.ts fixtures) as the motivating case. The fail-open behaviour on crash, timeout and malformed output is a third, separate ask (a fail-closed option), worth naming in the same issue as a distinct item. Opening the issue and the PR are network.call and vcs.pr actions on a foreign repository: they run through the gate from the primary, never from a worktree. Related: APRV-311, APRV-315, APRV-325, APRV-349.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An issue on openai/codex states the two payload gaps and the fail-open behaviour with reproduction steps against a named version, links our probe docs, and proposes the minimal payload additions; the issue URL is recorded in the task notes
- [ ] #2 If maintainers welcome a change, a pull request implements the payload additions with tests in the Codex repository; its URL and review state are recorded in the notes (a declined issue closes this task with the reason recorded)
- [ ] #3 docs/codex-hook.md and docs/integrations-considered.md name the upstream issue as the condition under which native Codex Bash gating becomes activatable, and APRV-311 references it
- [ ] #4 Every external action (issue, fork push, PR) went through the gate from the primary checkout with the seqs recorded in the notes
<!-- AC:END -->
