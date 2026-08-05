---
id: APRV-36
title: 'Tiered checks: deterministic path classifier'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 13:48'
updated_date: '2026-08-05 14:10'
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
- [x] #1 A classifier (script + npm run check:changed) computes the tier from git-changed paths only, never from an assertion by the changing agent
- [x] #2 Light tier is docs/examples markdown only, with a denylist forcing full regardless of extension: APPROVAL.md, CLAUDE.md, anything under .claude/, SPEC.md, schema and fixture files, and the tiering configuration itself
- [x] #3 A test asserts the classifier cannot classify changes to its own code or config as light
- [x] #4 Light tier runs the doc-guard subset (reintroduction guard, exit-code deepEqual, README/example grep-guards); full tier is the whole suite; ambiguous or unclassifiable paths resolve full
- [x] #5 Documented in CLAUDE-adjacent tooling docs that every merge to main runs the full suite unconditionally and review applies identically to both tiers
- [x] #6 Denylist amended per the 2026-08-10 addendum: backlog/ forces the full tier — task files are markdown but instruction-bearing (acceptance criteria are commands to future worker agents), so an edit to a pending task's criteria is a change to future agent behavior; the self-exemption test covers this path
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent; fable review found nothing to override. The denylist lives as a frozen inline const in the classifier itself (config is the code, so the self-protection constraint covers both with one mechanism); verdicts carry a named reason (empty-path-set, git-state-unreadable, denylisted-path, path-outside-light-allowlist) with unparseable paths kept in the set as full-forcing rather than dropped; the backlog/ addendum entry has dedicated cases asserting forcedBy names backlog/**. Light tier still compiles (the guard imports frozen TS tables); the saving is the ~930 other tests, stated in script and README. Every-merge-runs-full and identical-review are documented in the README section. Verified: 939/939, lint, typecheck.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
scripts/classify-tier.mjs + check:tier/check:changed: deterministic path-based tier classification with a self-protecting inline denylist incl. backlog/, named full-forcing reasons, light tier running the docs-guard subset. +35 tests. Verified: 939/939.
<!-- SECTION:FINAL_SUMMARY:END -->
