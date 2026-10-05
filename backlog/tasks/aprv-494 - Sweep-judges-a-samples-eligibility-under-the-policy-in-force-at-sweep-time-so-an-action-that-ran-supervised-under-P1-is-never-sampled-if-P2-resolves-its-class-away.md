---
id: APRV-494
title: >-
  Sweep judges a sample's eligibility under the policy in force at sweep time,
  so an action that ran supervised under P1 is never sampled if P2 resolves its
  class away
status: To Do
assignee: []
created_date: '2026-10-05 15:39'
labels:
  - review
  - supervised-retro
dependencies: []
priority: high
ordinal: 378000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The audit sweep still judges eligibility and the sampling rate under the policy in force at sweep time. NF-3 (PR #614 fix round 2) pinned the REVIEW roster to the policy the action ran under (audit.sampled.policy_sha256 is the latest attestation before the sampled execution.started), but the decision whether to sample at all is not pinned: an action that ran supervised-retro under policy P1 is never sampled if P2, attested before the sweep, resolves its class to manual or autonomous. Stated as 'NF-3 residual, not fixed' in the PR #614 body (fix round 2, For the orchestrator / human), flagged as a candidate follow-up in the APRV-480..483 task notes. The effect is an unreviewed supervised-retro action that counted as individual approval only on the strength of a later review, which never arrives.

Decision to make: judge eligibility and rate under the policy the action ran under (the same pin NF-3 already reads from the verified log), or keep sweep-time judgement and name that in SPEC section 9 and docs. If pinned, decide the rate source for a class the current policy no longer lists.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A decision is recorded here: eligibility and rate judged under the run-time policy, or sweep-time kept with the reason
- [ ] #2 If run-time: a test where P1 supervised-retro ran, P2 attested before the sweep resolves the class to manual, and the action is still sampled and reviewable under P1's roster
- [ ] #3 If sweep-time kept: docs and SPEC section 9 name it, and the sampled-audit backlog says which actions fall out
- [ ] #4 A test pins the chosen behaviour for a class absent from the current policy
<!-- AC:END -->
