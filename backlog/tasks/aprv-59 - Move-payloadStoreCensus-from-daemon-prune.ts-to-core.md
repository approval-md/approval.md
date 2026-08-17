---
id: APRV-59
title: Move payloadStoreCensus from daemon/prune.ts to core
status: Done
assignee:
  - '@fable'
created_date: '2026-08-17 15:51'
updated_date: '2026-08-17 19:05'
labels: []
milestone: m-8
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
- [x] #1 No src/cli module imports from src/daemon; census behavior and tests unchanged
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Same subagent, second commit. 2. Move payloadStoreCensus (and its types) from src/daemon/prune.ts to src/core/payload-store.ts (or a sibling core module); prune.ts re-imports from core; cli/doctor.ts and cli/execute.ts import from core; behavior and tests unchanged; a test or lint assertion that src/cli imports nothing from src/daemon except cli/daemon.ts. 3. Same PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR #26, merged. Census and its two shared helpers (prunedHashes, bindingsOf) moved to a new src/core/payload-census.ts rather than payload-store.ts, whose contract is log-ignorant; prune.ts imports them back (one computation for what the reader sees and what the daemon deletes); doctor and status import from core; no re-export (nothing else imported from prune). New tests/layering.test.ts: no src/cli file except cli/daemon.ts imports from ../daemon/, with an exception list that fails if it names a file that no longer exists or no longer imports the daemon. FIRST CATCH AT MERGE: APRV-63 (landing concurrently) had added two daemon imports to doctor.ts (DEFAULT_TASKS_DIR, latestRegistration); the guard flagged them; per its own rule fable moved both to a new src/core/registration.ts (pure log/layout facts shared by gate, daemon, doctor) with re-exports from projection.ts and daemon.ts, rather than widening the exception. 1228 tests composed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
payloadStoreCensus and registration lookups moved to core; layering guard pins the CLI-never-imports-daemon rule and caught its first violation at the same merge. Merged as PR #26.
<!-- SECTION:FINAL_SUMMARY:END -->
