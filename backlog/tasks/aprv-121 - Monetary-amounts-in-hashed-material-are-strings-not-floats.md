---
id: APRV-121
title: 'Monetary amounts in hashed material are strings, not floats'
status: To Do
assignee: []
created_date: '2026-08-20 14:48'
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
- [ ] #1 Envelope and event schemas type monetary fields as string decimals or integer minor units and refuse JSON floats at the write boundary for new records
- [ ] #2 Historical records carrying numeric amounts still validate, verify, and feed budget math identically to before (regression test over a fixture log written pre-change)
- [ ] #3 Budget arithmetic on the new representation is deterministic with pinned rounding tests, including window sums that would lose precision as IEEE 754 doubles
- [ ] #4 SPEC amended for the representation and the compatibility rule, marked for human sign-off
- [ ] #5 npm test passes; lint clean
<!-- AC:END -->
