---
id: APRV-364
title: >-
  Bridge proves the Codex auto-reviewer is off before it runs, and refuses when
  it is not: a preflight and a doctor row
status: To Do
assignee:
  - '@claude'
created_date: '2026-09-18 01:30'
updated_date: '2026-09-19 15:10'
labels:
  - codex
  - bridge
  - doctor
dependencies:
  - APRV-361
priority: high
ordinal: 281000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From docs/codex-app-server-bridge.md follow-up 4 (APRV-349). A server-side auto-reviewer (guardian) runs before the client path and can resolve an approval with a model call, telling the client afterwards through item/autoApprovalReview notifications. Zero were observed on 2026-09-18 under the operator configuration, which says nothing about other configurations. A session with a reviewer in front of the gate is one whose silence means nothing, so the bridge preflight must establish it is off (from the effective configuration the app-server exposes, or by a probe turn) and refuse to run otherwise, and approval doctor gains a row reporting the same fact while a bridge is live. Any autoApprovalReview notification seen mid-session is recorded as an audit event and stops the bridge.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Bridge start refuses with a distinct code when the auto-reviewer cannot be shown off, and, when the server reports no effective approval policy, one harmless probe command must produce an approval request before any real turn runs (the APRV-366 residual, orchestrator ruling 2026-09-19): no request means the session is not under untrusted whatever the server says, and it stops under bridge-approval-policy-mismatch with the thread record naming the confirmation as observed rather than merely requested
- [ ] #2 An autoApprovalReview notification during a session stops the run under its own code and is reported; the audit RECORD for it is APRV-378, split out on the orchestrator ruling of 2026-09-19 because it needs a new event type, a schema change and a SPEC section 8 amendment
- [ ] #3 The doctor row is NOT here: moved to APRV-378 on the orchestrator ruling of 2026-09-19, as an added acceptance criterion there, because the row's only durable input is the audit record 378 creates. A row built in this task would always skip and would be rewritten the moment 378 landed
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
0. THE PREFLIGHT TURN (carries both proofs). After thread/start and the pin check, and BEFORE the real turn, run one preflight turn whose prompt asks for a single harmless command. Watch that turn and classify what happens to it. Only then start the real turn.

1. THE PROBE REQUEST DOES NOT GO THROUGH THE GATE. An approval request whose turnId is the preflight turn is answered decline immediately, as an observation, and never reaches decideHarnessCall. Routing it through the gate would register an action and could put the probe command on a human phone at every bridge start, which is the opposite of harmless. The turnId from the preflight turn/start is what distinguishes it.

2. WIDEN BridgeThreadRecord.confirmed from a boolean to a source: unconfirmed, reported (a frame echoed the pinned policy) or observed (a probe command produced an approval request that reached this client). The existing APRV-366 tests assert the boolean and move with it.

3. ONE NEW STOP CODE, bridge-auto-reviewer-active, for an item/autoApprovalReview notification in either turn. It covers AC1 (the reviewer cannot be shown off) and AC2 (a notification mid-session) because both are the same observation. A probe that runs without asking and without such a notification stops under bridge-approval-policy-mismatch per the APRV-366 ruling, and the detail says the two causes are indistinguishable from here.

4. STUB MODES for the three probe outcomes, beside the existing THREAD_ERROR, THREAD_RESULT and THREAD_STARTED knobs.

5. Tests, docs, and the honesty line: the report says confirmed by observation of one probe command, never that the auto-reviewer is off.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
RULING CARRIED IN FROM APRV-366 (orchestrator, 2026-09-19), to be implemented HERE and deliberately not in APRV-367.

APRV-366 landed the approval-policy pin with a looser reading than the orchestrator wants to keep: a server that reports NO effective approval policy is run against, and the report records thread.confirmed false. That is honest but weak, and the orchestrator ruled it should be closed by OBSERVATION rather than by an echo, in this task, because this task is already "prove a fact before the run".

WHAT TO BUILD, in the orchestrator words: extend the preflight so that when the server reports no effective policy, the bridge issues ONE HARMLESS PROBE COMMAND (true, or an equivalent the server will accept, chosen for having no effect) and requires an approval request for it to arrive before any real turn runs. If the probe executes without asking, stop under bridge-approval-policy-mismatch, because a policy under which one command did not ask is not untrusted whatever the server says. The report thread.confirmed then becomes confirmed "observed" (or true with a source) rather than false.

WHY IT BELONGS HERE. The same preflight turn can carry both proofs: the auto-reviewer question this task exists for is also answered by watching what happens to a probe command (a reviewer that resolves it means no request reaches the client), so one probe turn establishes both facts and neither needs its own round trip.

WHERE THE CODE IS. src/cli/codex-bridge.ts after APRV-366: the pin, the stop codes (BRIDGE_STOP_CODES) and the thread record (BridgeThreadRecord, with requested, effective and confirmed) are already there, and effectiveApprovalPolicy reads the named locations. The confirmed field is the one to widen from a boolean to a source. tests/fixtures/codex-app-server-stub.mjs already takes APPROVAL_STUB_THREAD_ERROR, _RESULT and _STARTED; a probe case needs a stub mode that EXECUTES a command without asking.

NOT STARTED as code by lane 4 (2026-09-19). It is escalated rather than begun, for one reason, and the plan and the probe ruling above are ready for whoever takes it.

THE RULING NEEDED, on AC2. "An autoApprovalReview notification during a session appends an audit record" has no event type to append. The schema enum (schema/event.schema.json, the closed set of thirty-three) carries no event this fits: audit.dark_session is the sweep, audit.decision_refused is a human gesture the gate would not take, audit.gesture_refused (APRV-355) is a gesture that is not a decision at all. An auto-reviewer answering a question before this client saw it is none of those.

