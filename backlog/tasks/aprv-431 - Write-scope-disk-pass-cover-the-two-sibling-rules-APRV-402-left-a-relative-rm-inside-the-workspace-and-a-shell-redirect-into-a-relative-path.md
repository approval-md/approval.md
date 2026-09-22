---
id: APRV-431
title: >-
  Write-scope disk pass: cover the two sibling rules APRV-402 left, a relative
  rm inside the workspace and a shell redirect into a relative path
status: To Do
assignee: []
created_date: '2026-09-22 03:09'
labels:
  - hook
  - classifier
dependencies: []
priority: medium
ordinal: 329000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-402 (PR #536) added a disk pass that re-reads a workspace-write segment's destination and tightens it to files.delete.out_of_scope when it resolves outside the working directory and every scratch root. Two rules reach files.write.workspace by the same text-only reasoning and were deliberately left out because the criterion enumerated the rows to cover: rm-workspace (a relative rm inside the workspace, refineRm's last branch) and redirect-write (a shell redirect into a relative path, echo x > build/y). rm-workspace is the sharper one because it destroys. Each is one entry in WRITE_SCOPE_RULES in src/cli/hook.ts plus tests in tests/cli-hook-write-scope.test.ts mirroring the existing rows, and a conformance vector each if the read-scope suite pattern applies. Filed from Lane D's implementation notes on APRV-402.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 rm-workspace and redirect-write are in WRITE_SCOPE_RULES, with a test per rule showing a symlinked or absolute-outside destination tightens and an inside one does not
- [ ] #2 docs/claude-code-hook.md's write-scope section lists both rules and the changelog names them
- [ ] #3 build, typecheck, lint, cli-hook-write-scope, cli-hook, conformance and conformance-regen pass
<!-- AC:END -->
