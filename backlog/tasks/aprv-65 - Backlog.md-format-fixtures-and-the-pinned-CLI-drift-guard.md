---
id: APRV-65
title: Backlog.md format fixtures and the pinned-CLI drift guard
status: Done
assignee:
  - '@fable'
created_date: '2026-08-17 16:17'
updated_date: '2026-08-17 18:47'
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
- [x] #1 Regeneration script produces the corpus from the pinned CLI; version recorded beside it
- [x] #2 Drift test fails on mismatch when the CLI is present and skips with a stated reason otherwise
- [x] #3 The writer (round-trip) and loss-detection tests consume this corpus, not hand-written files
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, isolated worktree. 2. scripts/regen-backlog-fixtures.mjs: in a temp dir, backlog init (non-interactive), then the canonical operations (create with description/AC/labels/priority, edit status/assignee, check-ac, append-notes, final-summary, milestone add + assign, subtask via -p, dep), copying each resulting task file plus a shape with an approval envelope hand-inserted then edited (the APRV-60 drop reproduction) into tests/fixtures/backlog/<scenario>/; record CLI version in tests/fixtures/backlog/VERSION. 3. tests/backlog-fixtures.test.ts: when backlog is on PATH and matches VERSION, regenerate to temp and diff against committed corpus (fail loudly on drift; normalise only volatile fields like dates/ids by a documented rule); when absent or version-mismatched, skip with a stated reason. Corpus files exist and parse via core/frontmatter regardless. 4. PR, auto-merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built by Opus subagent on branch aprv-65-backlog-fixtures (2fe6aeb), pushed; PR creation blocked by a GitHub API outage (sustained 503s on graphql) at time of writing, retried once the API recovers. 11 scenarios captured from CLI 1.49.3, generated README+VERSION so they cannot drift from the corpus; normalisation is two line-anchored date regexes, nothing fuzzy; drift guard skip paths verified for absent CLI and version mismatch; idempotence confirmed (two regenerations byte-identical). The APRV-60 reproduction is now the envelope-edit-before/after fixture pair: 1.49.3 drops the entire approval: block on task edit -s, everything else intact. Guard earned its keep immediately: ambient $EDITOR leaked into config.yml under npm and only under npm; child env is now replaced wholesale (throwaway HOME, TZ=UTC, LANG=C, NO_COLOR, TERM=dumb). CLI quirks recorded: init --integration-mode none cannot combine with --agent-instructions none (exits 0 doing nothing); ids uppercase in frontmatter, lowercase in filenames; milestone: is inserted between labels: and dependencies:, so key ordering is part of what the corpus pins. AC 3 (writer and loss-detection consume the corpus) is deferred to APRV-61/63 by construction.

Merged as PR #21 after a sustained GitHub GraphQL outage delayed PR creation and auto-merge arming by roughly an hour (branch was pushed throughout; nothing was at risk). AC 3 remains open by construction until APRV-61 and APRV-63 consume the corpus.

AC 3 closed: tests/task-file.test.ts (APRV-61) and tests/envelope-loss.test.ts (APRV-63) both consume the corpus, the latter using the envelope-edit pair as the reproduction fixture.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Real Backlog.md 1.49.3 task files captured across 11 scenarios by a deterministic regeneration script; drift guard diffs against fresh regeneration when the pinned CLI is present and skips with a stated reason otherwise. The APRV-60 envelope drop is now a committed before/after fixture. Merged as PR #21, 1139 tests.
<!-- SECTION:FINAL_SUMMARY:END -->
