---
id: APRV-122
title: >-
  Conformance vector suite: versioned fixtures with expected refusals and
  negative controls
status: To Do
assignee: []
created_date: '2026-08-20 14:48'
labels:
  - tests
  - conformance
  - emilia-review
dependencies: []
priority: medium
ordinal: 114000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC §13 reserves a Rust fast-path for the hot loop (policy resolution, chain-tail verification, gate verdict) with "conformance defined by the fixture suite", but no such suite exists as a first-class, language-neutral artifact: our tests exercise the TypeScript implementation directly, so a second implementation has nothing to run. Emilia demonstrates the methodology working across three languages: one JSON vector file per suite with an envelope (suite id, semver vectors_version, algorithm, count) and per-vector {id, description, inputs, expect}; expected refusals are first-class (expect.valid:false with a failure_class taxonomy rather than a separate should-throw channel); a manifest pins every suite file and runner by SHA-256; the multi-language runner fails when a language is silently missing rather than skipping it; and, rarest, negative controls: deliberately broken inputs that MUST fail with a named violation, proving the checker checks.

Outcome: a conformance/ fixture suite covering the hot-loop surfaces (policy matching and specificity, class resolution with the irreversibility floor, chain verification including alg handling and truncation/mutation detection, gate verdicts including every refusal code of §11.1 invariant 6), generated deterministically, consumed by the existing vitest suite as its own source of truth so the fixtures cannot drift from the implementation, with expected-refusal vectors carrying the machine-readable code they must produce, and a handful of negative-control vectors that a conforming runner must reject. Runner contract documented so the future Rust implementation consumes the same files byte-for-byte.

No schema changes to the log; this is test infrastructure plus a SPEC §13 note naming the suite as the conformance definition (human sign-off on the SPEC sentence).

Reference: emiliaprotocol/emilia-protocol conformance/run.mjs (three-language runner, same absolute vector path, fails on missing language), conformance/vectors/*.v1.json (envelope + expect format, failure_class), conformance/conformance-manifest.json (per-suite and per-runner SHA-256 pinning), .github/workflows/tlc.yml negative controls (broken models must fail with a named invariant violation).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Vector files exist for policy matching, class resolution (floor included), chain verification, and gate refusal codes, each with envelope metadata and semver versioning
- [ ] #2 Expected refusals are vectors, not exceptions: each carries the exact machine-readable code the implementation must return, and the full refusal-code unions of invariant 6 are covered
- [ ] #3 Negative-control vectors exist that a conforming implementation must reject; the runner fails if any control passes
- [ ] #4 The TypeScript test suite consumes the vector files as input (single source of truth); a manifest pins each suite file by SHA-256 and CI fails on drift
- [ ] #5 Runner contract documented (input path in, strict JSON results out, non-zero exit on internal failure, no vector silently skipped)
- [ ] #6 SPEC §13 names the suite as the fast-path conformance definition, marked for human sign-off
- [ ] #7 npm test passes; lint clean
<!-- AC:END -->
