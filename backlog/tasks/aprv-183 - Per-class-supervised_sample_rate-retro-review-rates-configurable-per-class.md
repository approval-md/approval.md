---
id: APRV-183
title: 'Per-class supervised_sample_rate: retro review rates configurable per class'
status: To Do
assignee: []
created_date: '2026-08-31 23:25'
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
- [ ] #1 Policy schema accepts an optional per-class retro sample rate; absent falls back to the global audit.supervised_sample_rate; schema and load tests
- [ ] #2 Retro selection uses the per-class rate when declared, property-tested for determinism (identical bytes select identically) and agent-unpredictability (secret-keyed)
- [ ] #3 Bare supervised alias honours a per-class rate identically to explicit supervised-retro, load-time note preserved
- [ ] #4 Disabled-sampler reporting is per-class-aware: doctor and status name which classes sample at which rate and which are disabled, with the machine-readable reason
- [ ] #5 SPEC 5/7 amendment drafted and flagged pending sign-off; no silent spec edit
<!-- AC:END -->
