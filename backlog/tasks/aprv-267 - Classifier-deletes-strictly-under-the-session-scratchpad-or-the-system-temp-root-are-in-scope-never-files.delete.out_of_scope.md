---
id: APRV-267
title: >-
  Classifier: deletes strictly under the session scratchpad or the system temp
  root are in scope, never files.delete.out_of_scope
status: To Do
assignee: []
created_date: '2026-09-05 10:31'
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
