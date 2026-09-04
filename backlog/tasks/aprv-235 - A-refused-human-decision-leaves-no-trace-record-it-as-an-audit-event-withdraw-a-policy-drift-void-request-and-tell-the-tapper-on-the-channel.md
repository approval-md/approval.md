---
id: APRV-235
title: >-
  A refused human decision leaves no trace: record it as an audit event,
  withdraw a policy-drift-void request, and tell the tapper on the channel
status: In Progress
assignee:
  - 'agent:opus-lane-l'
created_date: '2026-09-02 20:26'
updated_date: '2026-09-04 23:19'
labels:
  - channels
  - log
  - dogfood
dependencies: []
priority: high
ordinal: 190000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Seen 2026-09-02 after the seq 13704 ceremony: Carter tapped approve on a request asked under the previous policy; the listener refused with policy-drift (correct: the rules the approver was shown are no longer in force) and printed the reason to the approval up terminal. Nothing was appended, the request stayed pending in QUEUE.md and on Telegram, and the human saw no reaction to the tap. Three gaps. (1) The log is the truth, and a human's decision is a fact even when the gate cannot honour it: append an audit-tier record (proposed audit.decision_refused: actor, action key, channel, refusal code, the policy hash the request carried and the attested hash now) that grants nothing and changes no verdict, so a later reader can explain an unanswered request. (2) A request the gate itself declares void (policy-drift) must be withdrawn (approval.withdrawn, APRV-106) so the queue, QUEUE.md and the channels stop offering it; the action is re-requested by its caller under the current policy, as the refusal already says. (3) The channel tells the tapper: the Telegram message is edited to a terminal state naming the refusal in one line (like the other terminal states from APRV-113), and the CLI channel prints it. SPEC: section 5.2 says refused and logged while the runtime appends nothing on refusal (also flagged under APRV-173); this task records HUMAN decisions that were refused and leaves gate-side refusals to agents unlogged, and the notes must state the choice for sign-off. Invariants touched: refusals machine-readable and distinct (unchanged codes), gate-typed events never accept caller timestamps, the new record moves no verdict, budget or sampling.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A refused human decision on any channel appends one audit-tier record carrying actor, action key, channel and refusal code, proven through the real append path; a test asserts it changes no request state, budget or sampling outcome
- [ ] #2 A policy-drift refusal also appends approval.withdrawn for the void request, and approval queue, QUEUE.md and the Telegram listener no longer show it
- [ ] #3 The Telegram message that was tapped is edited to a terminal state naming the refusal, buttons disarmed; the CLI channel prints the same line
- [ ] #4 The event schema for the new record validates at the write boundary; conformance vectors regenerated per the documented ritual
- [ ] #5 SPEC section 5.2 sentence drafted in the notes (human decisions refused are logged; gate refusals to agents remain unlogged) for sign-off
- [ ] #6 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read gate.decide() policy-drift refusal, withdraw(), recordChannelDecision, cli/gate.ts commandDecide, telegram annotate/answerFor, cli channel describeOutcome, event schema audit.* + approval.withdrawn branches, conformance regen ritual.
2. Schema (schema/event.schema.json): add audit.decision_refused to the closed event enum with a per-type branch — actor MUST be ^system: (the runtime states its own refusal; the refused party does not author it), payload required with actor (the human who decided), decision, code; optional channel and the two policy hashes. Extend the approval.withdrawn branch: reason enum gains policy-drift, with a bi-directional rule — ^system: actor is admitted only with reason policy-drift, and reason policy-drift only with a ^system: actor. Expiry stays the runtime's clock-justified exit; policy-drift is its policy-hash-justified one, and the justification travels in the record.
3. src/core/log.ts: EventType union gains audit.decision_refused, with the doc paragraph the other additions carry.
4. New src/core/decision-refusal.ts: recordRefusedDecision(logPath, refusal, context, options). One read of the verified log, then append audit.decision_refused, and on code policy-drift also append approval.withdrawn (actor system:gate, reason policy-drift, note naming both hashes). Both through compare-and-append against the head read, the whole cycle wrapped in head-retry.ts's withHeadRetry. It grants nothing, mints nothing, charges nothing.
5. Wire it at the two human decision surfaces and nowhere else: recordChannelDecision (channels/contract.ts — telegram, web, cli channel all route through it) and commandDecide (cli/gate.ts). Gate-side refusals to agents stay unlogged.
6. Channels: one shared refusal line, exported from channels/contract.ts, used by telegram's answerFor (message edited to a terminal state, buttons disarmed via annotate) and by the CLI channel's describeOutcome, so both surfaces print the same sentence.
7. Fixtures: schema/fixtures/event/valid/audit-decision-refused.json and approval-withdrawn-policy-drift.json, plus invalid fixtures for the actor/reason cross-rules; tests/event-schema.test.ts gains the type and its required fields.
8. Tests: a new suite proving the audit record lands through the real append path, that request state, budgets and sampling are byte-identical before and after, that policy-drift withdraws and drops the request out of queue/QUEUE.md/telegram, and that the two channels print the same line.
9. Regen conformance vectors per the ritual (npm run build && node scripts/regen-conformance-vectors.mjs); schema-validation bumps MINOR to 1.4.0 (new fixtures, no moved expectation).
10. git fetch && git merge --no-edit origin/main, resolve keeping both intents, re-run the touched suites, then npm test and oxlint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## AC5 — draft amendment to section 5.2, for sign-off

