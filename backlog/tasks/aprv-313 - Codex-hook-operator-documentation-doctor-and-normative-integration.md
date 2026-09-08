---
id: APRV-313
title: Codex hook operator documentation doctor and normative integration
status: To Do
assignee: []
created_date: '2026-09-08 07:25'
labels: []
dependencies:
  - APRV-312
priority: high
type: feature
ordinal: 231000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User-authorized overnight Codex integration. SPEC 6.3,7,9,10,11.1 bind. Isolated code/tests/delivery now; everyday activation and human decisions only in morning. No deployment, credentials, dependencies or production policy/log mutation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Help/examples/runbook specify opt-in shell/patch coverage, failure gaps, ten-minute outer timeout and nine-minute gate wait.
- [ ] #2 Doctor distinguishes configured wiring from trusted/observed operation and checks Codex provenance.
- [ ] #3 Narrow SPEC edits follow the gate; no live installation, daemon restart, dependencies or release.
<!-- AC:END -->
