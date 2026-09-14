---
id: APRV-336
title: >-
  Values block v2: fold `wants` into `like`, schema and loader cut to version 2,
  SPEC §5.3 amended, draft block for this repo
status: To Do
assignee: []
created_date: '2026-09-14 04:05'
labels: []
dependencies:
  - APRV-334
references:
  - docs/proposals/repo-values-block.md
ordinal: 254000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The values block separates `wants` (behaviour asked of the agent) from `like` (what the work is graded by). Carter finds the distinction thin and wants one list. Decision: bump `version` to the integer 2 and drop `wants`; a version-1 block is refused by the values loader with a message naming the migration (fold wants into like, set version: 2). Only this repo carries a values block and the block is inert guidance (SPEC §11.1 invariant 10), so a hard cut is cheaper than dual-version loading. A v1 block fails the values loader only, never the policy loader (SPEC line 73 rule holds). After this lands and before Carter pastes the v2 block, `approval values` in the primary reports the current block as malformed; the PR description and handoff must say so with the paste and re-attest commands. Touches invariant 10 only to keep it: tests/values-inert.test.ts passes unchanged.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 schema/values.schema.json: version is const 2, wants is removed, schema stays closed
- [ ] #2 src/core/values.ts and src/cli/values.ts load and print love, like, dislike, responds only; a version-1 block is refused with a message that names the migration
- [ ] #3 approval doctor values-block row stops listing wants and its fail detail carries the migration hint when the block is v1
- [ ] #4 SPEC §5.3 says version is the integer 2, lists the four keys, gives one sentence on why wants was folded, and carries an (Amended APRV-NNN, pending sign-off.) marker
- [ ] #5 docs/proposals/repo-values-block.md and docs/proposals/approval-md-2026-09.md carry the v2 block with the wants items appended to like; README dictionary and docs/cli-reference.md list the new keys
- [ ] #6 tests: fixtures moved to v2, a new case for a refused v1 block, tests/values-inert.test.ts unchanged and passing, tests/dogfood.test.ts handled so the live v1 block does not fail the suite before the paste
- [ ] #7 npm test and lint pass
<!-- AC:END -->
