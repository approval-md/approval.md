---
id: APRV-7
title: Log chain verification (tamper and truncation detection)
status: In Progress
assignee:
  - '@fable'
created_date: '2026-08-04 21:46'
updated_date: '2026-08-04 23:36'
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
- [ ] #7 Detects duplicate and gapped seq, and a splice: a record whose own hash is self-consistent but whose prev points to the wrong ancestor
- [ ] #8 Fully recomputed forged suffix (attacker rewrites record N and recomputes all descendant hashes): a test demonstrates the rewritten log is self-consistent in isolation; verify detects the forgery when given an externally anchored trusted head (expected seq+hash), and the can/cannot-detect boundary is documented in code and implementation notes
- [ ] #9 Detects unknown or missing alg on any record mid-chain (fail closed per the SPEC section 8 amendment)
- [ ] #10 Empty log and single-record log both verify clean; single-record covers the genesis prev=null rule
- [ ] #11 A torn final line from a crashed write is reported as a DISTINCT torn-tail status (not generic corruption); verification never modifies the log, nothing auto-truncates, and the documented recovery stance is explicit human invocation only
- [ ] #12 Verification returns distinct machine-readable statuses for clean, corrupt, and torn-tail, designed to map 1:1 onto distinct CLI exit codes in APRV-9
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/core/verify.ts: verify(logPath, {expectedHead?}) walking the full chain — per-record schema validation, alg check, hash recomputation via verifyRecordHash, prev linkage, seq succession from 1.
2. Result type: {status: "clean"} | {status: "torn-tail", ...} | {status: "corrupt", firstBadSeq, reason, ...} — torn tail distinct from corruption; read-only throughout (assert byte+mtime unchanged in tests).
3. expectedHead anchor: optional {seq, hash}; mismatch = corrupt (detects fully recomputed forged suffixes); limitation without anchor documented in module header + task notes.
4. Tamper fixtures built ONLY by real appendEvent then corrupting a copy: field mutation, tail/middle deletion, reorder, splice to wrong ancestor, partial forged tail, full recomputed suffix (helper re-hashing via computeRecordHash), missing/unknown alg, dup/gap seq, torn final line, malformed JSON line.
5. Empty + single-record clean cases; genesis prev=null.
6. Opus subagent in isolated worktree (parallel with the APRV-6 vectors addendum); fable reviews, merges, runs gates on combined tree, finalizes.
<!-- SECTION:PLAN:END -->
