---
id: APRV-345
title: >-
  Sign off the APRV-335 and APRV-336 SPEC amendments: drop the pending markers
  under a human grant
status: In Progress
assignee:
  - '@claude-fable'
created_date: '2026-09-16 18:33'
updated_date: '2026-09-16 21:56'
labels:
  - spec
dependencies: []
priority: medium
ordinal: 262000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC.md line 139 (bare supervised deprecated, APRV-335) and line 160 (values block 0.2, APRV-336) carry '(Amended APRV-n, pending sign-off.)'. Carter designed both alongside the agent and ratified them on 2026-09-16. Under SPEC's amendment-provenance rule (APRV-181) the ratification that CI accepts is a granted edit to the file, so the two suffixes are dropped by two hook-gated Edits issued while the daemon is down (every policy.edit.spec action then gates to the human), granted from Telegram once the daemon is back, and the grants published with approval log advance --pr before the pull request's guard check runs. The two other edits of that stack (the glossary row at line 64 and the example policy line at line 99) were granted at seq 31605 and 31610 and carry no marker. The pending markers elsewhere in SPEC.md belong to other tasks and are not touched.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 SPEC.md lines 139 and 160 end in '(Amended APRV-335.)' and '(Amended APRV-336.)' respectively; no other line changes
- [ ] #2 Both edits are human grants in the log (approval.granted by human:carter) and the pull request's protected-path check passes on them
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Branch from main in this worktree. 2. Two Edit-tool edits on SPEC.md lines 139 and 160 issued while the daemon is down, so each gates to Carter; Carter grants from the terminal (approval grant <key>), the retry adopts the grant. 3. Carter publishes the grants with approval log advance --pr; the PR's protected-path check reads them. 4. Commit, PR, arm.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Both edits granted by human:carter from the CLI (daemon down, so each hook question gated at 100%): line 139 via hook question toolu_01743JJcfqVdHhVgZkocyVVn (requested seq 31958), line 160 via toolu_01CUNL17hT1sUgxTkGVJhT2b. Diff is exactly the two suffixes. Two stray questions (a sed, toolu_01BZRvprhTXP1GZt5EaFc6Wi, and a git add naming the file, toolu_01RkxDMNJM3Ph1U5EfpShSJs) were abandoned unanswered and expire by TTL: naming SPEC.md on a shell command classifies policy.edit.spec even for git add. AC2 is checked once the grants are advanced and the PR's guard check passes.

Redone on branch aprv-345-spec-signoff-2 after the primary's working log forked: the amend runbook's trailing 'git checkout main' rewound APPROVAL.md and events.jsonl to main's older copies, so the first two grants (fork seqs ~31990 and 31999) sat on a chain main never had. The fork was snapshotted to ~/approval-log-fork-2026-09-16.jsonl and discarded, the working log restored byte-identical to main through seq 32577, and PR #400 closed. New grants on the true chain: line 139 at seq 32591 (question toolu_01CVgGgTEhz6mPG2g8b2XWMQ), line 160 at seq 32598 (toolu_01MjT4k1waGfs3xBUM2DRLQH), both human:carter from the CLI with the daemon down. Lesson recorded on APRV-341: the amend's git half must build its commit in a scratch index and never switch the working tree.
<!-- SECTION:NOTES:END -->
