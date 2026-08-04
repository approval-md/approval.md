---
id: APRV-7
title: Log chain verification (tamper and truncation detection)
status: To Do
assignee: []
created_date: '2026-08-04 21:46'
labels: []
milestone: m-1
dependencies:
  - APRV-6
priority: high
type: feature
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC.md section 8 requires that `approval log verify` MUST detect any mutation or truncation — this is the tamper-evidence promise the whole audit story (section 11) rests on, so it gets exhaustive tests of its own rather than riding along with the writer. This task builds the core verification function that re-derives each record's hash from its canonical serialization and walks the prev-chain and seq sequence end to end. Read-only by definition: verification must never modify the log. Tamper fixtures for tests must be produced by first building a valid log through the real APRV-6 append path and then corrupting a copy — never by fabricating records directly.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A `verify(logPath)` core function returns ok for an untampered log (including an empty log) and a structured failure naming the first bad seq otherwise
- [ ] #2 Detects field mutation in any record (payload edit, actor swap, ts change), covered by tests that corrupt a real appended log
- [ ] #3 Detects deletion of a record: from the tail (truncation, when the expected length or head is known), from the middle, and reordering of records
- [ ] #4 Detects a forged tail: records appended after a mutated record with recomputed hashes still fail because the chain breaks at the mutation point
- [ ] #5 Detects malformed lines (invalid JSON, schema-invalid records) and seq gaps or duplicates
- [ ] #6 Verification is read-only: the log file's bytes and mtime are unchanged after a verify run, covered by a test
<!-- AC:END -->
