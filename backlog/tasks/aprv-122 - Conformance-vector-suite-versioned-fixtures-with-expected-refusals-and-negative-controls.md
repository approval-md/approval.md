---
id: APRV-122
title: >-
  Conformance vector suite: versioned fixtures with expected refusals and
  negative controls
status: Done
assignee: []
created_date: '2026-08-20 14:48'
updated_date: '2026-08-29 23:31'
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
- [x] #1 Vector files exist for policy matching, class resolution (floor included), chain verification, and gate refusal codes, each with envelope metadata and semver versioning
- [x] #2 Expected refusals are vectors, not exceptions: each carries the exact machine-readable code the implementation must return, and the full refusal-code unions of invariant 6 are covered
- [x] #3 Negative-control vectors exist that a conforming implementation must reject; the runner fails if any control passes
- [x] #4 The TypeScript test suite consumes the vector files as input (single source of truth); a manifest pins each suite file by SHA-256 and CI fails on drift
- [x] #5 Runner contract documented (input path in, strict JSON results out, non-zero exit on internal failure, no vector silently skipped)
- [ ] #6 SPEC §13 names the suite as the fast-path conformance definition, marked for human sign-off
- [ ] #7 npm test passes; lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Partial informal extraction already exists — 2026-08-25 (from Carter). The clean-room lane (../approval-md-cleanroom) hand-built two neutral vector files that this task should fold in and supersede, not duplicate: extracted/refusal-unions.json already enumerates the five §11.1 invariant-6 unions (gate/token-verify/token/execute/append) — direct input for AC #2; and extracted/jcs-vectors.json is a ready canonicalization suite already carrying suite/vectors_version/algorithm envelope fields plus RFC 8785 number vectors and rejection cases. FIXTURES.md in that kit documents the current ad-hoc formats (valid/invalid convention, known-answer shape, chain corpus); the runner contract in AC #5 should replace it, and extracted/ should be regenerated into the 122 envelope+manifest+failure_class format so there is one source of truth. Gaps the clean-room did not extract and this task still fully owns: policy matching / specificity / irreversibility-floor vectors, gate-verdict vectors, chain-verification mutation and truncation vectors, and the machine-readable failure_class on the existing schema invalid/ fixtures (which today assert only 'fails somehow'). Those four are the substance of ACs #1–#3.

Built 2026-08-26, merged in PR #131. conformance/ with six suites, 215 vectors, 96 negative controls: jcs-canonicalization (53), refusal-unions (6, frozen from the exported *_CODES arrays), policy-resolution (12, incl. specificity and the irreversibility floor), chain-verification (18, mutation and truncation), schema-validation (106, machine-readable failure_class replacing fixtures that asserted only 'fails somehow'), gate-verdicts (20). Carter's clean-room extractions folded and superseded: inputs reused, every expectation recomputed through this repo's code, RFC 8785 §3.2.4 published bytes as the faithfulness cross-check; FIXTURES.md's conventions replaced by conformance/README.md. Vectors are generated, never hand-edited (scripts/regen-conformance-vectors.mjs); manifest pins SHA-256 of every file both directions; a suite with no executor, a wrong count, a duplicate id, a control that passes, or an empty directory is a hard failure, never a skip. AC 4's CI-fails-on-drift delivered inside npm test (agents cannot edit .github/; a dedicated workflow step is Carter's if wanted). Proved its worth same-day: PR #130's new refusal codes tripped the union vectors in the merge and regenerated as a visible diff. Honest pin became APRV-147 (request intake does not check registration), filed high. SPEC §13 amended pending sign-off.

APRV-137 dependency (recorded 2026-08-29 by the APRV-137 build session).

APRV-137 produces the normative refusal-code registry this task needs: one line per member of every frozen refusal union, stating the condition under which that member fires. That registry is the failure_class SOURCE for this task expected-refusal vectors. Assign failure_class from the registry text, never from the reference implementation source, and never from a codes name read alone: a vector that pins a trigger the registry does not state would freeze folklore, which is the sequencing reason APRV-137 lands before or with this task.

Where the registry lives: it is SPEC.md section 11.2, inserted between section 11.1 and section 12. At the time of writing the insertion had not yet cleared its policy.edit tap (two hook-timeout refusals), so the exact text is parked verbatim in docs/aprv-137-pending-spec-appendix.md on branch aprv-137-normative. If that file is gone, the registry landed in SPEC.md and SPEC.md is the source.

Three things to carry into the vectors.
1. Regenerate the union membership from conformance/vectors/refusal-unions.v1.json, which APRV-137 bumped to vectors_version 4.0.0. Do NOT use ../approval-md-cleanroom/extracted/refusal-unions.json: that export is dated 2026-08-25 and is now NINE codes stale (gate is missing policy-drift, diff-too-large, proposal-not-found, proposal-stale, policy-already-attested and the new actor-not-approver; execute is missing execution-delegated, execution-indeterminate, not-indeterminate, already-reconciled). Any coverage claim made from it is under-scoped.
2. actor-not-approver is new in this wave and needs its own vector: a grant by a human the resolved rule approvers list does not name.
3. Two codes carry conditions their names do not describe, and the registry says so: execute-path actor-not-human doubles as the empty-mandatory-note refusal on resolve and reconcile, and harness-executed is a shape condition on the grant rather than a report that a command already ran. Vectors pinning either should follow the registry wording.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A versioned, manifest-pinned conformance suite: 215 vectors across six families with 96 negative controls, superseding the clean-room's extractions, regenerable only through the reference implementation. Caught its first real drift the day it merged. Merged in PR #131.
<!-- SECTION:FINAL_SUMMARY:END -->
