---
id: APRV-410
title: >-
  Hook: a decision that arrives after the retry grace is recorded as a grant on
  a request nobody holds, and the promised approval.withdrawn never lands
status: In Progress
assignee:
  - '@lane-a'
created_date: '2026-09-20 19:06'
updated_date: '2026-09-22 01:41'
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
- [x] #1 After the retry grace elapses with no decision, an approval.withdrawn with reason timeout is appended for the request by a named actor (daemon or next hook run), and a test proves it without a live phone
- [ ] #2 A channel decision arriving on a withdrawn or past-grace request is recorded as a distinct machine-readable refusal (or the existing audit.decision_refused with a new code), never as approval.granted, and the sender is told the question expired
- [x] #3 The hook deny text and docs/claude-code-hook.md describe the actual sequence, including who withdraws
- [x] #4 Log seq 64473 is left as it is (the log is append-only) and the task notes explain what it means
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Diagnosis from the code, which the description asked the plan to answer.

Q1, who withdraws after the grace when the hook process has exited. The next hook run already does, and the reason it did not here is a GAP rather than a missing mechanism. src/cli/hook.ts gateHarnessCall sweeps at intake (withdrawAbandoned over the verified records it reads, keepHash = this invocation's bytes), but gateHarnessCall is only reached by a command with a manual or supervised class. decideHarnessCall returns before it on the autonomous branch, through recordUnattended, and on every pass-through allow. The incident fits exactly: the session retried the command in a different form, the different form classified autonomously, and no later invocation ever reached the sweep. The abandonment limit is abandonedAfterMs(timeout, grace) = 9m + 5m = 14m measured from the approval.requested ts, so the retry that happened inside that window correctly swept nothing, and nothing came after it.

The daemon cannot be the actor and that is settled, not open. withdraw refuses a system: actor in as many words (core/gate.ts: the runtime's way of ending a request it was not asked to end is the TTL), and schema/event.schema.json carries a BIDIRECTIONAL cross-rule from APRV-235: system: requires reason policy-drift and policy-drift requires system:. A daemon withdrawal under reason timeout is therefore a schema change plus a SPEC amendment, which is its own task and which this lane may not make today. So the named actor is the next hook run, as itself, which is the requester.

Q2, whether the channel should refuse a decision past the grace. It should, and the RECORD half of that cannot be built today: a distinct machine-readable refusal at the decision surface means a new member of channel_decision_refusal_codes, and SPEC 11.2 is normative that every member of that union has a registry row, so it needs a SPEC edit this lane is forbidden. What CAN be built today, and matters more, is that the late grant authorizes nothing: core/gate.ts findHarnessCarry bounds a granted carry by the TTL (grantLapsed) and by nothing else, so a retry of the exact command inside the TTL WOULD have proceeded on seq 64473. That is the thing the description says to pin.

Q3, what the phone shows. Out of reach of this change for the same reason as Q2's record half, and noted rather than guessed at.

Plan.
1. Close the sweep gap. In decideHarnessCall's autonomous branch, sweep the abandoned harness questions of this actor from windowRecords, which lookupWindow has ALREADY read and verified on this invocation, so the cost is one append when there is something to take back and zero otherwise. keepHash is this invocation's own payload hash, exactly as gateHarnessCall passes it, so a sibling process waiting on these bytes is never touched. Pass-through allows are deliberately NOT swept: a pass-through has no payload hash to protect with, and keepHash null could take back a question a sibling hook is actively holding after adopting it. That residual is documented rather than closed.
2. Bound the carry. Add an optional abandonAfterMs to findHarnessCarry: a granted candidate whose DECISION landed later than requestTs + abandonAfterMs carries nothing, so the retry asks fresh. The comparison uses only log facts (the request's ts, the decision record's ts) plus the caller's own configured window, and it is strictly stricter than today. The hook passes abandonedAfterMs(run.timeoutMs, run.graceMs); every other caller passes nothing and is byte-identical.
3. Tests, no live phone. tests/hook-late-decision.test.ts: build a log through the real append path only (register, request, decide as a human, all via the CLI/core verbs), then (a) prove the second hook invocation on an autonomous command appends approval.withdrawn reason timeout for the abandoned key, (b) prove a decision landing past the window is not carried by a retry, (c) prove a decision INSIDE the window still carries, which is the control that says APRV-117 is unbroken.
4. AC3: correct the hook's timeout deny text to name who withdraws and when, and update docs/claude-code-hook.md with the actual sequence and the residual.
5. AC4: the notes explain seq 64473 and that nothing is rewritten.
6. Invariants touched, stated in the notes: SPEC 11.1 invariant 5 (every check-then-append through compare-and-append) and invariant 6 (refusals machine-readable and distinct), plus the withdrawn contract of SPEC 6.3 / APRV-106 / APRV-235.
7. Verify: build, typecheck, lint, the suites touched plus command-class cli-hook cli-hook-read-scope conformance conformance-regen hook-module-graph, then node conformance/run.mjs.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
What the code said, which is what the description asked the plan to establish.

Who appends the withdrawal after the grace: the next gated tool call of the ASKING ACTOR, and nobody else can. withdraw is requester-only (APRV-106 rule 1) and refuses a system: actor outright, in words that are themselves the design decision ('the runtime's way of ending a request it was not asked to end is the TTL, not a withdrawal'); the event schema then allows exactly one system: withdrawal and binds it bidirectionally to reason policy-drift (APRV-235). There is no spelling of a daemon withdrawal under reason timeout, so the daemon was never a candidate, and AC1's parenthetical (daemon or next hook run) resolves to the second.

Why the incident's withdrawal never happened: a GAP, not a missing mechanism. The sweep (withdrawAbandoned) sat at the intake of gateHarnessCall, which only a command carrying a manual or supervised class reaches. decideHarnessCall returns before it on the autonomous branch. The session retried in a different form, that form classified autonomously, and no later invocation ever reached a sweep. Confirmed by the arithmetic: the abandonment limit is abandonedAfterMs(9m, 5m) = 14m from the approval.requested ts, so 18:43:37 + 14m = 18:57:37, and any retry before that correctly swept nothing.

What changed.
1. src/cli/hook.ts, autonomous branch of decideHarnessCall: the sweep now runs there too, from windowRecords, which is the verified read lookupWindow ALREADY performed on this invocation. Cost is one append when there is something to take back and zero when there is not, which matters because this is the busiest path (APRV-186/188/212/217 lineage). keepHash is this invocation's own payload hash, exactly as the intake sweep passes it, so a sibling hook waiting on the same bytes is never taken back from under it.
2. src/core/gate.ts, findHarnessCarry: a new OPT-IN bound, questionAbandoned. A granted candidate whose decision timestamp is later than its request timestamp plus the caller's abandonment window carries nothing, so a retry past the grace asks again instead of proceeding on a tap nobody was holding. Two runtime-assigned log facts and nothing self-reported; the window comes from the CALLER's configuration, not from anything the requester said, so a false claim cannot widen it. Callers that pass nothing are byte-identical to before. The hook passes abandonedAfterMs(run.timeoutMs, run.graceMs).
3. The hook-timeout deny text and the HOOK_DENY_CODES doc comment now name the subject: the next gated tool call of this actor, why nobody else may, and that a decision landing past the grace is recorded as a grant that authorizes nothing.
4. docs/claude-code-hook.md gains 'Who withdraws, and what happens when nobody does (APRV-410)' and the hook-timeout table row is corrected. The old paragraph said 'any later invocation of the same actor sweeps', which was confident and not true for autonomous ones.

Deliberately NOT swept: a pass-through allow (a read the policy does not gate, or the approval CLI itself). It holds no payload hash of its own, so it would have to sweep with keepHash null, and that could take back a question a sibling hook process had adopted and was actively waiting on. Documented as a residual rather than closed.

AC4, what log seq 64473 means and why it stays. It is a human grant on a harness request whose asker had been gone for six minutes: approval.requested seq 64338 at 18:43:37, the hook's wait out at 18:52:37, the grace out at 18:57:37, the tap at 19:03:32. It is a true record of a true event, the log is append-only, and nothing in this change touches it or any record. What it means AFTER this change is narrower than what it meant before: the grant is still a grant, and it is no longer carryable, so a retry of that exact command in that directory asks again rather than adopting it. The open question the description raised (consumed, ignored, or dangling) is now answered: ignored, by the bound in findHarnessCarry, and pinned by tests at both the gate and the CLI level.

AC2 is NOT met and is left unchecked. Its withdrawn half already held before this task (the gate refuses request-withdrawn and refusedDecisionLine says 'Withdrawn ... nothing was recorded'). Its PAST-GRACE half needs a distinct machine-readable refusal at the decision surface, which means a new member of channel_decision_refusal_codes; SPEC 11.2 is normative that the registry covers that union and that every member carries a row stating its condition, and 11.1 invariant 6 freezes the unions with a MAJOR conformance bump for a longer array. That is a SPEC.md edit, which this lane was instructed not to make today. Underneath it sits a second blocker worth a task of its own: the decision surface cannot currently know a request is past its grace, because the hook declares no wait_until (deliberately, APRV-106) and records no window, so a channel would be judging another process's window by its own defaults and would guess wrong in the LOOSENING direction whenever a hook ran with a shorter --retry-grace. Recording the window is a payload field and therefore a schema change, which is its own task too. Both are written up in the journal (approval journal read, 2026-09-22, agent:lane-a) and named in docs/claude-code-hook.md so nobody reads the doc and concludes the refusal exists.

Invariants touched, per CLAUDE.md's rule that a task touching one says so.
SPEC 11.1 invariant 5, every check-then-append passes through compare-and-append. The new sweep reads windowRecords (a read made earlier in this invocation) and then calls withdraw, which performs its OWN fresh read and its own compare-and-append against that head (attemptWithdraw, withHeadMovedRetry). So the decision-relevant state is re-read inside the atomic unit and a stale windowRecords can only name a key that withdraw then refuses already-decided, which the existing sweep swallows in silence. Nothing appends on a state read outside its own head check.
SPEC 11.1 invariant 6, refusals machine-readable and distinct. No union gained or lost a member, so nothing frozen moved. This is worth stating as a NEGATIVE result rather than a non-event: AC2 is the part of the task that WOULD have added a member, and it is the part left open.
The withdrawn contract, SPEC 6.3 / APRV-106 / APRV-235. Unchanged, and the change leans on it rather than bending it: the actor stays the requester, the reason stays timeout, the system: author stays bound to policy-drift alone, and the test asserts that a system: withdrawal under reason timeout has no spelling the runtime will accept.
SPEC 11.1 invariant 4, self-reported fields never reduce scrutiny. Untouched, and checked deliberately: the new bound reads two runtime-assigned timestamps and one caller-side configuration value, and the requester declares nothing that enters it.

Verification, all from this worktree at the commit this note rides.
npm run build: exit 0, no output. npm run typecheck: exit 0, no output. npx oxlint src tests: exit 0, no warnings.
node scripts/run-tests.mjs --only gate command-class command-class-quoting command-class-routing cli-hook cli-hook-read-scope conformance conformance-regen hook-module-graph: tests 878, pass 878, fail 0, cancelled 0, skipped 0, todo 0, exit 0.
The six new APRV-410 cases in tests/cli-hook.test.ts alone: 6 pass, 0 fail. The two new findHarnessCarry cases in tests/gate.test.ts, run with the three that were already there: 5 pass, 0 fail.
node conformance/run.mjs: totals vectors 471, passed 471, failed 0, controls 176, manifest ok true. No vector moved and no suite version changed, which is the expected result: findHarnessCarry's new bound is opt-in and the conformance harness passes no window, so every gate-verdicts expectation is byte-identical.

Terminal status withheld. Acceptance criteria 1, 3 and 4 are checked with the evidence above; 2 is not met and the task stays In Progress for it rather than being marked Done with an open criterion. The merge is NOT armed: the gate daemon is down today, so gh pr merge was not run and no auto-merge was set.

Re-verified AFTER rebasing onto main at 534ea8e, which had moved 17 commits (APRV-398/401/415 and the hosted findings) and touched the same three source files plus the same test files and the conformance vectors. The rebase was clean, and node scripts/regen-conformance-vectors.mjs reproduces the committed vectors byte for byte on the new base.
npm run build, npm run typecheck, npx oxlint src tests: each exit 0, no warnings.
node scripts/run-tests.mjs --only gate command-class command-class-quoting command-class-routing cli-hook cli-hook-read-scope cli-hook-hermes conformance conformance-regen hook-module-graph: tests 916, pass 916, fail 0, cancelled 0, skipped 0, todo 0, exit 0. (878 on the pre-rebase base; the 38 extra are upstream's Hermes and read-scope cases, which the rebase brought in.)
node conformance/run.mjs: totals vectors 474, passed 474, failed 0, controls 176, manifest ok true. 474 rather than 471 because upstream's hook-read-scope gained three; command-class stands at 86 with vectors_version 1.5.0, and no other open branch claims that number.

APRV-409's numbers on the same post-rebase base, for the record, since the two tasks ship as one stack: the 13 new tests/command-class-quoting.test.ts cases are inside the 916 above, and the command-class conformance suite is 86 vectors / 10 negative controls at 1.5.0.
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
author: @lane-a
created: 2026-09-22 01:31
---
AC2 is left unchecked on purpose and the task stays In Progress for it. Its past-grace half needs a new member of channel_decision_refusal_codes (a SPEC 11.2 registry row, a refusal-unions MAJOR bump) and, underneath that, the abandonment window recorded on the request so a decision surface can judge it without guessing another process's flags — a payload field, so a schema change. Both are off-limits to this lane today and both are named in the notes, in docs/claude-code-hook.md and in the journal. The HARM AC2 exists for is closed here: a grant written past the grace is no longer carryable, so it authorizes nothing. Carter's call whether the record-level refusal is filed as its own task.
---

author: @lane-a
created: 2026-09-22 01:38
---
Overlap with open PR #535 (APRV-423), found while checking for conformance-version collisions and worth reconciling before either lands. APRV-423 has the hook state a harness ceiling with --harness-cap, RECORDS it on approval.requested as harness_cap_ms, and derives min(approval_ttl, cap - 60s) in core/state.ts so the gate, the TTL sweep, the carry lookup and the channels all judge a lapse the same way; its description says a late tap keeps the existing refusal. That is exactly the recorded window AC2 here is blocked on: once a request carries a window a decision surface can read, a late tap refuses expired (a code that already exists, already worded for the approver: 'Expired - the approval window has closed') and approval.expired is materialised instead of a grant, with no new union member and no SPEC 11.2 row. So AC2 may be mostly delivered by #535, and if it is not, the remaining work is small and belongs on top of it rather than as the separate SPEC amendment my notes assumed.

Two things to reconcile rather than merge blind. The WINDOWS are different: APRV-423's cap is the harness's ceiling on the hook PROCESS, and this task's is the wait plus the retry grace, which is how long a question is adoptable. Both only shorten, so composing them is safe, but findHarnessCarry would then be bounded twice and one of the two bounds may be redundant. And the diffs overlap textually in src/cli/hook.ts, src/core/gate.ts and docs/claude-code-hook.md, so whichever lands second rebases.

This lane did not restructure around an unmerged branch. Flagging for the orchestrator.
---
<!-- COMMENTS:END -->
