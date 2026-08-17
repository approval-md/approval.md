---
id: APRV-59
title: Move payloadStoreCensus from daemon/prune.ts to core
status: To Do
assignee: []
created_date: '2026-08-17 15:51'
labels: []
dependencies: []
priority: low
type: chore
ordinal: 58000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-41 placed payloadStoreCensus in src/daemon/prune.ts and the CLI (doctor, status) imports it from there, a CLI -> daemon import direction the rest of the codebase avoids. Mechanical move to src/core (payload-store.ts or a sibling), unchanged behavior, imports updated.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 No src/cli module imports from src/daemon; census behavior and tests unchanged
<!-- AC:END -->
