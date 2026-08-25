---
id: APRV-133
title: Add native Cursor preToolUse hook adapter
status: Done
assignee:
  - '@grok-4.6-xhigh'
created_date: '2026-08-21 18:56'
updated_date: '2026-08-21 21:37'
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
- [x] #1 approval hook cursor reads Cursor preToolUse JSON on stdin and writes native permission allow or deny JSON on stdout, never ask, exit 0 carrying the verdict
- [x] #2 Shell tool_input.command is classified with the same classifier as Bash; Write and Delete gated only for protected paths, accepting path or file_path
- [x] #3 Unexpected hook failure becomes deny JSON rather than an uncaught throw
- [x] #4 Built-in policy.edit covers .cursor/hooks.json, .cursor/hooks/, and .cursor/agents/ without removing .claude/settings protection
- [x] #5 docs/cursor-hook.md, CLI help, and the verb registry document hook cursor; MCP excludes it the same way it excludes hook claude-code
- [x] #6 SPEC.md names approval hook cursor beside the Claude hook as a pending-sign-off amendment
- [x] #7 A committed .cursor/hooks.json registers preToolUse for Shell|Write|Delete with failClosed true
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Factor harness-neutral gateAndWait/scope from the Claude hook. 2. Add approval hook cursor with native permission JSON, Shell as Bash, Write/Delete via path or file_path. 3. Extend isProtectedPath for .cursor/hooks.json, .cursor/hooks/, .cursor/agents/. 4. Tests, docs/cursor-hook.md, help, verb registry, MCP exclusion. 5. SPEC pending-sign-off amendment, AGENTS.md dogfood paragraph, APPROVAL.md prose if needed. 6. Human-committed .cursor/hooks.json with failClosed preToolUse matcher Shell|Write|Delete.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped a shared runHarnessHook / commandHarnessHook with two adapters. Cursor maps Shell to the classifier and Write|Delete to fileToolGate (accepting path or file_path, plus notebook_path/contents aliases), answers native permission JSON, never ask, defaults --as agent:cursor, and stamps originApp cursor-hook. Throws become deny JSON with exit 0.

Built-in policy.edit now covers .cursor/hooks.json, .cursor/hooks/, and .cursor/agents/ without dropping .claude/settings*. .cursor/rules/ stays ordinary. MCP withholds hook cursor the same way as hook claude-code. SPEC 10.1 lists the verb as pending sign-off (APRV-133); 10.5 withholds three stdin verbs; 13 and M8 name both harness hooks.

.cursor/hooks.json is failClosed preToolUse, matcher Shell|Write|Delete, 600s, --dir pinned to the primary checkout, --timeout 9m. Matcher does not include StrReplace (plan v1). Cloud Agents remain out of scope. No new dependencies.

npm test: 2039 pass, 0 fail (run with APPROVAL_HUMAN/NO_COLOR/FORCE_COLOR deleted; env -u is opaque under the live Cursor hook).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added approval hook cursor (native allow/deny JSON, Shell/Write/Delete, fail-closed .cursor/hooks.json) plus docs, classifier, MCP exclusion, and SPEC pending-sign-off. Verified with npm test (2039 pass, 0 fail) and tests/cli-hook-cursor.test.ts.
<!-- SECTION:FINAL_SUMMARY:END -->
