---
id: TASK-3
title: Send deposit chaser email
status: To Do
assignee: []
created_date: '2000-01-01 00:00'
labels: []
dependencies: []
ordinal: 4000
approval:
  origin:
    app: example-capture
    created_by: "human:carter"
  route:
    assignee: "agent:claude-admin"
    confidence: 0.82
    rationale: "templated chaser, known counterparty, no negotiation"
  state: awaiting
  actions:
    - class: communicate.email.external
      summary: "Send deposit chaser to agency@example.co.uk"
      reversible: false
      est_cost_usd: 0.02
      idempotency_key: "task-3:chaser:2026-08-04"
  budget:
    max_cost_usd: 0.50
    max_latency: 6h
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Firmer follow-up citing the deposit-protection scheme deadline.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Email sent
<!-- AC:END -->
