---
id: APRV-131
title: Add Cursor agent orchestration instructions
status: Done
assignee:
  - '@gpt-5.6-sol'
created_date: '2026-08-21 11:07'
updated_date: '2026-08-21 18:27'
labels: []
dependencies: []
modified_files:
  - AGENTS.md
  - .cursor/agents/token-heavy-implementer.md
type: chore
ordinal: 123000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Translate repository working practices from CLAUDE.md into Cursor-native instructions so Cursor agents preserve the project workflow, safety invariants, and dogfood rules. Add a model-pinned coding role so GPT-5.6 Sol can retain orchestration and review while delegating settled, token-heavy implementation work to Claude Opus 5 Thinking High.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Root AGENTS.md captures repository-wide workflow, safety, verification, and approval practices without conflicting with APPROVAL.md or SPEC.md
- [x] #2 A version-controlled Cursor custom agent pins token-heavy implementation work to claude-opus-5-thinking-high and defines its handoff contract
- [x] #3 AGENTS.md tells GPT-5.6 Sol when and how to delegate to the Opus agent, including complete-context prompts and final parent review
- [x] #4 Cursor-specific instructions avoid Claude Code-only hook or model names where they do not apply
- [x] #5 AGENTS.md defines the parent completion loop to commit and push reviewed in-scope changes on a feature branch by default, while excluding approval-log artifacts and never pushing main
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Retain the Cursor-native translation of workflow, SPEC, safety, dogfood, and permissions constraints. 2. Change the token-heavy custom agent and documented fallback from GPT-5.6 Terra Medium to Claude Opus 5 Thinking High. 3. Verify instruction content and repository checks, then record implementation evidence.

4. Document commit-and-push as the parent agent's default completion step for user-authorized implementation work, preserving subagent and protected-log restrictions.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Added root AGENTS.md as the Cursor-wide translation of repository workflow, invariants, Backlog discipline, dogfood rules, permissions, and prose style. Added .cursor/agents/token-heavy-implementer.md with gpt-5.6-terra-medium pinned and a bounded implementation/handoff contract. Kept Sol responsible for decomposition, architecture, safety, approvals, integration, and final review; documented an explicit general-purpose Terra fallback when the named custom agent is unavailable. The exact protected-path edit was granted through the live policy.edit gate before application. Verification: npm run lint passed; approval log verify clean at 338 records; full npm test passed 2029/2029 after removing inherited APPROVAL_HUMAN, NO_COLOR, and FORCE_COLOR values that made three environment-sensitive tests fail in the first unrestricted run. No SPEC.md behavior change.

Follow-up review correction: AC #2 remains open because AGENTS.md and .cursor/agents/token-heavy-implementer.md are untracked until an explicitly authorized commit. The review's missing-envelope concern was based on the Backlog file alone; the harness gate created the approval declaration independently. Log seq 331-334 records task.registered, approval.requested, human grant, and harness execution for the exact two-file content; seq 335-338 records the separately gated actual protected-path edit. No additional envelope on APRV-131 is required for that hook-routed action.

User corrected the desired Cursor worker model from GPT-5.6 Terra Medium to Claude Opus 5 Thinking High. The supported model slug is claude-opus-5-thinking-high; updating the active task before the protected-path edit.

Updated AGENTS.md and .cursor/agents/token-heavy-implementer.md to Claude Opus 5 Thinking High using the supported slug claude-opus-5-thinking-high. The AGENTS.md protected-path edit was granted through the live policy.edit gate; the runtime classified the .cursor custom-agent edit as ungated, while the user's explicit request authorized the model correction. Verification: no Terra references remain in active Cursor instruction files, npm run lint passed, and approval log verify is clean at 346 records. The earlier full suite remains 2029/2029; no runtime code changed.

User requested that the Cursor parent agent complete implementation loops by committing and pushing the reviewed feature branch without a separate prompt. This standing instruction applies unless the user opts out; it does not authorize main-branch pushes or inclusion of .approval log artifacts.

Commit 8ad69c0 tracks AGENTS.md and .cursor/agents/token-heavy-implementer.md. Scripted assertions confirmed the Opus model pin, standing parent authorization, main-branch prohibition, and .approval exclusion. The user explicitly confirmed the completion-loop behavior.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added Cursor-native repository instructions with GPT-5.6 Sol orchestrating Claude Opus 5 Thinking High, plus a standing parent completion loop that commits and pushes reviewed feature-branch work while excluding .approval artifacts and main. Verified with 2029/2029 tests, lint, scripted instruction assertions, a clean 354-record approval log, and commit 8ad69c0.
<!-- SECTION:FINAL_SUMMARY:END -->
