---
id: APRV-288
title: >-
  Relicense the code from MIT to Apache 2.0 with Carter Crouch as copyright
  holder
status: In Progress
assignee:
  - '@claude'
created_date: '2026-09-07 00:59'
updated_date: '2026-09-07 01:00'
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
- [ ] #1 LICENSE contains the verbatim Apache License 2.0 text (appendix may be dropped)
- [ ] #2 NOTICE exists and names 'Copyright 2026 Carter Crouch' and the project URL
- [ ] #3 package.json has license Apache-2.0, author Carter Crouch, and LICENSE and NOTICE in files
- [ ] #4 npm pack --dry-run lists LICENSE and NOTICE
- [ ] #5 Implementation notes state the sole-copyright-holder basis for relicensing without contributor consent
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Replace LICENSE with verbatim Apache 2.0 text (fetched from apache.org, appendix dropped). 2. Add NOTICE naming Carter Crouch. 3. package.json: license Apache-2.0, author, files += LICENSE, NOTICE. 4. npm pack --dry-run to confirm. 5. Commit on this branch.
<!-- SECTION:PLAN:END -->
