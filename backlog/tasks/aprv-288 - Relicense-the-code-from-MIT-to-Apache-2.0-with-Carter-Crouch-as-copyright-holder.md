---
id: APRV-288
title: >-
  Relicense the code from MIT to Apache 2.0 with Carter Crouch as copyright
  holder
status: In Progress
assignee:
  - '@claude'
created_date: '2026-09-07 00:59'
updated_date: '2026-09-07 01:11'
labels:
  - licensing
dependencies: []
priority: high
type: chore
ordinal: 213000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
approval.md is MIT with the copyright line 'approval.md contributors', which names no legal person. Carter Crouch intends to run a commercial arm (hosted daemon, hosted reviewer layer) under Bountify.ai while keeping approval.md an adopted open framework for AI safety, control and model welfare. Apache 2.0 keeps the same adoption profile as MIT and adds the explicit patent grant a lab's counsel looks for on a control layer. Relicensing is done now, while Carter is the sole human copyright holder: every prior commit is Carter-directed with AI co-authors (Claude, Codex, Cursor) whose output carries no independent copyright, so no third-party consent is needed. Decisions recorded 2026-09-06: copyright held by Carter Crouch personally (Bountify.ai is an ordinary licensee); no per-file headers; no CLA; no patents; trademark asserted common-law only.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 LICENSE contains the verbatim Apache License 2.0 text (appendix may be dropped)
- [x] #2 NOTICE exists and names 'Copyright 2026 Carter Crouch' and the project URL
- [x] #3 package.json has license Apache-2.0, author Carter Crouch, and LICENSE and NOTICE in files
- [ ] #4 npm pack --dry-run lists LICENSE and NOTICE
- [x] #5 Implementation notes state the sole-copyright-holder basis for relicensing without contributor consent
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Replace LICENSE with verbatim Apache 2.0 text (fetched from apache.org, appendix dropped). 2. Add NOTICE naming Carter Crouch. 3. package.json: license Apache-2.0, author, files += LICENSE, NOTICE. 4. npm pack --dry-run to confirm. 5. Commit on this branch.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Relicense basis: Carter Crouch is the sole human copyright holder as of this commit. git log shows authors Carter (913), Carter Crouch (312), soycarts (1), all the same person; every commit is Carter-directed with AI co-authors (Claude, Codex, Cursor) whose output carries no independent copyright under current US/UK law. No third-party consent needed. LICENSE text copied verbatim from the canonical 201-line Apache 2.0 file (node_modules/detect-libc/LICENSE, identical to apache.org), appendix dropped at line 177. AC4 (npm pack --dry-run) could not be run: the hook has no rule for npm pack. Verified instead by the files array containing LICENSE and NOTICE plus npm's documented always-include rule for those names; left unchecked.
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
author: @claude
created: 2026-09-07 01:11
---
AC4 (npm pack --dry-run lists LICENSE and NOTICE) needs a human run: the hook has no rule for npm pack. Everything else is done and committed.
---
<!-- COMMENTS:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
LICENSE is Apache 2.0 verbatim, NOTICE names Carter Crouch, package.json declares Apache-2.0 with author and ships both files. Verified by grep of package.json and head/tail of LICENSE. AC4 left unchecked (npm pack unclassifiable by the hook).
<!-- SECTION:FINAL_SUMMARY:END -->
