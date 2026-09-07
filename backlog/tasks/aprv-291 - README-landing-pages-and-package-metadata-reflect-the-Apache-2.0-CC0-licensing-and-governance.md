---
id: APRV-291
title: >-
  README, landing pages and package metadata reflect the Apache 2.0 / CC0
  licensing and governance
status: In Progress
assignee:
  - '@claude'
created_date: '2026-09-07 01:00'
updated_date: '2026-09-07 01:08'
labels:
  - licensing
dependencies:
  - APRV-288
priority: medium
type: docs
ordinal: 216000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Every reader-facing surface that says MIT must say the new terms, and the README should point at GOVERNANCE.md and CONTRIBUTING.md. Known sites: README.md '## License' (line ~890), index.html footer (line ~132), rsi/index.html footer (line ~184). Add one sentence in README acknowledging that Bountify.ai operates an optional hosted daemon and reviewer layer and that nothing in the format depends on it; place it with the governance section or near the comparison, never in the hero.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 README.md License section becomes 'License and governance', naming Apache 2.0 code, CC0 spec and schemas, and linking LICENSE, NOTICE, GOVERNANCE.md, CONTRIBUTING.md
- [ ] #2 index.html and rsi/index.html footers read 'Apache 2.0 · spec CC0 · built under its own policy'
- [ ] #3 README carries one sentence on the optional Bountify.ai hosted offering, outside the hero
- [ ] #4 grep for MIT across the repo (excluding package-lock.json, backlog/, .approval/) returns no licence claim
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. README License section -> License and governance. 2. One Bountify.ai sentence in How this compares. 3. index.html and rsi/index.html footers. 4. grep MIT sweep. 5. Commit.
<!-- SECTION:PLAN:END -->
