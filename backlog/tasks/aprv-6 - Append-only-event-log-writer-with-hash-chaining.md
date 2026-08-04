---
id: APRV-6
title: Append-only event log writer with hash chaining
status: Done
assignee:
  - '@fable'
created_date: '2026-08-04 21:46'
updated_date: '2026-08-04 23:40'
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
- [x] #1 An `append(event)` core function writes one JSON line to `.approval/log/events.jsonl`, assigning seq (monotonic from 1) and prev/hash per SPEC.md section 8
- [x] #2 A record failing schema validation (APRV-5) is rejected before append and the log file is untouched, covered by a test
- [x] #3 Appending N events produces a chain where each record's prev equals the previous record's hash and the first record's prev is the documented genesis value, covered by tests
- [x] #4 The public API exposes no mutation, reordering, or truncation operations on the log
- [x] #5 Concurrent/interrupted append safety is addressed and tested (a partial write or double-run cannot corrupt earlier records or produce duplicate seq)
- [x] #6 Canonical serialization is RFC 8785 (JSON Canonicalization Scheme). Any deviation from RFC 8785 requires: a SPEC.md amendment fully documenting the alternative scheme (key ordering, number formatting, string encoding, byte-level), explicit human sign-off called out in implementation notes, and equivalent coverage
- [x] #7 Known-answer fixtures pin the wire format: committed fixture files map complete input records to their exact expected hash, and a test recomputes and asserts each — these fixtures are the permanent byte-for-byte commitment every future verifier must reproduce
- [x] #8 Each appended record carries the explicit algorithm identifier defined by the APRV-5 event schema (e.g. `alg: "sha256/jcs"`), and the writer refuses to append a record whose identifier does not match the scheme it implements
- [x] #9 SPEC.md amendments land in the same commit as the writer: (a) section 8 actor-prefix paragraph and (b) the section 10.1/6.3 manual-path clarification with the phrase auto-grant removed — both verbatim per the human-approved wording recorded in this task's comments
- [x] #10 RFC 8785's official test material is incorporated verbatim into the suite and cited by source: the section 3.2.3 sorting example, Appendix A literals/examples, and the Appendix B number-serialization table entries representable in the suite
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
8. SPEC amendments (see task comment) in the same commit as the writer code.
9. Canonicalization: hand-rolled RFC 8785 (JCS) serializer in src/core — sorted keys by UTF-16 code units, ECMAScript number serialization (JSON.stringify semantics), no new dependency — pinned by RFC 8785 test vectors as known-answer fixtures in addition to the record-hash vectors.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Human approval recorded in advance (2026-08-05) for the two SPEC amendments in the task comment (actor prefixes; manual-path exclusivity of approval.* with auto-grant removed). Not silent spec edits.

Implemented by Opus subagent; fable review made one override: two comments claimed the stored line "is the bytes that were digested" — corrected to state precisely that the stored line is JCS of the complete record (hash included) while the digest input is the same canonicalization minus the hash field. Design: src/core/jcs.ts is a hand-rolled RFC 8785 canonicalizer (zero new dependencies; sorting by UTF-16 code units via plain string <, numbers/strings delegated to JSON.stringify which implements the RFC-referenced ECMAScript algorithms; undefined/BigInt/NaN/Infinity/non-plain objects/cycles rejected with typed JcsError rather than silently coerced). src/core/log.ts: appendEvent stamps seq/prev/alg/hash (callers supply content + ts only; the writer never reads the clock for hash-relevant data), validates the complete record against the event schema before any byte is written, refuses corrupt tails (truncated/blank/unparseable last line), serializes the write under an advisory wx-lockfile with bounded retry and no stale-lock stealing, and writes one line per single O_APPEND syscall. Public API exposes no mutation/reorder/truncate operation (asserted by a test). Known-answer fixtures freeze 3 records (canonical string + digest each); the end-to-end test replays them through appendEvent and asserts identical bytes and hashes. SPEC amendments (actor prefixes; manual-path exclusivity, auto-grant removed) landed in this task per pre-approval; no M0 fixture or test presumed auto-granted approval events (verified before implementation). 140/140 tests, lint, typecheck green from wiped node_modules/dist.

Addendum (human-requested before close): RFC 8785 official test material embedded verbatim in tests/rfc8785-vectors.test.ts, cited by source (rfc-editor.org/rfc/rfc8785, sections 3.2.2/3.2.3/3.2.4, Appendix B) — RFC text fetched from rfc-editor.org to guarantee verbatim data. 31 new tests: sorting example (order read off canonical text, not a reparsed object, since ECMAScript integer-key hoisting would corrupt the assertion), full example pinned to the RFC UTF-8 byte dump, all 24 Appendix B value rows reconstructed from IEEE 754 bit patterns, NaN/Infinity rows assert JcsError. Zero disagreement between the published vectors and the implementation; no source changes needed. Suite 171/171.
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-08-04 23:17
---
Human-approved SPEC amendments (2026-08-05), to land in APRV-6's commit. Amendment 1, append to section 8: "Actor identifiers use exactly three prefixes: `human:` for decisions made by a person, `agent:` for actions proposed or performed by an agent, and `system:` for runtime-originated events such as `approval.expired`. Verifiers MUST reject unrecognized prefixes." Amendment 2, add to section 6.3 and reflect in section 10.1: "`approval.*` events are exclusive to the manual path and always record a human decision. Actions whose class resolves to `supervised` or `autonomous` emit no `approval.requested` or `approval.granted`; their execution is recorded by `execution.*` events, and supervised actions are additionally eligible for `audit.sampled` and `audit.reviewed`. The phrase 'auto-grant' is removed." — operationally: append the quoted paragraph (minus its final meta-sentence) to section 6.3, and rewrite the section 10.1 `approval request` comment so "(or auto-grant per policy for supervised/autonomous)" is gone, e.g. "-> approval.requested (manual classes; supervised/autonomous proceed directly to execution)". Pre-verified 2026-08-05: no M0 fixture or test presumes auto-granted approval events.
---
<!-- COMMENTS:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Append-only log writer with RFC 8785 hash chaining: hand-rolled JCS canonicalizer pinned by the RFC's official vectors (sorting example, byte-level full example, all Appendix B rows — 171/171 tests) and known-answer fixtures freezing the wire format (final record hash 2f4cd2927b66ac9b5bdcb8186c05f521ace5a05ade16048117d1fbbd9d505d20). appendEvent validates at the write boundary, refuses corrupt tails, serializes appends via lockfile. SPEC amendments (actor prefixes, auto-grant removal) landed same-commit. Verified from clean install; lint and typecheck green.
<!-- SECTION:FINAL_SUMMARY:END -->
