---
id: APRV-21
title: Spec-only commit Part B per AMENDMENTS.md
status: To Do
assignee: []
created_date: '2026-08-05 02:21'
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
