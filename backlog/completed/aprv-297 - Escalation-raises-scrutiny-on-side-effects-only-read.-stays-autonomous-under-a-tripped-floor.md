---
id: APRV-297
title: >-
  Escalation raises scrutiny on side effects only: read.* stays autonomous under
  a tripped floor
status: Done
assignee: []
created_date: '2026-09-07 06:04'
updated_date: '2026-09-07 06:40'
labels:
  - hook
  - daemon
dependencies: []
priority: high
ordinal: 219000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Once the loop floor tripped on 2026-09-06/07, every hook call was routed to the human, read.* included, so a session that could not get an answer could not even grep. APRV-280 made reads not COUNT toward the floor, but a tripped floor still ROUTES them. A read cannot cause the harm the floor bounds (SPEC 10.2, only side effects accrue), so routing it buys no safety and costs a nine-minute wait and a phone message per read. Carter asked on 2026-09-07 for reads to stay autonomous.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Under a tripped floor (session or actor scope) a tool call whose classes are all read.* resolves by policy, not by loop safety: no request raised, no message sent, the hook reason says the floor was not applied to a read; tests cover a tripped floor followed by a read (allowed at once) and a side-effecting call (routed)
- [x] #2 A mixed call (read.* plus a side-effecting class) is still routed as one question; the read classes inside it are neither counted nor separately raised
- [x] #3 approval status and the floor refusal text say reads are exempt from routing as well as counting; docs/claude-code-hook.md updated; CHANGELOG entry; SPEC 10.2 amendment text in the task notes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was done

The floor already knew what a read does not ACCRUE (APRV-280). This adds what a tripped floor does not ROUTE, in the two places that route and one that explains.

**src/core/loop.ts.** The clearance sentence `loopClearance` hands to `approval status`, to the gate's `loop-escalated` refusals and to the hook's denies now says reads are outside the floor in BOTH directions: it does not route them to a human, so reading and searching keep working while it stands, and a read that succeeds still clears nothing. The module header states the rule and names the two surfaces that apply it, both through `isSideEffectingClass`, so what the floor counts and what it routes cannot come apart. No projection changed: accrual is exactly as APRV-280 left it.

**src/cli/hook.ts.** `runHarnessHook` keeps the streak it read (`tripped`) separate from the floor it APPLIES: a command whose classes are all reads applies none, whatever the streak says. When a floor is standing and was not applied, the verdict's note says so in as many words, names the scope and the count, and carries the clearance sentence, so an agent reading an ordinary autonomous allow can still tell that its session is three failed writes deep. Inside `gateAndWait` the floor became per class (`floorApplies`): a mixed command raises its side-effecting classes and leaves its read classes to the policy, which is what makes AC2's one-question-per-command true at the level of what reaches a phone.

**src/core/gate.ts.** `startHarnessExecution` is the write boundary that re-checks the floor for a caller that did not ask the hook first. It carves reads out with the same predicate, so the belt and the braces agree; every other refusal there is untouched, and an unknown class is still side-effecting by construction and still refused.

## Decisions worth recording

- **The exemption is routing only.** A read clears nothing, so no session can read its way out from under a floor; a test pins that direction because it is the one that would be a hole.
- **The verdict says a floor was not applied**, rather than staying silent. Silence would leave an agent unable to distinguish a healthy session from a floored one, which is exactly the confusion the nine-minute waits created.
- **Per-class rather than per-command routing** for a mixed call. The alternative, routing the whole command including its read classes, puts two prompts on a phone for one command and asks a human a question about looking.
- **The per-TASK escalation check is untouched** in `unattendedGuard` and in `request`. On this surface a task id is minted per tool call, so that streak is structurally zero here; narrowing it would be a change to the `approval run` path, which this task did not measure and does not claim.

## Invariants touched (CLAUDE.md / SPEC §11.1)

