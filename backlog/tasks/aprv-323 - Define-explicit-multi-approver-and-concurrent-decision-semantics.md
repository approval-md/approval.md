---
id: APRV-323
title: Define explicit multi-approver and concurrent-decision semantics
status: Done
assignee:
  - '@opus-lane-closeouts'
created_date: '2026-09-08 22:51'
updated_date: '2026-09-17 01:58'
labels: []
dependencies:
  - APRV-249
references:
  - 'https://github.com/approval-md/approval.md/issues/138'
priority: medium
type: feature
ordinal: 240000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
GitHub issue #138 requests a stated first-decision default and optional per-policy multi-approver quorum. This is a security and schema design task before implementation. Establish distinct human identity, concurrent decisions, rejection/expiry/revocation behavior, token-mint timing and compatibility with the existing one-grant contract. Coordinate with APRV249 identity/receipts work.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A reviewed design states the current single-decision behavior and specifies quorum identity, denial, expiry, concurrency, budget and token rules without implying quorum already exists.
- [x] #2 The design identifies required spec/schema changes and adversarial acceptance tests; current gate behavior remains unchanged until that design is authorized.
- [x] #3 Issue #138 links to the durable task and remains open until the requested behavior is actually delivered.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read the single-decision path end to end and write it down with line references before proposing anything: the decide guards, the projection that settles the first decision, token minting relative to the grant append, TTL and lazy expiry, the append lock and head-moved retry, budget evaluation, and how each channel chooses the actor it records. 2. Choose an event shape for a quorum and say why the two alternatives were rejected. 3. State the rules one at a time: identity and distinctness, denial, expiry, concurrency, budget, token, revocation, and the supervised-live interaction. 4. List every SPEC, schema, conformance and runtime change the design would require, as separate tasks. 5. Enumerate adversarial acceptance tests, including the compatibility regression that a quorum of one is byte-identical to today. 6. Say plainly whether the design is worth building on the current trust boundary, and if not, say what has to land first. 7. Change no runtime code.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivered by the closeouts lane, 2026-09-16: design/multi-approver-semantics.md, a reviewed design and no runtime change. Classifies policy.edit.design (supervised-retro).

AC1. Section 1 states the current single-decision behaviour precisely, from the code rather than from memory, with line references throughout: the ordered guards in attemptDecide including the already-decided refusal for a second grant at gate.ts:2672-2679 whose message is that a second decision would rewrite a human's answer; the independent reader-side settle closure at state.ts:1338-1354 that makes the first decision stick; token minting at gate.ts:2865 immediately before the append with only the hash reaching the log; TTL parsing, lazy expiry and the two appendExpiry callers; the append lockfile and headPrecondition with the three-attempt head-moved retry that re-runs the whole derivation so a losing decider gets a re-derived refusal rather than a plumbing error; budget evaluation in the grant branch before the append, counting approval.granted records; and each channel's one-time resolveHumanActor call.

Section 4 specifies quorum rule by rule: identity and distinctness with the new already-endorsed refusal and the load-time rule that quorum N needs at least N approvers and a manual class; denial deliberately asymmetric, so one rejection is terminal whatever the count, with the consequence that any named approver can veto stated rather than hidden; expiry running from the request and explicitly NOT extended by endorsements, with the operational note that a quorum needs a TTL long enough for N people to be awake; concurrency reusing the existing lock and retry, with the Nth endorsement required to be one transaction so no crash can leave N endorsements and no grant; budget evaluated once at the Nth endorsement so a quorum action is charged once, and the honest consequence that a budget refusal arrives after N-1 people have endorsed; one grant and one token, with secret sharing rejected for adding a cryptographic failure mode to buy a property the trust boundary does not claim.

The document says in its status line, in its title section, and again in its closing section that quorum does not exist in this runtime today and that nothing here is wired into the gate. No src/ file was touched.

AC2. Section 5 lists the required changes as sixteen numbered items across SPEC.md, event.schema.json, policy.schema.json, conformance/ and the runtime, each a task of its own. Section 7 enumerates twenty adversarial acceptance tests grouped by counting, denial and revocation, expiry, concurrency, budget, policy loading and identity, all specified to be built through the real append path. The one that matters most is called out as such: quorum of one, and absent quorum, must produce a log byte-identical to one written before the feature existed.

The design's own recommendation, which is the part to argue with. A quorum of N over identities that are not distinguishable is a quorum of one counted N times. Today every Telegram tap is recorded against the actor the listener process was launched with, and the callback's from field is never read, so two approvers in one chat both endorse as the same actor. The recommendation is therefore not to build quorum until APRV-324 lands, and to make quorum greater than one a load-time refusal naming APRV-324 in the meantime. A gate that refuses to pretend is worth more than a gate that counts. The task declares a dependency on APRV-249; the document argues it should declare one on APRV-324 too.

AC3. The task references issue #138, and the issue stays open: the design is not the behaviour the issue asks for. Adding a comment on the issue itself is a network write and a gated action, so it is left to the human rather than done here.

Delivered in pull request #414 (lane/closeouts).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Wrote design/multi-approver-semantics.md: the current single-decision path stated precisely from src/core/gate.ts, src/core/state.ts and the three channels with line references; a proposed optional per-rule quorum specified rule by rule for identity and distinctness, denial, expiry, concurrency, budget, token and revocation; sixteen required SPEC, schema, conformance and runtime changes listed as separate tasks; and twenty adversarial acceptance tests enumerated, including the byte-identical regression for quorum of one. The document states repeatedly that quorum does not exist today and changes no gate behaviour, and no runtime file was touched. Its recommendation is to build nothing until APRV-324 lands, because a quorum over identities the runtime cannot tell apart is one person counted N times. Issue #138 remains open.
<!-- SECTION:FINAL_SUMMARY:END -->
