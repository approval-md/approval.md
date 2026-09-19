---
id: APRV-355
title: >-
  Audit event for a refused gesture that is not a decision, so an unmapped
  checkpoint or review tap leaves a record
status: In Progress
assignee:
  - '@claude'
created_date: '2026-09-17 20:09'
updated_date: '2026-09-19 10:56'
labels:
  - audit
  - schema
  - channels
dependencies: []
priority: low
ordinal: 272000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found while landing APRV-324 (PR #427, 2026-09-17). When the policy maps Telegram senders, an unmapped or unattested-policy tap on a CHECKPOINT signature or a REVIEW is refused and records nothing: the only refusal record today, audit.decision_refused, requires a record-level action_key and a payload.decision of grant, reject or revoke, and a signature or review gesture has neither, so writing one would mean manufacturing both (Lane D declined to, correctly). The cost is that attention spent and an attempt made by an account the operator did not map leave no trace in the log, only a terminal line and a chat answer. Add an audit event type for a refused gesture that is not a decision (name to settle, for example audit.gesture_refused) carrying the gesture kind (checkpoint-signature, review, review-note), the refusal code, the channel, the observed payload.sender, and a human actor only when one was resolved, on the same conditional terms audit.decision_refused uses since APRV-324. It authorizes nothing and no enforcement path reads it. Carter approved filing on 2026-09-18. Related: APRV-324, APRV-235 (audit.decision_refused), APRV-257 (checkpoint tap), APRV-299 (reviews).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A new audit event type for a refused non-decision gesture is defined in schema/event.schema.json and SPEC 8, validated at the write boundary, with the gesture kind and refusal code closed enums, payload.sender optional, and actor required only when no sender is present
- [x] #2 An unmapped, ambiguous or unattested-policy checkpoint tap and review tap each append exactly one such record and nothing else; a no-mapping policy appends none; tests run through the real append path and the mock Telegram server
- [ ] #3 No enforcement path reads the record (a test or a module-graph assertion pins that), approval audit or approval status can list them, and docs/cli-reference.md describes the record
- [x] #4 Conformance vectors cover the new event; build, typecheck, lint and the channel and schema suites pass; the SPEC amendment is called out
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read the two gesture sites: checkpointHandlerFor and reviewHandlerFor in src/cli/channel-telegram.ts, both refused by senderIdentityFor before any verb runs, both recording nothing today. The closed refusal set reaching them is exactly three codes: sender-unmapped and sender-ambiguous from actorForSender, and policy-not-attested from attestationRefusal (and from the unreadable-log branch, which hard-codes it).
2. schema/event.schema.json: add audit.gesture_refused to the event enum and an if/then block modelled on audit.decision_refused. Required: a system: actor (the runtime states what the runtime did; neither party to the refusal authors the record), a channel, and a payload carrying gesture (closed enum: checkpoint-signature, review, review-note) and code (closed enum: the three above) and message. Optional payload.sender (channel plus id) and sender_source. payload.actor is ^human: and required only when no sender is present, the same conditional rule APRV-324 gave audit.decision_refused. No action_key and no decision: a signature and a review have neither, and manufacturing them is what Lane D correctly declined to do.
3. src/core/log.ts: add the type to the union and to the header count.
4. New src/core/gesture-refusal.ts, modelled on decision-refusal.ts: recordRefusedGesture(logPath, gesture, refusal, options), one append through withHeadRetry, best-effort (returns a failure, never throws), no withdrawal half because a gesture has no request to void. No attestation check, for the same reason decision-refusal has none: the write confers no authority and policy-not-attested is exactly the refusal an operator most needs remembered.
5. src/cli/channel-telegram.ts: both handlers call it on the not-ok branch of senderIdentityFor, before returning the card. review-note when the tap carried a note, review otherwise.
6. SPEC 8: ONE bullet, few lines, defining the type and saying it authorizes nothing and no enforcement path reads it. One commit, and no later commit touches it.
7. docs/cli-reference.md: describe the record where audit.decision_refused is described.
8. Conformance: a schema-validation vector for a valid record and for the two invalid shapes (no actor and no sender; an unknown gesture kind).
9. Tests: tests/gesture-refusal.test.ts through the real append path (one record and nothing else for each of the two gesture kinds and each refusal code; a no-mapping policy appends none), a module-graph assertion that no enforcement path reads the type, and the channel suite through the mock Telegram server.
10. build, typecheck, lint, conformance, the channel and schema suites.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
APRV-355 implemented, with ONE acceptance criterion deliberately left open. See the AC3 paragraph.

WHAT LANDED

- SCHEMA CHANGE, called out in the PR body: audit.gesture_refused joins the closed event enum (now thirty-three types) with two new allOf branches in schema/event.schema.json. Required: a ^system: actor, a channel, and payload.gesture plus payload.code, both closed enums. payload.sender is optional and payload.actor is ^human: and required exactly when no sender is present, which is the conditional APRV-324 gave audit.decision_refused. Five schema fixtures (two valid, three invalid) and 379/379 conformance, up from 374 with 3 new negative controls.
- SPEC.md 8 gains ONE bullet defining the type, in one commit, and no later commit touches it. It states the audit-tier terms, the system: actor rule, the conditional actor-or-sender rule, and that no enforcement path reads it.
- New src/core/gesture-refusal.ts, modelled on decision-refusal.ts: one append through withHeadRetry, best-effort, no withdrawal half because a gesture has no request to void, and no attestation check for the same reason decision-refusal has none.
- src/cli/channel-telegram.ts records one on the refused branch of both gesture handlers. review-note when the tap carried words, review otherwise.
- docs/cli-reference.md describes the record under channel telegram listen, with the JSON shape.

DECISIONS

1. Three gesture kinds, not two. review and review-note are separate members because a note is attention spent WRITING rather than tapping, and an operator reading this record to decide whether to map an account wants to know which they lost. The task named all three.
2. The code enum is exactly three: sender-unmapped and sender-ambiguous from CHANNEL_DECISION_REFUSAL_CODES, and policy-not-attested from ATTESTATION_REFUSAL. attest-requires-terminal is NOT here: it belongs to an attestation tap, which is a decision and is recorded as one.
3. No action_key and no decision on the record. That is the whole reason the type exists; Lane D was right to refuse to manufacture them.
4. A code outside the enum appends NOTHING rather than widening the union from inside a best-effort path. Same for a non-human actor and for a gesture with neither a person nor an account.
5. The record never carries the listener configured identity on a sender refusal. The runtime cannot name a person there, which is what the refusal means, and writing the operator name would be the false record the whole family avoids.

SECTION 11 INVARIANTS TOUCHED: invariant 6 (refusals machine-readable and distinct) is extended rather than weakened, by giving a refusal that had no record one of its own with its own closed codes. Invariant 4 holds: the sender is the transport own attribution and the record only ADDS to what a reviewer sees. The write boundary validates it like everything else, and the gate-typed clock rule is unchanged (no ts parameter exists).

AC3 IS NOT TICKED, and the reason is scope rather than difficulty. Two of its three clauses are done: a module-graph test reads ten enforcement modules and asserts none of them names the type or imports the writer, and docs/cli-reference.md describes the record. The third, "approval audit or approval status can list them", is a NEW SURFACE: neither verb lists audit.decision_refused today either, so adding a listing for this type alone would be inconsistent with the record it is modelled on. approval log tail and approval log export show it now, like every other record. Two options for whoever rules: (a) add a refused-gesture count to approval status informational fields and list both refusal families there, which is the consistent version and is its own small task; (b) leave listing to log tail and reword the criterion. This lane did not choose.
<!-- SECTION:NOTES:END -->
