---
id: APRV-267
title: >-
  Classifier: deletes strictly under the session scratchpad or the system temp
  root are in scope, never files.delete.out_of_scope
status: In Progress
assignee:
  - 'agent:opus-lane-b'
created_date: '2026-09-05 10:31'
updated_date: '2026-09-05 10:41'
labels:
  - classifier
dependencies: []
priority: medium
ordinal: 198000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From the log, 2026-09-05: all 13 files.delete.out_of_scope questions since Aug 17 were lanes removing their own scratch directories (/private/tmp/claude-501/... session scratchpads, /tmp/<name> clones and probe files); 11 approved, 2 expired. Outcome: an rm whose every target path is strictly under the process's scratchpad root (the CLAUDE_SCRATCHPAD or session scratch dir the harness exports, when present) or under the system temp root (os.tmpdir() and /private/tmp on macOS), with no .., no symlink escape (realpath the parent), and no path inside any checkout, classifies files.delete.scratch (a new class under files.delete.*, default autonomy from files.delete's line or autonomous in the repo policy); anything else keeps today's classification. Why: a delete of the agent's own temp files is not a decision.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Table-driven classifier tests: scratchpad and temp-root targets classify files.delete.scratch; a target outside those roots, a .. segment, a symlink escaping the root, or a checkout path keeps files.delete.out_of_scope
- [ ] #2 docs/claude-code-hook.md table and the repo policy pin updated; every literal class reachable
- [ ] #3 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Thread an optional ClassifierContext (scratchRoots: absolute, already-resolved roots) through classifyCommand -> classifySegment -> RuleContext, exactly as protectedPaths is threaded: omitting it under-reports the new class rather than inventing an authorization.
2. refineRm gains a scratch branch ABOVE the absolute check: every positional must be absolute, carry no .. segment, no unknown value ($ * ? ~), and be a strict descendant of one scratchRoot. All targets pass -> files.delete.scratch, rule rm-scratch. Any target failing keeps today's class. Declare files.delete.scratch in the rm row's emits so CLASSIFIER_CLASSES carries it.
3. The impure half lives in src/cli/hook.ts beside refineRewrite (APRV-108 precedent): resolveScratchRoots() reads os.tmpdir() plus the fixed platform temp roots and the harness scratchpad vars when present, realpaths them, and rejects any root shallower than two segments or containing the cwd (a poisoned TMPDIR must not make / a scratch root). refineScratchDelete() then TIGHTENS: for every rm-scratch target it realpaths the nearest existing ancestor, requires it still under a root, and requires no .git at or above the target up to that root. Any failure downgrades back to files.delete.out_of_scope.
4. Table-driven fixtures in tests/command-class.test.ts against synthetic roots (positives and each negative: outside, .., glob, the root itself, a checkout path is proven in the hook test); hook tests for the impure tightening.
5. docs/claude-code-hook.md and docs/cursor-hook.md rule tables gain the class (both doc tests assert every CLASSIFIER_CLASSES member is named); policy-expectations pins files.delete.scratch manual/default, since the repo policy declares neither new class.
6. npm test, oxlint.
<!-- SECTION:PLAN:END -->
