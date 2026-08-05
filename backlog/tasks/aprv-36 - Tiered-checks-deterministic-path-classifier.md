---
id: APRV-36
title: 'Tiered checks: deterministic path classifier'
status: In Progress
assignee:
  - '@fable'
created_date: '2026-08-05 13:48'
labels: []
milestone: m-6
dependencies: []
priority: medium
type: chore
ordinal: 36000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Human workflow tuning (2026-08-10), hard constraints verbatim in ACs. Motivated by the APRV-33 turn: a docs-only change ran the full 900-test suite. A tier classifier computes light vs full deterministically from changed paths; agents never assert their own tier; merges to main always run full; ambiguity resolves full.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A classifier (script + npm run check:changed) computes the tier from git-changed paths only, never from an assertion by the changing agent
- [ ] #2 Light tier is docs/examples markdown only, with a denylist forcing full regardless of extension: APPROVAL.md, CLAUDE.md, anything under .claude/, SPEC.md, schema and fixture files, and the tiering configuration itself
- [ ] #3 A test asserts the classifier cannot classify changes to its own code or config as light
- [ ] #4 Light tier runs the doc-guard subset (reintroduction guard, exit-code deepEqual, README/example grep-guards); full tier is the whole suite; ambiguous or unclassifiable paths resolve full
- [ ] #5 Documented in CLAUDE-adjacent tooling docs that every merge to main runs the full suite unconditionally and review applies identically to both tiers
<!-- AC:END -->
