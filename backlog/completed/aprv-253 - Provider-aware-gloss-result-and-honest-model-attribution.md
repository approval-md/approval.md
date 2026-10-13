---
id: APRV-253
title: Provider-aware gloss result and honest model attribution
status: Done
assignee:
  - '@codex'
created_date: '2026-09-04 21:59'
updated_date: '2026-09-05 09:47'
labels: []
dependencies: []
type: feature
ordinal: 194000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Foundation for the Codex summarizer stack. Replace hardcoded Haiku attribution with runner-supplied provenance while preserving APRV-144, APRV-164, APRV-197 and APRV-207 contracts. Binding SPEC sections 3, 9, 10.3 and 11. Parent reviews each task; this task and its runner and CLI follow-ups share one PR under APRV-160. Claude owns active channel layout and shared help work; this task owns only gloss.ts, gloss-attach.ts and dedicated contract tests in the isolated Codex worktree.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Provider and requested model provenance accompany successful gloss results and render as claimed, unverified metadata without hardcoded false Haiku labels.
- [x] #2 Claude defaults, command/file/email coverage, bounded material/output, escaping and all failures-to-absence remain compatible and tested.
- [x] #3 Tests prove gloss content never changes policy verdicts, payload bindings or log records; npm test, lint and typecheck pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read gloss generation, attachment and existing tests. 2. Introduce typed result/provenance while retaining a compatible injected-runner seam for current callers. 3. Adapt attachment and add dedicated regression tests without editing active Claude channel files. 4. Parent reviews diff and focused checks, then commit per task before dependent workers start.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reviewed typed provider/requested-model result, explicit legacy test seam, attachment normalization and unchanged canonical binding. Dedicated provenance tests 6/6 and focused CLI gloss tests 7/7 passed; combined A-C rendering/selection/runner suite 25/25, build, lint and typecheck passed in the implementation worktree. Critical review found no code blocker. Delivery assembly preserves that worktree and starts from refreshed main with one implementation commit per task. Full integrated test criterion remains pending; do not mark complete from focused results.

Final assembled stack verification on refreshed delivered main: npm test exit0, 3426 passed and 1 skipped, no failures/cancellations; focused A-C 25/25, documentation/help 43/43, build, lint, typecheck and diff checks pass. Independent final review approves requested-only provenance and separation from canonical payload/bindings. Source is integrated in codex/gloss-provider-stack at /private/tmp/approval-gloss-delivery; PR262 delivery is verified separately. No policy/schema or live service change was introduced.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented typed provider/model provenance and preserved unverified attribution, payload coverage, escaping, bounds and failure behavior. Verified by provenance and rendering tests, independent critical review, and the final full suite (3426 passed, 1 skipped).
<!-- SECTION:FINAL_SUMMARY:END -->
