---
id: APRV-132
title: Pin Cursor orchestration to Grok 4.6 Extra High
status: Done
assignee:
  - '@grok-4.6-xhigh'
created_date: '2026-08-21 18:55'
updated_date: '2026-08-21 18:59'
labels: []
dependencies: []
type: chore
ordinal: 124000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Cursor sessions in this repository should use Grok 4.6 Extra High as both orchestrator and token-heavy worker. APRV-131 still names GPT-5.6 Sol and Claude Opus 5 Thinking High, which no longer matches the models this workspace can spend.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Root AGENTS.md names Grok 4.6 Extra High as the Cursor orchestrator and as the token-heavy worker, with Task/custom-agent slug cursor-grok-4.6-xhigh
- [x] #2 The version-controlled /token-heavy-implementer custom agent pins model cursor-grok-4.6-xhigh and describes the Grok parent
- [x] #3 CLAUDE.md is left unchanged
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Gate policy.edit on AGENTS.md and .cursor/agents/token-heavy-implementer.md. 2. Replace Sol/Opus names with Grok 4.6 Extra High and slug cursor-grok-4.6-xhigh. 3. Verify instruction files, then record evidence.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Gated AGENTS.md through the live policy.edit hook (session cursor-aprv-132-agents). Pinned Grok 4.6 Extra High / cursor-grok-4.6-xhigh in AGENTS.md and .cursor/agents/token-heavy-implementer.md. Scripted assertions confirmed the slug, parent/worker prose, and absence of Sol/Opus names. git diff --stat -- CLAUDE.md was empty.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Pinned Cursor orchestration to Grok 4.6 Extra High (slug cursor-grok-4.6-xhigh) in AGENTS.md and the token-heavy custom agent. Verified with scripted instruction assertions and an empty CLAUDE.md diff. AGENTS.md edit was granted through the live policy.edit gate.
<!-- SECTION:FINAL_SUMMARY:END -->