So AC2 costs a NEW EVENT TYPE, and that is a schema change plus a SPEC section 8 amendment, which is a protected-path edit with the records advance and the orchestrator ceremony around it. CLAUDE.md also says schema changes are their own tasks. The options, in the order this lane would rank them:

(a) SPLIT. This task keeps the preflight (AC1, the probe ruling above) and the doctor row (AC3), and the audit event becomes its own task with the schema change and the SPEC section 8 row, blocked on nobody. Cheapest to review, and it is the shape CLAUDE.md asks for. The cost: between the two, a session that sees an auto-reviewer notification STOPS (which AC2 half wants) and the log carries no trace of why, so the fact lives only in the verb exit and its report.

(b) ONE TASK, one protected-path commit. Add audit.auto_review_seen (or the name the spec review prefers) to the enum and to SPEC section 8, in a single small edit, and land the preflight, the doctor row and the record together. The reviewable unit is bigger and the branch needs the records advance before its guard passes, but the behaviour arrives whole.

(c) NARROW AC2. Reuse no event, record nothing, and let the notification stop the session with a distinct code and a report line only. Cheapest of all and the least honest: the thing the gate most wants recorded is the moment something else answered a question it exists to ask, and a claim with no record behind it is the shape of claim this project is built against.

This lane did not choose. Nothing about the choice is visible in the code yet, and the plan above stands under any of them.

RULED 2026-09-19 by the orchestrator: option (a), SPLIT. This task keeps AC1 (the preflight, including the probe ruling recorded above) and AC3 (the doctor row). AC2 is reworded: the notification stops the run under its own code and is reported here, and the audit RECORD is APRV-378, filed in the shape of APRV-355 (one event type, schema enum, fixtures, conformance negatives, one SPEC section 8 bullet in one commit, with a records advance at push). The cost of the split is stated rather than hidden: between the two landing, a session that sees an auto-reviewer notification stops and the log carries no trace of why.

Also ruled: keep the doctor row in this task unless the diff gets long, and say so before splitting it.

RULED 2026-09-19 by the orchestrator, on this lane question: option (a), and NO NEW TASK. The doctor row moves into APRV-378 as an added acceptance criterion there, and AC3 here is reworded to point at it.

THE REASON, recorded because it is not diff length. The doctor row has no durable fact to read. The observed method vocabulary in docs/codex-app-server-bridge.md question 3 contains no frame in which the server reports its auto-reviewer configuration: whether the reviewer runs is config-gated in the Codex source, and the client is only told after the fact through an item/autoApprovalReview notification. So there is nothing for a preflight to READ, which is exactly why the probe turn is the only way to establish the fact and why step 0 and AC1 fold together. approval doctor cannot run a probe turn, because that means starting a billable Codex session. The only other local source is the gating key in the operator own Codex configuration file, whose NAME is recorded nowhere in this repository, and a config read written against a guessed key silently finds nothing and reports a GREEN row, which is the APRV-379 trap with the worst possible failure direction. The only durable in-repo record of something else having answered is the audit event APRV-378 creates.

THE HONESTY LINE, ruled and to be held in the code and the report: a probe that gets asked proves that ONE question reached this client unanswered by anything else. It does not prove the auto-reviewer is off for every question. The thread record says confirmed by observation of one probe command, never that the auto-reviewer is off.

OPEN DESIGN QUESTION, raised by lane 5 (2026-09-19) while writing the plan above. The rulings on this task do not cover it, and it decides whether the preflight is trustworthy or flaky.

THE PROBE HAS THREE OUTCOMES, NOT TWO. The ruling names two (a request arrives, or the command runs without asking). There is a third, and it is the likely one: the preflight turn is driven by a PROMPT, so the model may simply not run any command at all. Then no approval request arrives AND no command executes, and those two facts together are indistinguishable from a model that chose to answer in prose.

WHY IT MATTERS. Treating no-request as the mismatch stop would stop a healthy session every time the model declined to run the probe. Treating it as a pass would report an observation nobody made, which is the APRV-359 lesson exactly (a probe that reports a verdict it did not establish is worse than no probe). So the bridge must be able to tell RAN-WITHOUT-ASKING from NEVER-RAN, and the only signals for that are the commandExecution item notifications (item/started and item/completed for a command item), which the 2026-09-18 vocabulary does record.

THE OPTIONS.
(a) THREE OUTCOMES, VOID STOPS. ASKED passes, a commandExecution item that completed with no approval request for that turn stops under bridge-approval-policy-mismatch, and a turn where no command item appeared at all is VOID and also stops, under its own code, because the fact AC1 requires could not be established. Strictest, fail-closed, and it makes every bridge start depend on a model complying with a prompt.
(b) THREE OUTCOMES, VOID PROCEEDS UNCONFIRMED. Same first two, but VOID leaves confirmed at unconfirmed and the session runs, exactly as APRV-366 landed for a server that echoes nothing. Honest about what was established, and it means the preflight can silently establish nothing on a bad day.
(c) RETRY THE PROBE a bounded number of times before deciding VOID, which narrows the flakiness at the cost of more turns per start.

LANE 5 DID NOT CHOOSE, and did not write code for the preflight. What exists on the branch so far is the APRV-380 filing and these notes. The plan above stands under all three; only the VOID arm differs.

A SECOND, SMALLER QUESTION in the same area: the ruling says run the probe WHEN THE SERVER REPORTS NO EFFECTIVE POLICY, but the auto-reviewer fact AC1 wants is independent of the policy echo and needs the probe even when the server did echo. Lane 5 planned to run the probe ALWAYS for that reason, which costs one extra turn on every bridge start. Confirm or narrow.
<!-- SECTION:NOTES:END -->
