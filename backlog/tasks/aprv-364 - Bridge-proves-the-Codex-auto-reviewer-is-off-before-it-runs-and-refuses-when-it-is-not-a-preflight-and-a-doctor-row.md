---
id: APRV-364
title: >-
  Bridge proves the Codex auto-reviewer is off before it runs, and refuses when
  it is not: a preflight and a doctor row
status: To Do
assignee: []
created_date: '2026-09-18 01:30'
updated_date: '2026-09-19 13:50'
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
- [ ] #1 Bridge start refuses with a distinct code when the auto-reviewer cannot be shown off
- [ ] #2 An autoApprovalReview notification during a session appends an audit record and ends the bridge session
- [ ] #3 approval doctor shows a codex-auto-reviewer row with pass, fail or skip and a fix
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
0. (From the APRV-366 ruling, before the auto-reviewer work) The preflight probe: when the server reports no effective approval policy, run one harmless probe command through a preflight turn and require its approval request to arrive before any real turn starts. No request means the session is not under untrusted whatever the server says: stop under bridge-approval-policy-mismatch. Carry the result in the thread record as an observed confirmation rather than as a bare true, so a reader can tell an echo from an observation. The same probe turn is what establishes the auto-reviewer fact this task is about, so build them together.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
RULING CARRIED IN FROM APRV-366 (orchestrator, 2026-09-19), to be implemented HERE and deliberately not in APRV-367.

APRV-366 landed the approval-policy pin with a looser reading than the orchestrator wants to keep: a server that reports NO effective approval policy is run against, and the report records thread.confirmed false. That is honest but weak, and the orchestrator ruled it should be closed by OBSERVATION rather than by an echo, in this task, because this task is already "prove a fact before the run".

WHAT TO BUILD, in the orchestrator words: extend the preflight so that when the server reports no effective policy, the bridge issues ONE HARMLESS PROBE COMMAND (true, or an equivalent the server will accept, chosen for having no effect) and requires an approval request for it to arrive before any real turn runs. If the probe executes without asking, stop under bridge-approval-policy-mismatch, because a policy under which one command did not ask is not untrusted whatever the server says. The report thread.confirmed then becomes confirmed "observed" (or true with a source) rather than false.

WHY IT BELONGS HERE. The same preflight turn can carry both proofs: the auto-reviewer question this task exists for is also answered by watching what happens to a probe command (a reviewer that resolves it means no request reaches the client), so one probe turn establishes both facts and neither needs its own round trip.

WHERE THE CODE IS. src/cli/codex-bridge.ts after APRV-366: the pin, the stop codes (BRIDGE_STOP_CODES) and the thread record (BridgeThreadRecord, with requested, effective and confirmed) are already there, and effectiveApprovalPolicy reads the named locations. The confirmed field is the one to widen from a boolean to a source. tests/fixtures/codex-app-server-stub.mjs already takes APPROVAL_STUB_THREAD_ERROR, _RESULT and _STARTED; a probe case needs a stub mode that EXECUTES a command without asking.
<!-- SECTION:NOTES:END -->
