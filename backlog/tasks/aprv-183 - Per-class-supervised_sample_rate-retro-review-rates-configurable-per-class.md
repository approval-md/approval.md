---
id: APRV-183
title: 'Per-class supervised_sample_rate: retro review rates configurable per class'
status: Done
assignee:
  - 'agent:fable'
created_date: '2026-08-31 23:25'
updated_date: '2026-09-01 04:46'
labels:
  - policy
  - gate
  - spec
dependencies: []
priority: medium
ordinal: 159000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
2026-08-31, from the human: 'i'd like supervised sample rate to be configurable per class'. Today audit.supervised_sample_rate is one global knob (SPEC.md ~line 114, live policy at 0.15): every supervised-retro action across every class enters the retro pool at the same rate. APRV-127 already made the LIVE rate per-class (live_rate declared on a supervised-live class); this task gives the retro rate the same shape.

Design sketch, to be validated against SPEC 5/7 and the policy schema at pickup: classes gain an optional retro_rate (or sample_rate) falling back to audit.supervised_sample_rate when absent; selection stays HMAC-SHA-256(sampling secret, event hash) under the rate, per-class rate substituted; the disabled-sampler honesty rule is unchanged (absent/zero rate or unset secret disables sampling for that class and states the reason machine-readably, since retro sampling authorizes nothing and must not pretend to run). Watch the APRV-127 seam: bare 'supervised' aliases supervised-retro, so the per-class knob must work identically through the alias with the load-time note preserved.

Requires a SPEC amendment (policy grammar + the supervised_sample_rate section), flagged pending sign-off per convention, and a policy.edit amendment ceremony to use it in APPROVAL.md, which is the human's call.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Policy schema accepts an optional per-class retro sample rate; absent falls back to the global audit.supervised_sample_rate; schema and load tests
- [x] #2 Retro selection uses the per-class rate when declared, property-tested for determinism (identical bytes select identically) and agent-unpredictability (secret-keyed)
- [x] #3 Bare supervised alias honours a per-class rate identically to explicit supervised-retro, load-time note preserved
- [x] #4 Disabled-sampler reporting is per-class-aware: doctor and status name which classes sample at which rate and which are disabled, with the machine-readable reason
- [x] #5 SPEC 5/7 amendment drafted and flagged pending sign-off; no silent spec edit
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent builds in an isolated worktree on branch autonomy-vocab, explicitly created from origin/main e70006d (fleet lesson: never fork a lane from an implicit base).
2. Scope: policy schema gains optional per-class retro_rate; loader validates; retro sampler substitutes the class rate, falling back to audit.supervised_sample_rate; the supervised alias path honours it identically with its load-time note; doctor/status report per-class rates and disabled classes with machine-readable reasons.
3. SPEC 5 amendment drafted, flagged pending sign-off; no silent spec edits.
4. Agent does not touch backlog/ files; lifecycle edits and notes recorded by the orchestrator in the session worktree.
5. Verification: full targeted test run in the lane; fable reviews the diff; APRV-185 builds on the same branch afterwards.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built by an Opus lane on autonomy-vocab (e017ede), merged via PR #171. Key decisions: retro_rate admitted on supervised-live too (its ungated fraction still enters the retro pool); rate on manual/autonomous is a load error mirroring live_rate (schema stays closed, no silent no-ops); sampler stays ENABLED when only class rates exist (EnabledSampler.rate went nullable with machine-readable fallbackReason); reporting extended doctor's audit-sampling check and audit list's sampling object, while status --json stays untouched BY DESIGN (frozen shape that never carried the sampler) — the AC's 'status' is satisfied by the two surfaces that actually speak for sampling; audit.sampled payload keeps its key set, only the rate value is per-class (no event-schema churn); rateFor() delegates to resolve() so specificity/strictness/floor stay one implementation. Verification: new tests/retro-rate.test.ts 20/20; targeted suites 292+195 pass; full suite 2464/2465 (one pre-existing lane-only ci-guard ENOENT, absent in CI); lint clean; CI green on PR #171; conformance regen rode the APRV-185 commit. SPEC 5.2 amended, flagged pending sign-off. Gotcha recorded: YAML class keys beginning with * must be quoted in test policies.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Per-class retro_rate landed via PR #171 (commit e017ede): schema, sampler, alias path, doctor/audit-list reporting, 20 new tests, SPEC 5.2 amendment flagged pending sign-off. Verified by the lane's full suite (2464/2465, one pre-existing env-only failure) and green CI on the merged PR.
<!-- SECTION:FINAL_SUMMARY:END -->