- **4, self-reported fields never reduce scrutiny.** The one to watch, since this LOWERS scrutiny for a set of commands. Nothing an agent reports selects the set: the classes come from the runtime's own classifier over the command text, the predicate is the runtime's, and a class this build has never heard of falls on the side-effecting side by construction. An agent cannot spell a side effect so that it resolves `read.*`, and the write boundary re-derives the same answer from the log rather than trusting the hook's.
- **1, enforcement paths read only verified records.** Unchanged: the floor is still a projection over the verified log, read the same way in both surfaces.
- **6, refusals machine-readable and distinct.** No code was added, removed or repurposed. `loop-escalated` fires for exactly the same fact, over a narrower set of calls, and the registry row is amended below to say so.
- **8, no allow before its record.** Unchanged: a read allowed under a standing floor is still charged, and its `execution.started` still lands before the allow is printed.

## Tests (tests/cli-hook.test.ts)

- *a tripped floor leaves a read to the policy and still routes a write* — AC1 both halves in one case: the read is allowed at once with `autonomous: read.shell`, its reason carries the NOT APPLIED sentence, no `approval.requested` is written and the only record is the ordinary charge; the write in the same session times out on a request the floor raised. It also pins AC3's refusal text.
- *a floor routes a mixed call as one question, and raises no read class* — AC2: exactly one `approval.requested`, for `files.write.workspace`, none for `read.shell`, and the human's grant releases the command.
- *the write boundary refuses a floored write and records a floored read* — the `startHarnessExecution` half, called directly.
- *a read under a floor clears nothing, so the floor still stands* — the direction that would be a hole.
- *status reports the harness streaks by scope* gains AC3's assertions on the `clears` row.
- Three existing cases moved from a read command to a write command, because a read is no longer routed and they were pinning the routing: the APRV-280 deny-text case, the escalated-session floor case, and the actor-scope backstop.

Docs: docs/claude-code-hook.md gains **What a tripped floor routes (APRV-297)** and the APRV-287 section now points at it. CHANGELOG: one bullet.

## SPEC amendment text (apply by hand)

SPEC.md was not edited: a gate window is open and a bypassed SPEC edit cannot pass the protected-path guard.

**A. §10.2, at the end of the 'Only side effects accrue' paragraph, append:**

The same reading governs what a tripped streak ROUTES. A harness tool call whose classes are all `read.*` MUST be resolved by policy while a floor stands, exactly as it is with none: no request is opened for it, no human is notified, and the implementation MUST state in its verdict that a floor was standing and was not applied to a read. The escalation bounds the harm of an agent retrying a side effect that keeps failing, a read cannot cause that harm, so routing one adds no safety while spending the attention the floor exists to conserve; an operator whose floor has tripped MUST still be able to have the session read. A mixed tool call is routed whole, as one question about its side effects, and the read classes inside it are neither counted nor separately raised. The exemption covers routing alone: a read still clears nothing, so no session can read its way out from under a floor. An implementation that re-checks the floor at a write boundary MUST apply the identical predicate there, so what a floor counts and what it routes cannot drift apart. (Amended APRV-297, pending sign-off.)

**B. §10.2, 'The remedy stays manual on this path'.** Replace 'so an escalated session's command MUST be routed to the human gate for every class that would otherwise have proceeded, and a class that already resolves `manual` is unaffected' with:

so an escalated session's command MUST be routed to the human gate for every SIDE-EFFECTING class that would otherwise have proceeded; a class that already resolves `manual` is unaffected, and a `read.*` class is outside the floor entirely, by the paragraph above (Amended APRV-297, pending sign-off.)

**C. §11.2, `gate_refusal_codes`, the `loop-escalated` row.** Append to the row's text:

On a harness surface the floor routes the side-effecting classes of a tool call and no others, so this code does not fire for a call whose classes are all `read.*` (§10.2). (Amended APRV-297, pending sign-off.)
<!-- SECTION:NOTES:END -->
