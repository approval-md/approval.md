---
id: APRV-121
title: 'Monetary amounts in hashed material are strings, not floats'
status: Done
assignee: []
created_date: '2026-08-20 14:48'
updated_date: '2026-08-26 20:27'
labels:
  - schema
  - budgets
  - emilia-review
dependencies: []
priority: medium
ordinal: 113000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
est_cost_usd and budget-relevant amounts ride inside JCS-hashed payloads and gate-written events as JSON numbers. RFC 8785 pins ES6 number serialization, so the TypeScript runtime is internally consistent, but SPEC §13 plans a Rust fast-path whose conformance is defined by the fixture suite, and cross-language float serialization is exactly where byte-identical hashing breaks (Emilia bans non-integer reals from signed material outright for this reason: "JS/Python/Go serialize floats differently; money must be string-encoded"). Fixing it now is a schema edit; fixing it after logs accumulate is a migration.

Outcome: every monetary field that participates in payload hashing or event hashing is a decimal string (e.g. "0.02") or integer minor units; the schemas reject bare JSON numbers for those fields; budget math parses deterministically and its rounding behavior is pinned by tests. Existing logs are append-only and keep old records valid: verifiers and budget computation accept the historical number form for records already written, per the §8 additive-change precedent, while the write boundary refuses new ones.

Schema change is in scope and called out per CLAUDE.md. SPEC amendment (§6.2 field table, §5.2 budgets note) for human sign-off is part of the task. Decide-and-document: string decimal vs integer cents; the choice and its rationale belong in the implementation notes.

Reference: emiliaprotocol/emilia-protocol packages/verify/src/index.ts isCanonicalizable (rejects non-integer reals in signed material).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Envelope and event schemas type monetary fields as string decimals or integer minor units and refuse JSON floats at the write boundary for new records
- [x] #2 Historical records carrying numeric amounts still validate, verify, and feed budget math identically to before (regression test over a fixture log written pre-change)
- [x] #3 Budget arithmetic on the new representation is deterministic with pinned rounding tests, including window sums that would lose precision as IEEE 754 doubles
- [ ] #4 SPEC amended for the representation and the compatibility rule, marked for human sign-off
- [ ] #5 npm test passes; lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Clean-room lane built against pre-121 (float) semantics — 2026-08-25 (from Carter). A clean-room Python second implementation now exists at ../approval-md-cleanroom (external to the repo, no git/source access). Its frozen hashing vectors encode monetary amounts as JSON floats under the current scheme: schema/fixtures/hash/known-answer.json (e.g. est_cost_usd: 0) and extracted/jcs-vectors.json (the record-shape vector carries amount: 0.5). When this task changes the representation to string-decimal or integer minor units, those vectors become a second migration surface and must be regenerated; the historical-compatibility rule (AC #2) applies to the committed corpus/events.jsonl shipped in that kit too. Upside: the float-serialization divergence this task exists to prevent is exactly what a cross-language (Python vs TS) implementation surfaces, so the clean-room result is a real-world check on the decision — but only if 121 lands first, or the clean-room baseline is explicitly scoped as pre-121 and re-run afterward. Recommend deciding which before treating the clean-room output as any kind of conformance signal.

Built 2026-08-26, merged in PR #131. Representation: canonical decimal string (USD_STRING_PATTERN: no sign/exponent/leading zeros, ≤6 fractional digits, no trailing zeros), chosen over integer minor units because a human writes est_cost_usd in YAML and '0.02' still says two cents. Converted everywhere the value enters hashed material, including the three figures of every budget verdict (float-in-hashed-material the task's scope did not name). Budget arithmetic in integer micro-USD via string parsing; no double touches a comparison. Historical compatibility: write boundary refuses numbers, read boundary accepts both via the pinned WIDENED_DEFS substitution (.usd_amount_historical), verify.ts the only caller; the committed log's 304 float-bearing records verifying clean IS a test. Pre-change hash vectors frozen verbatim in known-answer-pre-121.json as evidence the hash scheme did not move. Clean-room impact per Carter's note: the kit's float vectors are now formally pre-121; APRV-122's regenerated vectors freeze the new semantics. CLI --json now emits the canonical string (output-contract change, docs updated). SPEC §6.2/§5.2 amended pending sign-off.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Monetary amounts in hashed material are canonical decimal strings with one spelling per value; budget math runs in integer micro-USD; pre-change logs still verify through a single pinned read-boundary widening. Merged in PR #131.
<!-- SECTION:FINAL_SUMMARY:END -->
