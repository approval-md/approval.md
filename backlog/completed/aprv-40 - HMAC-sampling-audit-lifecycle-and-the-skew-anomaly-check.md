---
id: APRV-40
title: 'HMAC sampling, audit lifecycle, and the skew anomaly check'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 14:18'
updated_date: '2026-08-05 18:59'
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
- [x] #1 Deterministic sampler: HMAC-SHA-256(secret, event hash) mapped to [0,1) against supervised_sample_rate; reproducible given the secret, unpredictable without it; property tested incl. rate-zero and rate-one
- [x] #2 The daemon appends audit.sampled for selected supervised starts exactly once per event; approval audit review appends audit.reviewed (human-only), and the queue's audit backlog section fills and clears accordingly
- [x] #3 verify() gains a non-fatal anomalies list flagging gate-typed events whose ts is implausibly skewed vs neighbors (threshold documented, drafted for review); clean logs with anomalies remain clean; log verify and status surface them
- [x] #4 The secret never appears in the log, any output, or any fixture; tests use a test-scoped env var
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, isolated worktree from main (post-39/43). 2. Deterministic HMAC sampler in core (secret via audit.sampling_secret_env, APRV-38 vocabulary); daemon samples supervised execution.started, appends audit.sampled exactly once (compare-and-append, re-derive per tick); approval audit review human-only verb appends audit.reviewed; queue audit backlog fills and clears. 3. verify() non-fatal anomalies list for gate-typed ts skew vs neighbors, threshold drafted for review; clean-with-anomalies stays clean; surfaced in log verify and status. 4. Secret never in log/output/fixtures. File boundary: owns src/core/audit or sampler module, cli audit verb, verify anomalies; daemon edits confined to a sampling hook. PR, ci green, auto-merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Rider (human, at decomposition review): the skew threshold drafted-for-review at task time is approved as the approach.

Opus subagent build, PR #9, merged after fable resolved the three-way daemon.ts overlap (40+41+42 hooks now sit in tick order: TTL sweep, audit sampling, pruning, closing read, render, git evidence — samples and prunes land before the closing head so the same tick renders and witnesses them). Sampler: HMAC-SHA-256(secret, event hash) -> [0,1) vs rate; secret held in a closure, never serialized (toJSON emits rate + env var NAME); tests assert absence from serialization, disabled messages, and the log. Eligibility re-derives class from task.registered + policy-match; a structural test asserts supervisedExecutions reads no payload (self-report) field — invariant 4 load-bearing. audit.sampled omits the selection value (secret holders can recompute; logging it adds only an oracle). approval audit review human-only; audit list shows backlog + sampler state; no audit sample verb by design. TWO ITEMS FLAGGED FOR HUMAN SIGN-OFF, both drafted into SPEC 5.2/8 text: (1) skew threshold GATE_TS_SKEW_TOLERANCE_MS=2000, regression direction only vs previous gate-typed record (non-gate writers legitimately author ts) — order above NTP disagreement, orders below a useful lie; pinned by test; policy-configurability would be its own vocabulary task. (2) Sampling FAILS OPEN when rate/secret unconfigured, machine-readable reason surfaced: escalating everything would need a selection function, the only remaining seed is agent-authored event content which 5.2 forbids by name; a control that looks live while steerable is worse than one visibly off; bounded because sampling is retrospective and authorizes nothing. Divergences recorded: render-queue empty-state test rewritten (it pinned prose asserting the sampler did not exist); VerifyResult gained a required anomalies field on all variants (type-level break for external consumers; none exist); anomalies appear in status/verify --json only when non-empty to keep frozen deep-equal shapes. Follow-up candidates surfaced: event-schema human-actor conditional for audit.reviewed; first-class sampled DaemonEvent; sampler state in status --json.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Deterministic HMAC sampler (secret unpredictable to agents, reproducible to the operator), daemon audit.sampled sweep + human-only audit review lifecycle with queue backlog, and non-fatal gate-ts skew anomalies on verify (2s threshold, flagged). Fails-open-when-unconfigured reasoning drafted into SPEC 5.2 for sign-off. Merged as PR #9, 1127 tests with all three M5 parallel tasks composed.
<!-- SECTION:FINAL_SUMMARY:END -->
