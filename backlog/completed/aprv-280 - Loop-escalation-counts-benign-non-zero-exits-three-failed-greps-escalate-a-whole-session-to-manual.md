---
id: APRV-280
title: >-
  Loop escalation counts benign non-zero exits: three failed greps escalate a
  whole session to manual
status: Done
assignee:
  - '@opus-hook'
created_date: '2026-09-06 07:19'
updated_date: '2026-09-06 08:24'
labels:
  - hook
  - daemon
  - safety
dependencies: []
type: bug
ordinal: 206000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-06 after PR #300 wired PostToolUse reporting. An agent lane in session e39a116c ran a few shell commands that exited non-zero for ordinary reasons (grep with no match, ls on a missing path); each became execution.failed for the hook scope, three in a row met the loop-escalation rule (SPEC §10.2: three consecutive execution.failed escalate to manual regardless of policy), and from then on EVERY command from the session, including read.shell that the policy resolves autonomous, was routed to the phone. Forty-eight requests queued in an hour, all lanes stalled, and the human was asleep. The rule was written for a task retrying one failing side effect, and it is right there; for harness-scoped read commands a non-zero exit is not a failed side effect, it is the command's answer. Decide and implement: escalate only on classes that have side effects (files.write.*, vcs.*, network.*, etc.), or key the streak by the command's class rather than the session scope, or treat a non-zero exit of a read.* command as execution.completed with the exit code recorded. State the choice in SPEC §10.2 and §11.2 (loop-escalated row) marked (Amended APRV-<this>, pending sign-off), and make the hook's deny message say "loop-escalated" and what clears it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Three consecutive non-zero exits of read.* commands in one harness session do not escalate the session; a test drives the hook with PostToolUseFailure reports and asserts the next read.shell is allowed
- [x] #2 Three consecutive execution.failed on a side-effecting class still escalate, and the hook deny names loop-escalated and the clearing action
- [x] #3 SPEC §10.2 and the §11.2 loop-escalated row state the rule as implemented, marked pending sign-off
- [x] #4 approval status reports the escalated scope and what cleared it
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reproduce: the streak counts every failed harness tool call, class-blind (src/core/loop.ts toolCallOutcomes / loopEscalation), so three non-zero read.shell exits reported by PostToolUseFailure floor the whole session.
2. Decide the rule: escalate only on classes that have side effects. Predicate: a class is side-effecting unless it is exactly 'read' or starts with 'read.' (the predicate the classifier already uses for command substitutions). A tool call whose classes are ALL reads is TRANSPARENT to the streak: it neither accrues nor clears. A class the log cannot resolve counts as side-effecting (fail closed). Rejected the alternative of recording a failed read as execution.completed: a manufactured completion would CLEAR a real streak, which SPEC 11.1 invariant 4 forbids.
3. Implement in src/core/loop.ts: resolve each action key's class from the execution.started record the runtime itself wrote (payload.class), never from the report; apply the predicate in both loopEscalation (per task) and harnessLoopEscalation (session/actor).
4. Message work: gate.ts loop-escalated refusals and hook.ts unattendedGuard restate the amended rule; carry the HarnessLoopState into gateAndWait so EVERY deny of a floored invocation (timeout included) names loop-escalated, the scope key, the count and what clears it (a granted request in the scope that then completes, or the human's gate window).
5. approval status: loop_escalations rows gain a 'clears' field and the text row says what clears the streak.
6. SPEC 10.2 gains the side-effect paragraph and both 11.2 loop-escalated rows are restated, marked (Amended APRV-280, pending sign-off).
7. Tests: tests/cli-hook.test.ts (three failed read.shell tool calls do not escalate and the next read.shell is allowed; three failed files.write.workspace tool calls still escalate; the deny text), tests/execute.test.ts (per-task predicate), tests/cli-status.test.ts (the clears field).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
THE RULE (implemented): loop safety counts only executions of classes that have side effects. A class is side-effecting unless it is exactly `read` or begins with `read.` (src/core/loop.ts `isSideEffectingClass`, the same carve-out src/core/command-class.ts already uses to decide which command substitutions may run unattended). A tool call whose classes are all reads is TRANSPARENT to every streak: its failure accrues nothing and its completion clears nothing, so a failing write streak cannot be shed by a successful grep. Fail-closed is preserved twice over: the predicate is a carve-out of read.*, so an unknown class is side-effecting, and an action key whose `execution.started` the log cannot resolve a class for is side-effecting too.

REJECTED alternative: recording a non-zero exit of a read.* command as `execution.completed`. A manufactured completion would CLEAR a real streak, which is the one direction SPEC 11.1 invariant 4 forbids, and Claude Code's post-execution event carries no exit code to record anyway (docs/claude-code-hook.md).

Sec 11 invariants touched: invariant 1 (enforcement paths read only verified records) — the class is read from the `execution.started` record the RUNTIME wrote (its payload.class), never from the reporting event; invariant 4 (self-reported fields never reduce scrutiny) — the reporter still chooses the outcome and now cannot choose the bucket, and no path was added by which a report clears a streak; invariant 7 (refusals machine-readable and distinct) — the code stays `loop-escalated` and the text gained the scope key and the clearing action.

Files: src/core/loop.ts (predicate, class resolution, both projections, loopClearance), src/core/gate.ts (three loop-escalated refusals restated), src/cli/hook.ts (unattendedGuard text, floor note, and gateAndWait now takes the HarnessLoopState so EVERY deny of a floored invocation — hook-timeout included — names loop-escalated, the scope and the way out), src/cli/execute.ts (status rows gain `clears`; the text row prints it), SPEC.md (10.2 'Only side effects accrue', both 11.2 loop-escalated rows), docs/cli-reference.md.

Note for review: the streak is keyed on the CLASS, so the session scope of APRV-145 is unchanged and a session that fails three writes is still floored on its next command of any class, reads included. Escalation stays a floor rather than a ban.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Loop safety now counts only failed executions of side-effecting classes (anything outside read.*), so three non-zero greps no longer floor a whole harness session to manual. Verified: tests/cli-hook.test.ts 94/94 (three new cases: three failed read.* tool calls escalate nothing and the next read is still answered autonomous with no request opened; a successful read clears no write streak; a floored deny names loop-escalated, the scope key and what clears it), tests/execute.test.ts 35/35 (the predicate and the clearing sentence), cli-status + gate + command-class 465/465, conformance 288/288, lint and typecheck clean.
<!-- SECTION:FINAL_SUMMARY:END -->
