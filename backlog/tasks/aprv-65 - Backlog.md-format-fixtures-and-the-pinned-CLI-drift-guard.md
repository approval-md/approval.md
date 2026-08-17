---
id: APRV-65
title: Backlog.md format fixtures and the pinned-CLI drift guard
status: To Do
assignee: []
created_date: '2026-08-17 16:17'
labels: []
milestone: m-8
dependencies: []
priority: medium
type: chore
ordinal: 64000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-52 pinned the Backlog.md CLI version and asked that round-trip fixtures catch format drift. Make that a standing guard: a scripted regeneration (scripts/regen-backlog-fixtures.mjs) that runs the pinned CLI in a temp dir to produce the canonical shapes (create, edit, add AC, add notes, milestone assign, subtask), commits the outputs under tests/fixtures/backlog/, and a test that fails if the committed corpus differs from a fresh regeneration when the CLI is present (skips with a stated reason when it is not, so CI on a runner without the CLI stays honest). Also records the exact CLI version in the fixture directory. Deliberate upgrades of the pin regenerate the corpus in the same commit.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Regeneration script produces the corpus from the pinned CLI; version recorded beside it
- [ ] #2 Drift test fails on mismatch when the CLI is present and skips with a stated reason otherwise
- [ ] #3 The writer (round-trip) and loss-detection tests consume this corpus, not hand-written files
<!-- AC:END -->
