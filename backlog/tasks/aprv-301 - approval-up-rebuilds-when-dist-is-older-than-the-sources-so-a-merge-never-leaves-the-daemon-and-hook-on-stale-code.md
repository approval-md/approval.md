---
id: APRV-301
title: >-
  approval up rebuilds when dist is older than the sources, so a merge never
  leaves the daemon and hook on stale code
status: To Do
assignee: []
created_date: '2026-09-07 23:36'
labels:
  - dogfood
dependencies: []
ordinal: 221000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
After every merge to main the primary's daemon and hook keep running the previous build until someone runs npm run build; the symptom is always phone weirdness (reads routed, taps not landing). approval doctor already has a build-freshness row with the check.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After a successful preflight fast-forward, approval up runs the build when dist is older than any source it is built from, using the same freshness predicate doctor uses, and prints that it did.
- [ ] #2 --no-build opts out; a build failure is reported and up does not start on the stale build.
- [ ] #3 Test coverage through the real preflight.
- [ ] #4 docs/dogfood-cutover.md and docs/cli-reference.md updated.
<!-- AC:END -->
