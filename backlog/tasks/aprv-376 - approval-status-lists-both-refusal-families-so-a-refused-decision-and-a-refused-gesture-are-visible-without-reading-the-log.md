---
id: APRV-376
title: >-
  approval status lists both refusal families, so a refused decision and a
  refused gesture are visible without reading the log
status: To Do
assignee: []
created_date: '2026-09-19 10:59'
labels:
  - audit
  - cli
  - status
dependencies: []
priority: low
ordinal: 291000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Filed on the orchestrator ruling of 2026-09-19 while landing APRV-355. Neither audit.decision_refused (APRV-235) nor audit.gesture_refused (APRV-355) is listed by approval status or approval audit today; both are visible only through approval log tail and approval log export. APRV-355 AC4 originally asked for a listing and was reworded rather than built, on the reasoning that adding one for the newer record alone would leave the older one invisible and the two inconsistent. Add the listing for BOTH families at once: a count of each in approval status informational fields, with the newest few seqs and their codes, so an operator who is told that taps from an account they did not map are being refused can see how many and from which account without reading the chain. Informational only, like coverage and anomalies: it moves neither the health verdict nor the exit code, and it reads only verified records. Related: APRV-235, APRV-324, APRV-355.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval status reports a count of audit.decision_refused and of audit.gesture_refused records, each with the newest few seqs and their refusal codes, in the JSON and the human rendering
- [ ] #2 The fields are informational: they move neither healthy nor the exit code, and a log with none of either omits them rather than printing zeros
- [ ] #3 Only verified records are read, and docs/cli-reference.md describes the fields under status
- [ ] #4 Tests cover both families present, one present, and neither; build, typecheck, lint and the status suite pass
<!-- AC:END -->
