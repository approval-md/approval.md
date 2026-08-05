---
id: APRV-21
title: Spec-only commit Part B per AMENDMENTS.md
status: In Progress
assignee:
  - '@fable'
created_date: '2026-08-05 02:21'
updated_date: '2026-08-05 03:50'
labels: []
milestone: m-3.1
dependencies:
  - APRV-20
priority: medium
type: docs
ordinal: 21000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Spec-only changes per the human's AMENDMENTS.md Part B (file not yet in repo as of task creation — blocked on it landing on main), including updating SPEC.md section 11's not-defended list per amendment A1. No code changes; the dogfood and conformance suites must stay green, proving the spec edits describe shipped behavior rather than diverging from it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Part B spec edits applied exactly per AMENDMENTS.md, as a spec-only commit
- [ ] #2 Section 11 not-defended list updated per amendment A1
- [ ] #3 npm test remains green after the spec-only commit (no behavioral drift introduced)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent lands: Part B texts B1-B7 + roadmap note verbatim; max_latency deferral note (S2); section 10.1 token-comment replacement (approved wording); verify A1 section 11 splice already landed in APRV-20 (no duplicate); new Global invariants subsection in section 11 with per-invariant enforcing-test citations; policy-schema + fixture additions for B2 limits vocabulary; fixtures exercising record.* classes for B6; AMENDMENTS.md deleted in the same commit.
2. Fable: verify all Part B texts verbatim against the pre-deletion file, gates from wiped install, write the traceability table (every A/B item -> spec section, commit, enforcing test or spec-only-by-design) in the m-3.1 report and task notes, finalize, merge, push.
3. m-3.1 exit criteria checks: conformance re-check on the three drift items; live repo log verify incl. genesis attestation; cli.js mode note.
<!-- SECTION:PLAN:END -->
