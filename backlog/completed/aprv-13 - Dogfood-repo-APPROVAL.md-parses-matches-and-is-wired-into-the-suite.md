---
id: APRV-13
title: 'Dogfood: repo APPROVAL.md parses, matches, and is wired into the suite'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 00:23'
updated_date: '2026-08-05 00:54'
labels: []
milestone: m-2
dependencies:
  - APRV-11
priority: high
type: feature
ordinal: 13000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The milestone's dogfooding criterion (human-mandated): the repository's own APPROVAL.md — authored and committed by the human, permanently read-only to agents — must parse as a valid policy under the real engine and be wired into the fixture suite so any future edit that breaks it fails `npm test` (and therefore CI). This locks the engine and the live policy together from M2 onward: the policy file the agents operate under is continuously proven machine-valid, and engine regressions that would mis-read it surface immediately. Agents MUST NOT modify APPROVAL.md in the course of this task; every test reads the real file at the repo root, never a copy that could drift.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A test loads the repository's actual APPROVAL.md from the repo root through the real APRV-10 loader and asserts it parses and validates as a policy (no fail-closed result)
- [x] #2 The file is wired into the fixture/test suite such that any future edit that breaks parsing, schema validity, or the assertions below fails npm test
- [x] #3 Matching assertions lock engine and policy together: defaults.autonomy is manual; deps.add, network.call, release.publish, policy.edit, vcs.history.rewrite, and files.delete.out_of_scope resolve to manual; read.* classes resolve to autonomous; vcs.push.main resolves to supervised
- [x] #4 No test copies or rewrites APPROVAL.md; the suite reads the committed file in place, and the task's implementation touches no byte of it
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. tests/dogfood.test.ts: loadPolicy against the repo root (file read in place, never copied), assert ok; resolve() assertions locking engine to the live policy (defaults manual; deps.add/network.call/release.publish/policy.edit/vcs.history.rewrite/files.delete.out_of_scope -> manual; read.* members -> autonomous; vcs.push.main -> supervised).
2. Wire into npm test (auto: any tests/*.test.ts compiles into the suite), so future APPROVAL.md edits or engine regressions fail CI.
3. Zero writes to APPROVAL.md; Opus subagent in isolated worktree parallel with APRV-12; fable reviews, merges both, gates, finalizes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent in isolated worktree; fable review found nothing to override. One file added (tests/dogfood.test.ts), zero dependencies, zero edits to any existing file. The live APPROVAL.md is loaded in place through the real loader (source.filename asserted, approvalTtlMs 86400000), structure pinned (defaults manual/reject, sample_rate 0.15, daily_actions 200, approver carter/cli), and 14 table-driven resolve() cases lock every declared class plus default and bare-namespace paths; the floor case locks amended section 7 against the live policy (vcs.push.main + reversible:false -> manual/floor). Read-only enforcement is mechanical: before/after byte comparison, SHA-256 c218ecd012fd721432ebe8aa023d74a7a23e821bd180e13e9bddeded2070cf9d identical pre/post suite. Wired into CI by construction (any tests/*.test.ts compiles into npm test). Verified on the merged tree: 411/411, lint, typecheck green.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
tests/dogfood.test.ts locks the repository's live APPROVAL.md to the real engine under CI: parse, structure, and 14 class-resolution assertions plus the amended-section-7 floor case, with byte-identity proof the file is never touched. Any future APPROVAL.md edit or engine regression that breaks the live policy fails npm test. Verified: 411/411 on the merged tree.
<!-- SECTION:FINAL_SUMMARY:END -->
