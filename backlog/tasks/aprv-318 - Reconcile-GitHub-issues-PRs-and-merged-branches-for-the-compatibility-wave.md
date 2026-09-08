---
id: APRV-318
title: Reconcile GitHub issues PRs and merged branches for the compatibility wave
status: In Progress
assignee:
  - '@codex-astra'
created_date: '2026-09-08 22:40'
updated_date: '2026-09-08 23:15'
labels: []
dependencies: []
priority: high
type: chore
ordinal: 235000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter requested a coordinated remaining-work wave including repository cleanup. The live inventory has six open PRs, five open issues and 305 remote branch names. Reconcile obsolete work against actual main and preserve active quickstart/release work and daemon-owned records.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every open PR and issue has a verified disposition or explicit remaining-work record; completed or superseded items are closed with evidence.
- [ ] #2 Only branches whose current exact tips are demonstrably merged and unowned are removed; active worktrees, unique commits and records delivery refs needed by the gate are preserved.
- [ ] #3 A durable inventory records kept and removed refs with commit IDs and reasons, and GitHub state is checked after changes.
- [ ] #4 Task changes pass records checks and are committed with Codex co-author attribution, pushed and delivered through the merge queue.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Inventory live PRs/issues/branches and worktree ownership from refreshed main. 2. Verify old log PRs as exact committed-log prefixes and old source PRs against replacement commits/tests. 3. Bind specific close/delete operations through the primary policy gate, without shared-history rewrites. 4. Remove only exact merged unowned branch tips, preserving active and unique work. 5. Record unresolved issues as pending tasks and publish reviewed inventory/closeout records.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Live inventory at main2e5fc18: six open PRs, five issues, 305 remote heads. Verified old log PRs281/282/283/285 are byte-exact prefixes (20921/20944/20975/20999 records) of committed main log; all four closed through primary gate, outcomes29977/29980/29983/29986. PR167 superseded by merged PR183 (73c9fea), final implementation693cf79; closed through gate outcome29974, unique alternative branch preserved. Only site PR289 remains open and is being resumed in isolated /private/tmp/approval-site-wave. Issue141 resolved on main, but exact close action is pending manual network.call grant (task codex-aprv-318-close-issue141). Branch inventory selects234 older merged inactive tips after preserving active worktrees including detached tips, recent tips, release/active-task delivery, policy/records refs and unique/unavailable commits. Scratch pre-push guard tests exit0 for approved deletion and exit1 for changed-tip/non-delete; deletion plan is hash-bound, each batch atomic, no force push, pending manual gate task codex-aprv-318-delete-branches. No refs deleted yet. Remaining issues140/139/138/137 mapped to pending APRV321/322/323/324, with249 identity design dependency where applicable.

Four exact merged inactive local branches were removed with git branch -d, each exit0: aprv-276-278-agentmail-release-stack@8246896ee499aecb2db8b721ee27d2b6ddcb6570, claude/rsi-demo-restyle-combined@ac90682cd0f0eba8d7801393021b6ba00a1562a7, demo-paper-restyle@4ef3f4377d92d2d54718c8fd90b6cffef337dab3, rsi-page@e359031290fcc66f53bd52f0ebd0da96c39b1e3e. No remote deletions yet. Durable exact-ref snapshot: docs/repository-reconciliation-2026-09-08.json; pending operations remain explicitly pending.
<!-- SECTION:NOTES:END -->
