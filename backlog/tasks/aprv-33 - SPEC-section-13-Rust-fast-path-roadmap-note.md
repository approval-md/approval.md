---
id: APRV-33
title: 'SPEC section 13: Rust fast-path roadmap note'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 13:37'
updated_date: '2026-08-05 13:38'
labels: []
milestone: m-6
dependencies: []
priority: low
type: docs
ordinal: 33000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Human-dictated roadmap addition (2026-08-09), post-v1, non-normative: a Rust fast-path implementation of the hot loop (policy resolution, chain-tail verification, gate verdict) as the engine for per-tool-call hook adapters, where Node startup latency is unacceptable; conformance defined by the fixture suite; the crates.io name approval-md reserved for it; the TypeScript runtime remains the reference implementation for the full surface. Landed in section 13 alongside the existing Post-v1 non-normative note, wording near-verbatim from the dictation, style rule observed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The Rust fast-path paragraph lands in SPEC section 13 as a Post-v1 non-normative note, matching the dictated content
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
One-paragraph Post-v1 non-normative note added to SPEC section 13 per dictation: Rust fast-path for the hot loop behind per-tool-call hook adapters, fixture-suite conformance, crates.io name reserved, TypeScript as reference implementation. Verified: 900/900 suite unaffected.
<!-- SECTION:FINAL_SUMMARY:END -->
