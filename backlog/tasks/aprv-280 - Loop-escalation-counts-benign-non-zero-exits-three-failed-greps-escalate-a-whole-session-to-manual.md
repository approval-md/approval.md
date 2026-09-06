---
id: APRV-280
title: >-
  Loop escalation counts benign non-zero exits: three failed greps escalate a
  whole session to manual
status: To Do
assignee: []
created_date: '2026-09-06 07:19'
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
- [ ] #1 Three consecutive non-zero exits of read.* commands in one harness session do not escalate the session; a test drives the hook with PostToolUseFailure reports and asserts the next read.shell is allowed
- [ ] #2 Three consecutive execution.failed on a side-effecting class still escalate, and the hook deny names loop-escalated and the clearing action
- [ ] #3 SPEC §10.2 and the §11.2 loop-escalated row state the rule as implemented, marked pending sign-off
- [ ] #4 approval status reports the escalated scope and what cleared it
<!-- AC:END -->
