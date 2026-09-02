---
id: APRV-235
title: >-
  A refused human decision leaves no trace: record it as an audit event,
  withdraw a policy-drift-void request, and tell the tapper on the channel
status: To Do
assignee: []
created_date: '2026-09-02 20:26'
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
