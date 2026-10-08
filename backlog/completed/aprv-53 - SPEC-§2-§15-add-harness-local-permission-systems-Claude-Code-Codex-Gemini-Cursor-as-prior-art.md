---
id: APRV-53
title: >-
  SPEC §2/§15: add harness-local permission systems (Claude Code, Codex, Gemini,
  Cursor) as prior art
status: Done
assignee:
  - Carter
created_date: '2026-08-17 09:45'
updated_date: '2026-08-17 09:52'
labels: []
dependencies: []
priority: low
type: docs
ordinal: 52000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC.md §2 compares approval.md against AGENTS.md prose, HumanLayer, LangGraph/OpenAI HITL, A2A/MCP, and mission-control, but omits the harness-local permission systems (Claude Code's permissions allow/ask/deny rules in .claude/settings.json and settings.local.json, Codex CLI approval_policy, Gemini CLI approval modes, Cursor run modes). These occupy a distinct cell in the gap matrix: enforced by the harness, yet not portable across runtimes, with no durable record of who approved what (approvals become config mutations or opt-in telemetry) and no budgets, TTL, or delegation. Also record that permissions.md is not an established convention (the only referent is Claude Code's docs page served as markdown), so it cannot be cited as prior art. Research done 2026-08-17 by an opus subagent; findings in the task implementation notes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 SPEC.md §2 gains a bullet covering harness-local permission systems, stating enforcement, non-portability, absence of an audit record, and absence of budgets/TTL/delegation, with the Claude Code settings.local.json persistence detail
- [x] #2 SPEC.md §15 gains reference lines for Claude Code permissions, Codex CLI approvals, Gemini CLI configuration, and Cursor run modes
- [x] #3 The gap statement in §2 still holds unchanged; no normative section is modified
- [x] #4 Prose follows CLAUDE.md style (limited em dashes, no not-X-but-Y)
- [x] #5 Implementation notes record the permissions.md finding and unverified items
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read SPEC §2 and §15. 2. Add one bullet after the mission-control bullet in §2. 3. Add four reference lines in §15 after mission-control. 4. Run npm test and lint to confirm docs-only change is clean. 5. Record notes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Research by opus subagent 2026-08-17. Findings folded into SPEC §2 (one bullet after mission-control) and §15 (four reference lines). Key facts: Claude Code rules are enforced by the harness (deny → ask → allow, first match; managed settings cannot be overridden; PreToolUse hooks can deny but not override rules); a Bash 'yes, don't ask again' persists an allow rule to .claude/settings.local.json at the repo root, edit approvals are session-only and never written; the only durable trace of decisions is opt-in OpenTelemetry (claude_code.tool_decision with source config|hook|user_permanent|user_temporary|user_abort|user_reject); no budgets, expiry, approver identity, or delegation. Codex CLI: approval_policy × sandbox_mode in ~/.codex/config.toml. Gemini CLI: --approval-mode is a runtime flag, not persisted. Cursor: run modes self-described as best-effort guardrails, older denylist bypassable via && chaining. permissions.md: not an established convention; the only referent is code.claude.com/docs/en/permissions.md (docs page rendered as markdown); agentsmd/agents.md#105 proposes a permissions: frontmatter block inside AGENTS.md instead. Unverified: arXiv 2601.02371 'agent-permissions.json' provenance; Codex/Gemini claims are docs-only, not cross-checked against source. Verification: npm test 1129/1130 pass, sole failure is pre-existing ci-guard better-sqlite3 engines.node check (APRV-50), unrelated; oxlint clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added harness-local permission systems (Claude Code, Codex CLI, Gemini CLI, Cursor) to SPEC §2 gap analysis and §15 references; recorded that permissions.md is not citable prior art. Docs-only; verified with npm test (1129/1130, one pre-existing unrelated failure) and lint.
<!-- SECTION:FINAL_SUMMARY:END -->
