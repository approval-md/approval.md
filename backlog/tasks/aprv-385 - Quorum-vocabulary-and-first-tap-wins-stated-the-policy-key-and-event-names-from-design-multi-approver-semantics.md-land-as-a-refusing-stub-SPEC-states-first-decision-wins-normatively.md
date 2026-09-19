---
id: APRV-385
title: >-
  Quorum vocabulary and first-tap-wins stated: the policy key and event names
  from design/multi-approver-semantics.md land as a refusing stub, SPEC states
  first-decision-wins normatively
status: To Do
assignee: []
created_date: '2026-09-19 16:26'
labels:
  - policy
  - schema
  - spec
  - quorum
dependencies: []
priority: medium
ordinal: 297000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
GitHub issue 138 (infinitestream, 2026-08-29) asked for two things: first-tap-wins stated as the normative default for concurrent decisions on one request, and a per-class approvals count so a policy can demand N human grants before the token mints. APRV-323 delivered the design (design/multi-approver-semantics.md) and its section 6 verdict was: do not build quorum before APRV-324 (per-sender identity), and land the vocabulary as a documented refusing stub if the schema needs to be stable early. APRV-324 landed 2026-09-18 (PR 427, live check seq 44620 and 44631), so quorum is unblocked; the full build is the sixteen items of section 5 and the twenty tests of section 7 and is a later task set. This task is the stub the design recommends: section 5 items 1 to 7 and 11 (the policy key, the endorsement and grant event vocabulary in the schema, the refusal codes in the union), a load-time refusal for quorum N greater than 1 whose message names what it needs, and the SPEC amendment that states first-decision-wins as the guarantee the runtime already gives (the stale tap is annotated, never a second decision). A quorum of one and an absent key must produce a log byte-identical to today, pinned by a test. Follow-up: file the full quorum build as tasks from section 5 once this lands and after release 0.3.0. Related: APRV-323, APRV-324, APRV-249, issue 138.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 SPEC section on decisions states first-decision-wins normatively for concurrent decisions on one request, with the stale-tap annotation, in one commit called out to the human
- [ ] #2 policy.schema.json and event.schema.json carry the quorum key and the endorsement vocabulary from design section 5 items 1 to 7 and 11; fixtures and conformance vectors added; the refusal codes join the union with a version bump
- [ ] #3 A policy declaring quorum greater than 1 is refused at load with a machine-readable code and a message naming the full-build task; quorum of 1 and absent quorum produce a log byte-identical to a policy without the key, with a test
- [ ] #4 Issue 138 gets a comment linking this task and the follow-up; build, typecheck, lint, policy, schema and conformance suites pass
<!-- AC:END -->
