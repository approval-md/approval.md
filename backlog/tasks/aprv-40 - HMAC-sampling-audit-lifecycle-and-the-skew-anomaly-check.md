---
id: APRV-40
title: 'HMAC sampling, audit lifecycle, and the skew anomaly check'
status: To Do
assignee: []
created_date: '2026-08-05 14:18'
updated_date: '2026-08-05 14:27'
labels: []
milestone: m-7
dependencies:
  - APRV-38
  - APRV-39
priority: high
type: feature
ordinal: 40000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Amended SPEC section 5.2 (B1): sample selection reproducible by the operator and unpredictable to agents — HMAC-SHA-256 over the event hash with the operator-held secret, compared against supervised_sample_rate. The daemon samples supervised execution.started events, appending audit.sampled (system actor); approval audit review <seq|action> records audit.reviewed (human-only verb, note optional). Plus the deferred A2 enforcement: verification treats gate-typed events with implausible timestamp skew relative to neighbors as a reportable anomaly, never silently accepted — a warnings channel on the verify result (clean-with-anomalies is still clean; anomalies listed, surfaced by status and log verify output), threshold documented and flagged for review.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Deterministic sampler: HMAC-SHA-256(secret, event hash) mapped to [0,1) against supervised_sample_rate; reproducible given the secret, unpredictable without it; property tested incl. rate-zero and rate-one
- [ ] #2 The daemon appends audit.sampled for selected supervised starts exactly once per event; approval audit review appends audit.reviewed (human-only), and the queue's audit backlog section fills and clears accordingly
- [ ] #3 verify() gains a non-fatal anomalies list flagging gate-typed events whose ts is implausibly skewed vs neighbors (threshold documented, drafted for review); clean logs with anomalies remain clean; log verify and status surface them
- [ ] #4 The secret never appears in the log, any output, or any fixture; tests use a test-scoped env var
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Rider (human, at decomposition review): the skew threshold drafted-for-review at task time is approved as the approach.
<!-- SECTION:NOTES:END -->
