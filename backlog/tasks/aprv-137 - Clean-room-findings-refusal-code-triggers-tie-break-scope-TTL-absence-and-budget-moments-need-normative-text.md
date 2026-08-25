---
id: APRV-137
title: >-
  Clean-room findings: refusal-code triggers, tie-break scope, TTL absence, and
  budget moments need normative text
status: To Do
assignee: []
created_date: '2026-08-25 13:08'
labels:
  - spec
  - cleanroom-review
  - conformance
dependencies: []
references:
  - ../approval-md-cleanroom/SPEC-GAPS.md
  - ../approval-md-cleanroom/IMPLEMENTER-NOTES.md
  - src/core/gate.ts
  - src/core/token.ts
  - src/core/execute.ts
  - src/core/log.ts
priority: medium
type: task
ordinal: 124000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A clean-room Python implementation was built from SPEC.md plus the frozen fixtures alone (kit and deliverables in ../approval-md-cleanroom). It passed every shipped vector and verified the 293-record production chain end to end, but recorded eight ambiguities in SPEC-GAPS.md where the spec is silent and an implementer must invent behavior. Six survive triage as spec work here (GAP-5 is split out as APRV-136; GAP-2, trailing .* depth, needs only a confirming sentence and is folded into the section 5.2 amendment). Each item names the gap, the clean-room provisional fail-closed reading, and what the spec owes. Where the reference implementation already embodies an answer, the work is to write that answer down; where it does not, the work is to decide one. All SPEC amendments are human sign-off.

1. GAP-1, refusal code for caller-supplied timestamps. Section 8 mandates refusal but names no machine-readable code. Provisional reading: append-boundary validation. Confirm against the TS gate and name the code in section 8.
2. GAP-3, ties beyond autonomy. Section 5.2 resolves autonomy among equally specific rules and says nothing about approvers and limits. Provisional reading: intersect approvers, apply limits conjunctively, empty intersection fails closed. This decision changes who can authorize real spend; the TS behavior must be established, compared, and the winner specified in section 5.2.
3. GAP-4, budget moment for non-manual classes. Section 5.2 meters authorization, but supervised and autonomous actions emit no approval.* events. Provisional reading: execution.started is the consumption moment. Specify in section 5.2.
4. GAP-6, harness-executed semantics. The code is frozen API in three unions with zero prose definition. Write its trigger into the spec (the APRV-106 harness-grant story).
5. GAP-7, absent approval_ttl. Nothing states whether pending requests and tokens expire when the optional key is omitted. Provisional reading: no expiry. Specify absence semantics explicitly in section 5.1.
6. GAP-8, execute-path actor-not-human. The union member trigger on the execute path is undefined in prose. Provisional reading: refuse system: drivers. Confirm against src/core/execute.ts and document.

The clean-room reflection also proposes a normative appendix: one line per refusal code stating when it fires. That appendix is the durable fix for items 1, 4, and 6 and feeds APRV-122 directly, whose expected-refusal vectors need exactly these trigger definitions to assign failure_class to every code. Sequencing: this task lands before or with APRV-122, since vectors pinning undocumented triggers would freeze folklore.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 For each of the six items, the reference implementation actual behavior is established and recorded in the task notes, with a match or mismatch verdict against the clean-room provisional reading
- [ ] #2 SPEC amended: section 8 names the caller-ts refusal code; section 5.2 specifies tie handling for approvers and limits, the budget moment for non-manual classes, and the trailing .* depth sentence; section 5.1 specifies absent-TTL semantics; all marked for human sign-off
- [ ] #3 A refusal-code appendix exists: every member of the five frozen unions has a one-line normative trigger definition, including harness-executed and execute-path actor-not-human
- [ ] #4 Any mismatch between TS behavior and the new spec text is resolved toward the stricter reading or called out to the human as a divergence, never patched silently
- [ ] #5 APRV-122 is annotated to consume the appendix as its failure_class source
- [ ] #6 npm test passes; lint clean
<!-- AC:END -->
