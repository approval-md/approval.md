---
id: APRV-357
title: >-
  Protected-path guard: exact replay of a chain of small edits on a large file
  stays inside its byte budget
status: To Do
assignee: []
created_date: '2026-09-17 20:09'
labels:
  - guard
  - ci
  - spec
dependencies: []
priority: medium
ordinal: 274000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed on PR #427 (APRV-324, 2026-09-17). Every SPEC.md edit on the PR had proceeded under policy.edit.spec and left its execution.started record, and every record was on the records branch the guard read (through seq 42403), yet the guard refused SPEC.md as uncovered-hunk with the reason that exact BASE-to-HEAD replay was refused after reaching its byte limit. The same PR touched design/channel-sender-identity.md over the same three rounds and that file reconstructed byte for byte from five records. The difference is the file: SPEC.md is over 200 KB, the lane made many Edit-tool edits to it across three rounds including edits to its own earlier edits, and 29 records named the path within the window. The guard fell back to per-record matching, which it rightly says is not coverage, and the only way out was a human whole-file sign-off (APRV-338), which is weaker evidence than the grants that actually existed. A contrast case the same day: PR #432 edited SPEC.md in two commits with three records and replayed exactly once the records were present, so the number of commits is not the trigger; the size of the replay is. APRV-340 already gave the guard a line-local exact replay for a single fragment edit on a long line without the full-file budget. Extend that idea to a chain: replay a sequence of line-local edits (each binding lines out and lines in) against the base blob without materializing the whole file per step, or budget by bytes actually changed rather than by file size times records, so an honest chain of small edits on a large file is covered by the evidence it has. The guard must stay exact: no partial coverage, no fuzzy matching, and a chain that does not reconstruct HEAD byte for byte still fails. Carter approved filing on 2026-09-18. Evidence is one case; the task should first reproduce it from the PR #427 history. Related: APRV-316, APRV-337, APRV-339, APRV-340, APRV-338.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The PR #427 case is reproduced as a test fixture built through the real append path: a large file, a chain of small Edit-tool edits including edits to earlier edits, all records present, and the current guard refusing on its byte limit
- [ ] #2 The guard covers that fixture by exact replay within its budget, and its finding names the replayed records in order as it does today; the budget rule is documented in the guard header and docs/git-evidence.md or the guard doc
- [ ] #3 Exactness is unchanged: a chain missing one record, a record whose after-state was later altered outside the log, and a reordered chain each still fail uncovered-hunk, with tests; no fuzzy or partial coverage is introduced
- [ ] #4 Guard runtime on the fixture stays within the CI job budget (measured and recorded); build, typecheck, lint and the guard suites pass
<!-- AC:END -->
