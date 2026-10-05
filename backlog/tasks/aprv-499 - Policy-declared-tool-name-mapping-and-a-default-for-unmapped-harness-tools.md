---
id: APRV-499
title: Policy-declared tool-name mapping and a default for unmapped harness tools
status: In Progress
assignee: []
created_date: '2026-10-05 22:48'
updated_date: '2026-10-05 23:00'
labels:
  - hook
  - policy
  - harness
  - marketplace
dependencies: []
priority: high
ordinal: 383000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The harness hook classifies a tool call through a per-harness hard-coded rule table (src/cli/hook.ts, hermesToolRule for Hermes). A tool the table does not claim, including every MCP tool mcp__<server>__<tool>, is answered 'not a gated tool' and allowed with no record. The Agent Village wants residents to install third-party apps (MCP servers) from a marketplace with per-app action classes chosen at install time, with no core release per app, and wants every tool call recorded. This task adds a policy key mapping harness tool names to declared classes, and a defaults key saying what happens to a tool nothing maps. Target 0.4.2. SPEC amendment proposal in the notes; SPEC.md itself is attested by Carter, never edited here.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Top-level policy key tools: an ordered list of {match, class}; match is a glob over the harness tool name (* is the only wildcard), class is a concrete class that is an exact key of classes or extends a declared trailing family key; first match wins
- [ ] #2 The hook consults tools only for a call the harness's own tables do not claim (shell, file, read, pass-through tools and the hard-coded rule table keep precedence)
- [ ] #3 A malformed match, a malformed class, or a class absent from classes makes the policy fail to load (schema-invalid), so every class resolves manual
- [ ] #4 defaults.unmapped_tool: record | ask; record = allow and append execution.started under harness.tool.unmapped carrying the tool name; ask = gate under that class as manual; absent = today's allow with no record
- [ ] #5 harness.tool.unmapped resolves through classes like any class; with no rule matching, defaults.unmapped_tool supplies its autonomy (record autonomous, ask manual) instead of defaults.autonomy
- [ ] #6 Tests: exact, glob, precedence vs hard-coded Hermes rules, first match, unknown class rejected, malformed glob rejected, unmapped record/ask/absent; policy schema tests; conformance vectors regenerated and diff read line by line
- [ ] #7 Docs: docs/claude-code-hook.md and docs/hermes-hook.md tool classification sections; CHANGELOG Unreleased; SPEC amendment proposal text in these notes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Resume point: node scripts/run-tests.mjs --only cli-hook (in the worktree), then the conformance regen (npm run build && node scripts/regen-conformance-vectors.mjs)
<!-- SECTION:NOTES:END -->
