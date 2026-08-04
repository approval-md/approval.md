---
id: APRV-6
title: Append-only event log writer with hash chaining
status: To Do
assignee: []
created_date: '2026-08-04 21:46'
updated_date: '2026-08-04 21:55'
labels: []
milestone: m-1
dependencies:
  - APRV-5
priority: high
type: feature
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The append path is the single write boundary for `.approval/log/events.jsonl` (SPEC.md section 8) and everything downstream — verify, reindex, the M2+ gate — consumes what it writes. It exists as its own task because canonical serialization is a permanent format commitment: hash = SHA-256 over the canonical serialization of the record with `prev` included, `prev` = previous record hash, and any ambiguity here breaks tamper evidence forever. The writer MUST validate every record against the APRV-5 schemas before append (fail closed: invalid record, nothing written), assign monotonic seq, and only ever append — per the engineering invariants, nothing in this codebase may mutate or reorder events.jsonl. Deterministic core: no LLM involvement, no wall-clock or randomness inside hash computation. Test logs must be built through this real append path, never hand-written.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An `append(event)` core function writes one JSON line to `.approval/log/events.jsonl`, assigning seq (monotonic from 1) and prev/hash per SPEC.md section 8
- [ ] #2 A record failing schema validation (APRV-5) is rejected before append and the log file is untouched, covered by a test
- [ ] #3 Appending N events produces a chain where each record's prev equals the previous record's hash and the first record's prev is the documented genesis value, covered by tests
- [ ] #4 The public API exposes no mutation, reordering, or truncation operations on the log
- [ ] #5 Concurrent/interrupted append safety is addressed and tested (a partial write or double-run cannot corrupt earlier records or produce duplicate seq)
- [ ] #6 Canonical serialization is RFC 8785 (JSON Canonicalization Scheme). Any deviation from RFC 8785 requires: a SPEC.md amendment fully documenting the alternative scheme (key ordering, number formatting, string encoding, byte-level), explicit human sign-off called out in implementation notes, and equivalent coverage
- [ ] #7 Known-answer fixtures pin the wire format: committed fixture files map complete input records to their exact expected hash, and a test recomputes and asserts each — these fixtures are the permanent byte-for-byte commitment every future verifier must reproduce
- [ ] #8 Each appended record carries the explicit algorithm identifier defined by the APRV-5 event schema (e.g. `alg: "sha256/jcs"`), and the writer refuses to append a record whose identifier does not match the scheme it implements
<!-- AC:END -->
