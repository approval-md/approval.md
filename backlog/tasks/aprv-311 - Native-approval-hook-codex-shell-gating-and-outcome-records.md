---
id: APRV-311
title: Native approval hook codex shell gating and outcome records
status: To Do
assignee: []
created_date: '2026-09-08 07:24'
labels: []
dependencies:
  - APRV-310
references:
  - 'https://learn.chatgpt.com/docs/hooks'
priority: high
type: feature
ordinal: 229000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User-authorized overnight Codex integration. Binding SPEC 6.3,7,9,10,11.1. Isolated branch; no live installation, credential access or deployment. Morning activation remains a separate pending task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Bash reuses verified gate policy, budgets, waits and grant carryover with Codex actor/harness provenance.
- [ ] #2 Malformed/unexpected input denies; stable ids correlate success/failure reports, duplicates refuse and unknown outcomes append nothing.
- [ ] #3 Runtime/schema/registry/MCP exclusion support codex; Claude and Cursor regression tests pass.
<!-- AC:END -->