Not applied: the spec file is a protected path in this lane, so the sentence is
drafted here and a human decides whether it lands. It states the choice the task
asked to be stated, that HUMAN decisions refused are logged and gate refusals to
AGENTS are not.

> **A refused human decision is recorded; a refused agent is only told.** When
> the gate refuses a decision made by a `human:` actor through a channel or the
> CLI, the surface that collected the gesture MUST append one audit-tier record,
> `audit.decision_refused`, naming the approver, the action key, the decision
> attempted, the channel that collected it, and the gate's refusal code verbatim.
> The record is authored by the runtime (a `system:` actor) and grants nothing:
> no verdict, budget, streak or sampling path may read it, and it MUST NOT
> settle, re-open, or otherwise move the request it names. Human attention is the
> audit budget (section 11), and an approver's answer spends it whether or not an
> authorization comes out the other end; a log holding no trace of that spend
> cannot afterwards explain why a request sat unanswered. Refusals handed to
> `agent:` actors are NOT recorded, and the asymmetry is deliberate: an agent
> reads the code, stops or asks again, and has spent nothing a record would
> account for, while recording every agent-side refusal would put the runtime's
> busiest path into the append path with no reader for the result. Where the
> refusal is `policy-drift`, which declares the REQUEST void rather than merely
> declining this decision, the surface MUST additionally append
> `approval.withdrawn` for that request, authored `system:` with the reason
> `policy-drift` — the one reason closed to requesters, as `system:` remains
> closed to the other three (section 8) — so that the queue, the queue
> projection and every channel stop offering a question no answer can settle. The
> channel that collected the gesture MUST tell the person: a push channel edits
> its delivery to a terminal state naming the refusal and disarms its decision
> affordance, a pull channel prints the same line, and the line is the same line.
> (Amended APRV-235.)

Section 8's withdrawal paragraph needs one consequential clause in the same
sign-off. Where it reads that the actor MUST NOT be `system:` and that the
reason is closed to three values, it should read:

> The actor MUST equal the actor of the matching `approval.requested`, and MUST
> NOT be `system:`, because the runtime's way of ending a request it was not
> asked to end is the TTL — with one exception, added by APRV-235 and bounded by
> its reason. The reason is recorded and closed to four values: `timeout`,
> `cancelled` and `superseded` are the requester's, and `policy-drift` is the
> runtime's. The pairing is bidirectional and MUST be enforced at the write
> boundary: `system:` is admitted only with `policy-drift`, and `policy-drift`
> only with `system:`. What justifies the exception is that the drift verdict is
> as objective as the clock the TTL exception rests on, and is IN the record: the
> policy hash the request pinned differs from the hash attested now, the gate
> already refuses every decision on such a request, and a reader re-derives the
> verdict from two hashes the log carries. A requester able to spell
> `policy-drift` would be dressing its own cancellation as the gate's verdict
> about the policy, which is why the closure runs both ways.
<!-- SECTION:NOTES:END -->
