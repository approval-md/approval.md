---
id: APRV-410
title: >-
  Hook: a decision that arrives after the retry grace is recorded as a grant on
  a request nobody holds, and the promised approval.withdrawn never lands
status: To Do
assignee: []
created_date: '2026-09-20 19:06'
labels:
  - hook
  - log
  - bug
dependencies: []
documentation:
  - src/cli/hook.ts
  - docs/claude-code-hook.md
priority: high
ordinal: 317000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-20 on the request in the sibling classifier task. Timeline from the log: approval.requested seq 64338 at 18:43:37; the hook nine-minute wait expired at 18:52:37 and the tool call was denied with the message that the request stays open for the five-minute retry grace and that past the grace the hook takes the question back with approval.withdrawn reason timeout; no approval.withdrawn was ever appended; Carter tapped approve on the phone at 19:03:32 and approval.granted seq 64473 was recorded, six minutes past the grace, on a request no hook process was waiting for. The session had already retried the command in a different form, so the grant authorized nothing that ran, but the record now shows a human grant for a policy.edit.ci action with no execution and no withdrawal, and a retry of that exact command in that directory may or may not adopt it (the deny text says it asks again; whether the Telegram grant on the stale question is then consumed, ignored, or dangling is the thing to pin). Questions the plan must answer from the code in src/cli/hook.ts around the retry-grace handling: who appends the withdrawal after the grace when the hook process has exited (the deny is the process end, so the withdrawal needs the daemon or the next hook invocation to do it); whether the channel should refuse or mark a decision on a request past its grace; and what the phone shows for a question that expired, since Carter saw and answered it. Invariant touched: every check-then-append passes through compare-and-append, and refusals are machine-readable and distinct (SPEC 11), so a late decision should produce a distinct refused or expired record rather than a plain grant.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After the retry grace elapses with no decision, an approval.withdrawn with reason timeout is appended for the request by a named actor (daemon or next hook run), and a test proves it without a live phone
- [ ] #2 A channel decision arriving on a withdrawn or past-grace request is recorded as a distinct machine-readable refusal (or the existing audit.decision_refused with a new code), never as approval.granted, and the sender is told the question expired
- [ ] #3 The hook deny text and docs/claude-code-hook.md describe the actual sequence, including who withdraws
- [ ] #4 Log seq 64473 is left as it is (the log is append-only) and the task notes explain what it means
<!-- AC:END -->
