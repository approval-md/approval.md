---
id: APRV-406
title: >-
  Handover documents are private: move the four root HANDOVER files to private/,
  ignore the pattern, fix the tracked reference
status: Done
assignee:
  - '@fable'
created_date: '2026-09-20 18:38'
updated_date: '2026-09-20 18:40'
labels:
  - docs
  - hygiene
  - privacy
dependencies: []
priority: high
ordinal: 314000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
GitHub Pages serves this public repository from main at path /, so every tracked file is a public URL under approval.md. Four session handovers (HANDOVER-2026-09-16, 09-18, 09-20, 09-21) sit at the repo root and are served there. They carry absolute home-directory paths, the Hermes install location, private-folder file names, gate sequence numbers and lane-level operational detail. No credentials. private/README.md already states the rule: planning notes go in the primary checkout gitignored private folder because there is no quiet corner in the tracked tree. The handover pattern started under APRV-47 (docs/HANDOVER.md, retired at M8 close) and was revived at the root on 2026-09-16; every later session followed it. Carter asked on 2026-09-20 for them to be private. History keeps the files (rewriting shared history is a never); this removes them from main and the site going forward.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The four root HANDOVER-*.md files are copied unchanged into the primary checkout private/handover/ and removed from main
- [x] #2 .gitignore ignores root-level HANDOVER*.md so a later session cannot recreate a tracked handover
- [x] #3 No tracked file references a removed handover path; docs/integrations-considered.md cites the private copy instead
- [x] #4 Session memory points new sessions at private/handover/ rather than a root file
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. cp the four files into /Users/carter/dev/approval-md/private/handover/ (primary, ignored). 2. git rm them on the branch, add the ignore line, edit the one reference in docs/integrations-considered.md. 3. Update memory notes (read-scope-and-lane-push, approval-md-session-practices) to name private/handover. 4. Verify with git ls-files and grep, npm test not needed (no code). 5. PR, arm merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Copies verified by shasum (four identical digests) in /Users/carter/dev/approval-md/private/handover/. Ignore line is root-anchored (/HANDOVER*.md); a scratch HANDOVER-2026-09-99.md showed as ignored in git status --ignored. Remaining HANDOVER mentions in the tree are records: APRV-318 and APRV-347 notes, docs/repository-reconciliation-2026-09-08.json, and committed .approval/payloads entries (the 09-18 section-8 append rode inside a gated command payload, so that text stays in the log; the log is append-only and this task does not touch it). Memory notes read-scope-and-lane-push-2026-09-16, overnight-lane-rules-2026-09-21 and the MEMORY.md index now name private/handover/. private/README.md gains the handover sentence. No code changed, so npm test was not run. Files remain in git history by design; rewriting shared history is a never.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Removed the four root HANDOVER files from main after copying them unchanged into the primary private/handover/, gitignored root-level HANDOVER*.md, rewrote the one tracked reference in docs/integrations-considered.md, noted the rule in private/README.md, and repointed session memory. Verified with shasum on the copies and git status --ignored on a scratch file.
<!-- SECTION:FINAL_SUMMARY:END -->
