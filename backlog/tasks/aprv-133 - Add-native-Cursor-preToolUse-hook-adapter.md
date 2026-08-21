---
id: APRV-133
title: Add native Cursor preToolUse hook adapter
status: To Do
assignee: []
created_date: '2026-08-21 18:56'
labels: []
dependencies:
  - APRV-132
references:
  - docs/claude-code-hook.md
  - src/cli/hook.ts
  - 'https://cursor.com/docs/hooks.md'
type: feature
ordinal: 125000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Local Cursor Agent tool calls currently bypass the gate that Claude Code PreToolUse already hits. Cursor has native preToolUse hooks. Add approval hook cursor that classifies Shell/Write/Delete, resolves APPROVAL.md, waits on manual classes, and answers native permission JSON. Fail closed in .cursor/hooks.json. Cloud Agents are out of scope.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval hook cursor reads Cursor preToolUse JSON on stdin and writes native permission allow or deny JSON on stdout, never ask, exit 0 carrying the verdict
- [ ] #2 Shell tool_input.command is classified with the same classifier as Bash; Write and Delete gated only for protected paths, accepting path or file_path
- [ ] #3 Unexpected hook failure becomes deny JSON rather than an uncaught throw
- [ ] #4 Built-in policy.edit covers .cursor/hooks.json, .cursor/hooks/, and .cursor/agents/ without removing .claude/settings protection
- [ ] #5 docs/cursor-hook.md, CLI help, and the verb registry document hook cursor; MCP excludes it the same way it excludes hook claude-code
- [ ] #6 SPEC.md names approval hook cursor beside the Claude hook as a pending-sign-off amendment
- [ ] #7 A committed .cursor/hooks.json registers preToolUse for Shell|Write|Delete with failClosed true
<!-- AC:END -->
