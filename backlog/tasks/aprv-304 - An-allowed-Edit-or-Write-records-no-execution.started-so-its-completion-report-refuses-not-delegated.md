---
id: APRV-304
title: >-
  An allowed Edit or Write records no execution.started, so its completion
  report refuses not-delegated
status: To Do
assignee: []
created_date: '2026-09-08 04:35'
labels:
  - harness
dependencies: []
ordinal: 224000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Since APRV-303 the post-execution hook surfaces its refusals at exit 2. Every Edit/Write tool call on an unprotected file now prints post-tool-gate-refused:not-delegated, because the pre-execution path allows the ordinary edit outright without appending an execution.started, so the completion has nothing to close. Harmless (the edit ran, nothing is appended), but it is noise on every edit and it means allowed edits never appear in the log as executions at all, while allowed Bash calls do.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The pre-execution path records an execution.started for an allowed Edit/Write on an unprotected file the same way it does for an allowed Bash call, or the design decision not to is written in SPEC 10.1 and the post path exits 0 quietly for that case; one of the two, stated in the notes
- [ ] #2 No not-delegated line on an ordinary Edit in a Claude Code session; a test in tests/cli-hook.test.ts covers PreToolUse allow followed by PostToolUse for an Edit through the real append path
- [ ] #3 docs/claude-code-hook.md describes what an allowed edit leaves in the log
<!-- AC:END -->
