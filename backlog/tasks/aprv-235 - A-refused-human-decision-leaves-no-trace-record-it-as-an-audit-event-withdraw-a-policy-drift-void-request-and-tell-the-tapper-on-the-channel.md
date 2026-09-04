---
id: APRV-235
title: >-
  A refused human decision leaves no trace: record it as an audit event,
  withdraw a policy-drift-void request, and tell the tapper on the channel
status: In Progress
assignee:
  - 'agent:opus-lane-l'
created_date: '2026-09-02 20:26'
updated_date: '2026-09-04 22:56'
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
