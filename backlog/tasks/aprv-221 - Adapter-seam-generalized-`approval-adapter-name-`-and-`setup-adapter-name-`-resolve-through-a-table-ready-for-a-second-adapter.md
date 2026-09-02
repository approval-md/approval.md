---
id: APRV-221
title: >-
  Adapter seam generalized: `approval adapter <name>` and `setup adapter <name>`
  resolve through a table, ready for a second adapter
status: To Do
assignee: []
created_date: '2026-09-02 16:29'
labels:
  - adapter
  - launch
dependencies: []
priority: high
ordinal: 181000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The CLI dispatches the literal `adapter email` (src/cli/adapter.ts) and the registry (src/adapters/registry.ts) returns a one-element list, so a second adapter has nowhere to plug in. This task opens that seam without changing what the email adapter does, so the AgentMail adapter (next task in this stack) lands as a table entry. Context: AgentMail is the launch-scope adapter Carter decided on 2026-09-02; the stack is this task -> adapter -> CLI face -> prefix/SPEC/docs, and APRV-199 (npm publish) depends on the last of them.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `approval adapter email` output and exit codes are byte-identical before and after (existing tests/cli-adapter.test.ts unchanged and green)
- [ ] #2 `approval adapter <unknown>` exits 2 and names the known adapters, driven by the table rather than a literal
- [ ] #3 `setup adapter <name>` help text comes from the ADAPTERS table entry, not a name === "email" branch
- [ ] #4 The MCP server async-unwrap check matches any `adapter <name>` label, not only `adapter email`
- [ ] #5 registry.ts doc comment no longer claims one adapter; declaredCredentialsForClass is covered by a test with two adapters serving one class
- [ ] #6 npm test green, lint clean
<!-- AC:END -->
