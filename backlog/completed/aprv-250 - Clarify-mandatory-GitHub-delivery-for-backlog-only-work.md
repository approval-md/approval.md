---
id: APRV-250
title: Clarify mandatory GitHub delivery for backlog-only work
status: Done
assignee:
  - '@codex'
created_date: '2026-09-04 20:53'
updated_date: '2026-09-04 21:22'
labels: []
dependencies: []
type: docs
ordinal: 193000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-249 was left local despite the repository delivery convention. Clarify AGENTS.md so every authorized repository change, including task creation/refinement and documentation-only work, includes commit, push, PR, merge arming, and truthful delivery status unless the user explicitly opts out. Preserve existing user edits and all approval boundaries. Deployment remains scope-dependent.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Delivery instructions explicitly cover backlog creation/refinement and documentation-only work, with standing authorization for commit, push, PR, and merge arming subject to policy and user scope.
- [x] #2 Instructions distinguish local, pushed, queued, merged, and deployed states and require reporting blockers instead of claiming completion.
- [x] #3 Deployment is required only when in scope; unrelated user edits and protected approval artifacts remain excluded.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Replace only the delivery paragraph in the local and committed versions of AGENTS.md, preserving all other text. 2. Route the protected edit through the primary approval gate. 3. Review the exact diff and run applicable checks. 4. Commit the instruction change and this task on an isolated branch, push, open a PR, arm merge, and report the exact added language and GitHub status.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Replaced only the delivery paragraph in the committed AGENTS.md baseline, preserving the unrelated local rewrite. Exact branch edit was granted through the primary hook (hook:codex-aprv-250:aprv-250-branch). Local-copy update and log-evidence publication remain pending gate requests after timeout; neither denied action was executed. Lint, typecheck, exact-replacement review, and whitespace checks pass. Full suite ran 3086 tests: 3082 passed, 3 failed, 1 skipped; failures are in identity/terminal-environment-sensitive setup and styling tests, now being rerun with those environment settings normalized. No runtime or SPEC changes.

Retest: all 111 tests in cli-setup and cli-style-render passed (exit 0) with APPROVAL_HUMAN/NO_COLOR/FORCE_COLOR unset and TERM=xterm-256color. This resolves all three failures from the full run without source changes. The original design task APRV-249 merged through PR #251.

The local-copy grant arrived at seq 15751 and was verified/consumed by the hook before applying the exact replacement. All other bytes of the local AGENTS.md rewrite were preserved. Delivery remains pending publication of the branch-edit grant evidence through the existing log.advance request; no gate bypass was used.

Delivery: instruction commit 1007af7 pushed on codex/aprv-250-delivery-instructions; PR #252 opened and merge armed. All three full-suite GitHub CI shards passed. The remaining protected-path failure was uncovered-hunk because the committed log predated the grant. Operator granted the existing log.advance request at seq 15753; the hook verified and consumed it before approval log advance --pr executed successfully (exit 0), publishing evidence as records commit 730886b831b7 in PR #255. Its merge is armed. No log artifacts were included in this feature branch. Worktree: /private/tmp/approval-aprv-250; next delivery step is wait for records PR #255, update the branch from main, and verify PR #252 merges.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Expanded delivery requirements to every authorized repository change, including backlog-only work; added commit/push/PR/merge-queue completion and truthful status reporting while keeping deployment scope-dependent. Exact replacement review, lint, typecheck, and whitespace checks passed. Full suite had three environment-sensitive failures; all 111 tests in their two files passed under normalized identity/terminal settings.
<!-- SECTION:FINAL_SUMMARY:END -->
