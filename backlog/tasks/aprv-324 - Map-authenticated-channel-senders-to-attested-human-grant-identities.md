---
id: APRV-324
title: Map authenticated channel senders to attested human grant identities
status: In Progress
assignee:
  - '@opus-lane-closeouts'
created_date: '2026-09-08 22:53'
updated_date: '2026-09-17 01:58'
labels: []
dependencies:
  - APRV-249
references:
  - 'https://github.com/approval-md/approval.md/issues/137'
priority: medium
type: feature
ordinal: 241000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
GitHub issue #137 requests grant attribution to the actual Telegram callback sender rather than the shared listener process identity. Design an operator-attested sender-to-human mapping inside the existing machine trust boundary, coordinated with APRV249, without treating caller-supplied identity as proof.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A reviewed design defines sender mapping, unknown-sender refusal, per-class approvers, audit fields and safe migration from listener identity.
- [ ] #2 Implementation tests cover two distinct senders, missing or stale mapping, spoofed request fields, unauthorized sender and concurrent decisions before changing production attribution.
- [x] #3 Issue #137 remains open until implemented and verified; documentation states exactly what the channel can authenticate.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Trace what each channel actually authenticates, with line references, before proposing a mapping: resolveHumanActor as the single resolution point, the one-time call in each of the three channels, the Telegram chat-id check and the fact that the callback from field is never read, and what the decision record carries today. 2. State honestly what each transport can prove, so the mapping is not built on a field that is not evidence. 3. Propose the mapping as an additive optional key inside the existing attested approvers roster, resolved at the channel boundary so the gate's authorization logic is unchanged. 4. Make an unmapped sender a refusal with a recorded audit event, never a fallback to the configured actor. 5. Specify the audit fields, and say which fields must never be recorded and why. 6. List every SPEC, schema and runtime change. 7. Give a three-phase migration with a rollback that needs no code change, and name the compatibility promise for a deployment that never adopts it. 8. Enumerate the AC2 test cases in full. 9. Change no runtime code.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivered by the closeouts lane, 2026-09-16: design/channel-sender-identity.md, a reviewed design and no runtime change. Classifies policy.edit.design (supervised-retro).

AC1 checked. Section 1 traces what is recorded today with line references: resolveHumanActor at attest.ts:432-440 is the whole of identity, each channel calls it once at start-up (channel-telegram.ts:436, channel-web.ts:370-371, channel.ts:278-279) and then passes one fixed actor to recordChannelDecision for every decision that surface collects, and the record is appended with that literal string at gate.ts:2910-2921. The Telegram callback is checked against the configured chat id at telegram.ts:3327-3331 and the update's from object is never read anywhere in that file. Section 2 then states, per transport, what can actually be proved: exactly one field in the whole system is worth mapping, Telegram's from.id, and even that is evidence about an account rather than about a person.

Section 3 defines the mapping: an additive optional senders key inside the existing approvers roster in APPROVAL.md, so it inherits the human-only attestation ceremony that already protects the roster and an agent cannot add itself as an approver's sender. It is written person to sender, per channel, and resolved at the channel boundary before decide is called, so the gate's authorization logic including namesApprover and actor-not-approver is completely unchanged. Section 3.3 makes an unmapped sender a refusal recorded as an audit.decision_refused with a new sender-unmapped code carrying the observed id, explicitly NOT a fallback to the configured actor, because that is today's behaviour dressed up as a feature and would still let a stranger in the chat approve as Carter. A sender mapped to two approvers is a load-time refusal; the runtime does not resolve an operator's ambiguity by picking.

Section 4 specifies the audit fields: set the channel field the base schema already defines and the grant never sets; add payload.sender and payload.sender_source, both optional and additive, so the ABSENCE of sender is itself meaningful and says the attribution came from configuration. It also says what must never be recorded: from.username, because it is mutable and reusable and a log carrying it grows a field that reads like identity and decays into a lie, and anything the sender claims about themselves, which is the self-reported-fields invariant.

Section 6 is the safe migration: phase 1 records the sender without enforcing, so the operator learns from their own log which ids have been deciding and therefore what to write in the policy; phase 2 maps and warns; phase 3 refuses, gated on a clean doctor row so nobody arrives there by accident. Rollback is removing the key at the next attestation, with no code change and no log repair, which is the argument for the mapping living in policy rather than a separate store. A deployment that never adopts it is byte-identical to today, and that is the first test in section 7.

One finding worth Carter's attention independently of this design. SPEC.md section 10.3 at line 460 describes Telegram as callback verified against approver identity. That is not what the code does: the callback is verified against a configured chat id and no approver identity is read from it. SPEC 11 line 549 and SPEC 5.2 line 137 are both precise and correct, so this is a local imprecision rather than a contradiction of the model, but it is exactly the sentence a reader would rely on. It should be corrected whether or not the rest of this design is ever built, and it is item 1 of the required changes. No SPEC edit was made by this lane.

AC2 NOT checked, and this is a judgement call worth stating rather than burying. The criterion reads: implementation tests cover two distinct senders, missing or stale mapping, spoofed request fields, unauthorized sender and concurrent decisions BEFORE changing production attribution. Read as written, it is a gate on the implementation phase and not on a design: with no resolution code in the tree there is nothing for those tests to exercise, and tests written against a stub would be evidence about the stub. Writing them anyway and checking the criterion would be checking an acceptance criterion on code presence rather than on verified behaviour, which the finalization guide forbids and which this repository exists to make expensive.

So the five cases are enumerated in full instead, as section 7 of the design, as the implementation task's specification: nineteen numbered tests grouped as compatibility (the byte-identical regression for a policy with no senders), two distinct senders (different actors and matching payload.sender on separate action keys, the second sender refused already-decided on one key, a mapped sender the class does not name refused actor-not-approver), missing or stale mapping (an unmapped id refused with the observed id recorded, a mapping removed between request and tap refused rather than honoured under the old one, an ambiguous mapping refused at load so everything resolves manual), spoofed request fields (a body claiming a different id ignored in favour of from.id, a username matching another approver's id changing nothing, a web post carrying a sender field ignored entirely because that channel can authenticate nobody, and a foreign chat still rejected by the chat check that runs first, because the mapping widens who may decide and never where from), unauthorized sender, and concurrent decisions (two senders racing one action key producing exactly one grant and one token with the loser getting a re-derived already-decided, two senders on two keys both landing, and a resolution racing a re-attestation either using the policy it verified or refusing policy-drift). Every one is specified to be built through the real append path.

AC2 closes when the implementation task runs them green. AC3 checked: the task references issue #137, the issue stays open because the design is not the behaviour it asks for, and the design states exactly what each channel can authenticate, as a table in section 2 with the recommendation that the table belongs in SPEC section 10.3 rather than only in design/. Adding a comment to the issue itself is a network write and a gated action, so it is left to the human.

Task stays In Progress on AC2.

Delivered in pull request #414 (lane/closeouts).
<!-- SECTION:NOTES:END -->
