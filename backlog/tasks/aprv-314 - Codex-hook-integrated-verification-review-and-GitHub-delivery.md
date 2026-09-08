---
id: APRV-314
title: Codex hook integrated verification review and GitHub delivery
status: To Do
assignee: []
created_date: '2026-09-08 07:25'
labels: []
dependencies:
  - APRV-311
  - APRV-312
  - APRV-313
priority: high
type: task
ordinal: 232000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User-authorized overnight Codex integration. SPEC 6.3,7,9,10,11.1 bind. Isolated code/tests/delivery now; everyday activation and human decisions only in morning. No deployment, credentials, dependencies or production policy/log mutation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Astra reviews security-sensitive diffs; focused/full tests lint typecheck conformance and CI parity have recorded results.
- [ ] #2 Per-task reviewed commits are pushed in feature PR, merge armed under policy and actual GitHub state verified.
- [ ] #3 Handoff has worktree branch commits PR checks gaps and morning instructions; no log artifacts in feature commits.
<!-- AC:END -->
