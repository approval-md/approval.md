---
id: APRV-8
title: Rebuildable SQLite index projection (reindex)
status: To Do
assignee: []
created_date: '2026-08-04 21:46'
updated_date: '2026-08-04 21:46'
labels: []
milestone: m-1
dependencies:
  - APRV-6
  - APRV-7
priority: medium
type: feature
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC.md section 9 defines `.approval/index.sqlite` as a projection: rebuilt from the log via `approval reindex`, readable by any SQLite client, and deletable with zero data loss — "the database is a cache." M1 needs it so later milestones (queue rendering, budget math, policy queries like "pending manual approvals touching financial.*, oldest first") have an efficient query surface without ever treating the database as truth. The hard invariant: projections rebuild, they never write back to the log, and reindex must be deterministic — the same log always produces the same index content. Implementation note: prefer `node:sqlite` (built into recent Node) over a new dependency; if a dependency is unavoidable it needs justification and human approval.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A `reindex(logPath, indexPath)` core function rebuilds `.approval/index.sqlite` from scratch out of events.jsonl, and running it twice on the same log yields identical query results (deterministic)
- [ ] #2 The index supports querying events by task, event type, actor, and time range, demonstrated in tests against a log built through the real append path
- [ ] #3 Deleting index.sqlite and reindexing loses nothing: rebuilt index answers the same queries with the same results, covered by a test
- [ ] #4 Reindex never writes to events.jsonl: log bytes are unchanged after a rebuild, covered by a test
- [ ] #5 Reindex of a log that fails APRV-7 verification fails with a clear error rather than silently indexing tampered data
<!-- AC:END -->
