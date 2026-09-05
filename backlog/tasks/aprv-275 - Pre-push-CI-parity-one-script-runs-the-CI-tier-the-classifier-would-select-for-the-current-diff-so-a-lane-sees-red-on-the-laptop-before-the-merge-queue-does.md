---
id: APRV-275
title: >-
  Pre-push CI parity: one script runs the CI tier the classifier would select
  for the current diff, so a lane sees red on the laptop before the merge queue
  does
status: To Do
assignee: []
created_date: '2026-09-05 21:16'
labels:
  - ci
  - dx
dependencies: []
priority: medium
ordinal: 203000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Most red CI runs this week were avoidable on the laptop: a row-count pin missed on one platform, a Linux-only temp-root check, a test coupled to the live policy, a conformance manifest regenerated on two branches. Lanes ran suites one file at a time under load and could not afford the full matrix; CI then ran it serially in the merge queue, one PR at a time, and every red cost a re-merge and another queue slot. Outcome: scripts/ci-local.mjs (npm run ci:local) reads the same classify-tier logic .github/workflows/ci.yml uses, prints the tier the diff selects (light, records, full) and runs exactly that tier's jobs locally (docs guard, records guards, protected-path cross-check where computable, the full gate sharded the same way), with the platform-sensitive suites flagged when the host is not Linux; the lane brief and docs/dogfood-cutover.md say to run it before pushing. Why: the queue is serial and every red is a lost slot; the laptop is where red is cheap.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 npm run ci:local on a docs-only diff runs the light tier and on a src diff runs the full gate shards, matching ci.yml's selection for the same diff (test against three fixture diffs)
- [ ] #2 The script reports platform-sensitive suites (temp root, symlinks) when not on Linux and exits non-zero on any red with the failing file names
- [ ] #3 docs updated; npm test passes; lint clean
<!-- AC:END -->
