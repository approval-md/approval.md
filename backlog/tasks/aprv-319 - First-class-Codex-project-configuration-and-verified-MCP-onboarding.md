---
id: APRV-319
title: First-class Codex project configuration and verified MCP onboarding
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-08 22:43'
updated_date: '2026-09-08 22:49'
labels: []
dependencies: []
priority: high
type: feature
ordinal: 236000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter expects a version-controlled .codex folder and a usable Codex entry point. Ship supported portable project configuration and onboarding for the existing gate through Codex MCP, while keeping unsafe native hook activation opt-in and clearly bounded. Preserve the primary checkout gate, user sandbox settings, trust choices and untracked local carryover.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A committed .codex configuration provides a supported usable Codex MCP entry point with stable agent identity and explicit gate root.
- [ ] #2 Configuration and launcher behavior are verified with the installed Codex parser and scratch MCP discovery/execution, including nested directories and linked worktrees or a tested explicit setup path.
- [ ] #3 No repository configuration weakens native approval or sandbox settings, enables failing-open hooks by default, reads credentials, or impersonates a human.
- [ ] #4 Docs and diagnostics distinguish MCP availability, trust, observed gated operation and known native Bash/outcome limits; tests cover refusals and malformed setup.
- [ ] #5 Reviewed changes and protected-file evidence pass applicable checks and are delivered to GitHub with Codex co-author attribution.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Commit a portable MCP-only .codex layer using npm run from nested directories to locate the repository launcher, preserving all native sandbox/approval/trust defaults. 2. Resolve and verify primary checkout from common Git directory and keep every gate subprocess there with explicit primary policy/log pins; preserve active-worktree context only through verified supported tool arguments. 3. Prepare exact protected config/package payloads outside live paths for primary-gate execution. 4. Test real MCP discovery/read-only tools in scratch primary/nested/linked-worktree layouts, malformed/non-Git refusal, safe-key config and installed Codex parsing. 5. Document review/build/trust/discovery/rollback and distinguish voluntary MCP from native interception. 6. Parent reviews source and security, runs required checks, delivers exact config evidence separately, and merges feature with Codex co-author credit.
<!-- SECTION:PLAN:END -->
