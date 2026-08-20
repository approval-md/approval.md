---
id: APRV-112
title: >-
  CI records tier: backlog-only diffs run the tests that read backlog, not the
  full matrix
status: In Progress
assignee: []
created_date: '2026-08-20 09:11'
updated_date: '2026-08-20 15:28'
labels:
  - ci
  - dx
milestone: m-12
dependencies: []
priority: medium
ordinal: 104000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Human feedback 2026-08-20: record-only PRs through the full CI gate are slowing the cadence. Today classify-tier.mjs knows two tiers, and backlog/** is on the force-full denylist with the rationale that acceptance criteria are instructions to future agents. That rationale argues for review (which applies identically to every tier) and for running the tests that READ backlog, of which there are exactly three: tests/milestones-guard.test.ts, tests/backlog-fixtures.test.ts, and tests/docs-guard.test.ts (the retired-name sweep excludes backlog/ but reads the tree). It does not argue for the 1800-test matrix on both Node majors, which cannot observe a task file. DESIGN: (1) classify-tier.mjs gains a records tier: chosen only when EVERY changed path is under backlog/ (tasks, drafts, docs, decisions, milestones); any other path in the diff, including MILESTONES.md (read by a guard the records tier runs, so actually INCLUDE MILESTONES.md in the records set: builder verifies which tests read it and includes exactly those), escalates exactly as today (ambiguity resolves to full, empty set resolves to full). (2) The records tier runs the three reading tests via the same run-tests.mjs entry, single Node version (the floor, 20), no lint/typecheck (no code changed; but tsc IS needed to build the tests: use the prebuilt approach the light tier uses, or build only what those tests import; builder decides and documents). (3) ci.yml: the records tier is a distinct required check satisfying the same gate as the full tier, matching how the light tier already works. (4) The classify-tier test suite pins: pure-backlog diff -> records; backlog+src -> full; backlog+README -> full (or light+records escalation to full, simplest is full); empty -> full. (5) docs: README Running-the-checks section and the tier table. NOTE the workflow file is protected (policy.edit): the PR carrying .github/workflows changes waits on the human tap, which is correct. ALSO recorded as adopted practice, no code: plans and implementation notes ride the feature branch (written by the orchestrator via the backlog CLI in the builder worktree or on the branch before merge); post-merge finalizations batch into one records PR per wave. And a recommendation for the human, one click: enable the GitHub merge queue on main so the strict up-to-date rule stops forcing manual branch re-syncs; the queue preserves the every-merge-tested-on-latest-main guarantee.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 classify-tier resolves a pure-backlog (and exactly-the-files-the-guards-read) diff to a records tier; mixed or empty diffs resolve to full; pinned by tests
- [ ] #2 The records tier runs milestones-guard, backlog-fixtures and docs-guard on one Node version and is wired in ci.yml as a required check like the light tier
- [ ] #3 README Running-the-checks updated; npm test and lint clean; the ci.yml change lands behind the policy.edit gate
<!-- AC:END -->
