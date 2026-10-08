---
id: APRV-8
title: Rebuildable SQLite index projection (reindex)
status: Done
assignee:
  - '@fable'
created_date: '2026-08-04 21:46'
updated_date: '2026-08-04 23:55'
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
- [x] #1 A `reindex(logPath, indexPath)` core function rebuilds `.approval/index.sqlite` from scratch out of events.jsonl, and running it twice on the same log yields identical query results (deterministic)
- [x] #2 The index supports querying events by task, event type, actor, and time range, demonstrated in tests against a log built through the real append path
- [x] #3 Deleting index.sqlite and reindexing loses nothing: rebuilt index answers the same queries with the same results, covered by a test
- [x] #4 Reindex never writes to events.jsonl: log bytes are unchanged after a rebuild, covered by a test
- [x] #5 Reindex of a log that fails APRV-7 verification fails with a clear error rather than silently indexing tampered data
- [x] #6 Reindex runs APRV-7 chain verification first and refuses to index a non-clean log; an explicit force option for torn-tail indexes through intactThroughSeq only and records the truncated view in an index metadata table
- [x] #7 The index carries the log head (seq + hash) it was built from in a metadata table, so staleness against the current log is detectable
- [x] #8 A test proves delete-and-rebuild equals the original: identical schema and query results from identical logs (SQLite internal bytes excepted)
- [x] #9 Dependency better-sqlite3 is exact-pinned as the second runtime dependency (human pre-approved 2026-08-05); justification in implementation notes; node:sqlite not used (absent on the Node 20 floor)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. better-sqlite3 exact-pinned (pre-approved). node:sqlite ruled out: engines.node >=20 and node:sqlite does not exist before 22.5 — noted in implementation notes rather than proposed as a switch.
2. src/core/reindex.ts: reindex(logPath, indexPath, {schemaDir?, force?}) — verify() first; clean -> full index; torn-tail + force -> index records 1..intactThroughSeq and record truncated=true, intact_through_seq in metadata; corrupt or unforced torn-tail -> structured refusal.
3. Schema: events table (seq PK, ts, event, actor, task, action_key, channel, alg, prev, hash, payload JSON text) + meta table (built_from_seq, built_from_hash, truncated, schema_version). Full rebuild = drop + recreate in a transaction; deterministic inserts in seq order.
4. Queries covered by tests: by task, by event type, by actor, time range; staleness check helper comparing meta head vs verify head.
5. Tests: determinism (two rebuilds -> identical dump/query results), delete-and-rebuild equality, refusal paths, force-torn-tail metadata, log bytes untouched by reindex.
6. Opus subagent implements; fable reviews, gates from clean, finalizes, merges, pushes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Dependencies (human pre-approved 2026-08-05, exact pins): better-sqlite3@13.0.2 runtime (prebuilt darwin-arm64 binary, no native compile needed) + @types/better-sqlite3@9.6.0 dev (runtime bundles no types; the 9.x types cover the API surface used, verified under strict/NodeNext). node:sqlite ruled out: engines.node >=20 and node:sqlite does not exist before 22.5 — no switch proposed. Implemented by Opus subagent; fable review found nothing to override. Design: verify-first always (corrupt refused outright, force never rescues corrupt; torn-tail+force indexes the intact prefix and records truncated/intact_through_seq/built_from_hash in a CHECK(id=1) singleton meta table); full rebuild into a same-directory temp file renamed over the index (crash-safe, no half-built index observable); payload stored as RFC 8785 canonical text for byte-stable rows; records re-read after verify with exactly verified.records lines — a moving log between verify and read reports io rather than indexing a moving target; not a STRICT table so DuckDB/older SQLite clients can open it per SPEC section 9. Verified from wiped node_modules/dist on the combined tree: 218/218 tests, lint, typecheck green.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
src/core/reindex.ts: verify-gated, deterministic, crash-safe full-rebuild SQLite projection with head-provenance metadata and staleness detection via indexHead(); delete-and-rebuild equality, determinism, refusal, forced-torn-tail, and log-untouched invariants all proven by 18 new tests. Verified: 218/218 tests, lint, typecheck from clean install.
<!-- SECTION:FINAL_SUMMARY:END -->
