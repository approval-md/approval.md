---
id: APRV-54
title: 'Private, uncommitted directory for strategic notes'
status: Done
assignee:
  - '@claude'
created_date: '2026-08-17 10:47'
updated_date: '2026-08-17 10:49'
labels: []
dependencies: []
priority: low
type: chore
ordinal: 53000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The repo is public and GitHub Pages serves from the repo root, so no tracked path (including docs/) is private. Provide a root-level private/ directory that is gitignored except for a tracked README documenting the convention, so strategic and planning notes have a home that can never be committed or published.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 private/* is ignored: git check-ignore private/anything.md exits 0
- [x] #2 private/README.md is tracked and explains the convention (what goes here, what does not, primary checkout not worktrees)
- [x] #3 git ls-files private/ lists only private/README.md
- [x] #4 npm test still passes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Append private/* and !private/README.md to .gitignore. 2. Add private/README.md. 3. Add private/* to primary checkout .git/info/exclude for immediate protection before merge. 4. Verify with git check-ignore, git ls-files, git add -A --dry-run. 5. Run npm test.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Decisions: root-level private/ rather than docs/private because GitHub Pages serves the repo root, so any tracked path is published. README is the single tracked file via a !private/README.md negation so the convention is discoverable in-repo. Also added private/* to the primary checkout's .git/info/exclude (shared by all worktrees) so notes are protected before this branch merges. Validation: git check-ignore private/anything.md matches .gitignore:9; README not ignored; git add -A --dry-run in primary lists nothing under private/; npm test 1130 pass / 0 fail. Notes themselves live only in the primary checkout, outside git.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added a gitignored private/ directory (README tracked) for strategic notes that must never be committed or published. Verified with git check-ignore, git add -A dry-run, and the full test suite.
<!-- SECTION:FINAL_SUMMARY:END -->
