---
id: APRV-303
title: A granted Edit-tool completion does not clear the loop-escalation floor
status: To Do
assignee: []
created_date: '2026-09-07 23:36'
labels:
  - harness
dependencies: []
ordinal: 223000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On 2026-09-07, with session hook:e39a116c-09c5-4950-8958-1ae0a4de9c24 at four consecutive failed side-effecting tool calls, the human granted a policy.edit.spec Edit-tool request, the edit ran and completed, and the floor still read four failures on the next Bash call (npm run build was routed to the phone as loop-escalated). Eight further Edit-tool calls on the same file were then allowed without routing, so the floor's counting and routing disagree across tool kinds. APRV-287 fixed the shell case via spent_by_task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Reproduce in tests/cli-hook.test.ts through the real append path: floor tripped, an Edit/Write tool request granted and its completion reported, and the floor is clear for the next Bash call.
- [ ] #2 Identify why Edit-tool calls were allowed under the standing floor (whether the floor predicate is skipped on the Edit path, or the completion was attributed to a different scope) and make the floor predicate identical for every tool kind, as SPEC §10.2 (APRV-297 text) requires.
- [ ] #3 Implementation notes say which it was.
<!-- AC:END -->
