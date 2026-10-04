---
id: APRV-447
title: execution.started carries policy_sha256 for policy-authorized starts
status: To Do
assignee: []
created_date: '2026-10-03 03:49'
labels:
  - schema
  - gate
  - agent-village
dependencies: []
references:
  - private/agentvillage-integration/06-gap-register.md
priority: medium
ordinal: 335000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A harness execution record for an autonomous or supervised class carries class, payload_hash, execution harness and grant_origin, and no policy hash; only approval.requested and approval.granted may carry policy_sha256 today (schema/event.schema.json). A manual start can recover the policy in force through grant_seq; a policy-authorized start cannot, and a reader must reconstruct it from the latest policy.updated before that seq. The Agent Village follower (agentvillage-data docs/spec-addenda.md section 7.7, ruling 4) therefore cannot set policy_version on any action.* event and the research condition bounded_agent_led is unreachable for every co-located tenant, which on day one is every tool call (the whole recorder layer resolves autonomous). Stamp the attested policy hash the gate resolved against onto execution.started at the write boundary for every harness path (hook, propose/start), additive and optional in the schema, covered by the record hash, never a caller parameter, never an input to a verdict. Context: private/agentvillage-integration/06-gap-register.md G9.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 execution.started written by startHarnessExecution and consumeHarnessGrant carries policy_sha256 equal to the attested hash the gate resolved the class against, stamped by the runtime and ignored if supplied by a caller, proven by tests on both paths
- [ ] #2 schema/event.schema.json admits policy_sha256 on execution.started as optional; every historical record validates unchanged; conformance schema-validation vectors regenerated
- [ ] #3 SPEC section 8 record-fields hunk proposed in the implementation notes as pending sign-off, not applied
- [ ] #4 docs/README-extended.md names the field and the agentvillage-data follower mapping note is updated or a pointer filed there
<!-- AC:END -->
