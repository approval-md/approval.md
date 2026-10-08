---
id: APRV-287
title: Hook timeouts must not flood the phone or feed the escalation they wait on
status: Done
assignee: []
created_date: '2026-09-06 22:33'
updated_date: '2026-09-07 23:35'
labels:
  - hook
  - daemon
  - telegram
dependencies: []
priority: high
ordinal: 213000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Tonight (2026-09-06) three hook waits expired in a row while the daemon was dead behind a stale socket. Each expired wait (a) left its request open until the policy TTL, so the daemon restart redelivered a dozen dead requests to Carter's phone one message each, and (b) counted as a failed side-effecting call, so the loop-escalation floor (SPEC §10.2, APRV-280) deepened on the very timeouts it was causing: escalation routes reads to the phone, unanswered reads time out, timeouts extend the escalation. Carter asked for fixes for both the flood and the feedback loop.

Three changes, one task, because they share the hook's timeout path:

1. Withdraw on timeout. When `approval hook` gives up waiting it appends `approval.withdrawn` (reason `timeout`, existing enum) for its own request, unless the identical command is retried from the same cwd inside a short grace window (default 5 min), in which case the retry adopts the open request exactly as today. A tap on a withdrawn request authorizes nothing and the channel says so in the reply.
2. Collapse redelivery. On daemon start or listener reconnect, pending requests older than the hook wait are delivered as ONE summary message naming the count and the classes, with a single reject-all action; fresh requests keep one message each. Navigation stays process memory per §10.1 delivery pacing: losing the summary degrades to showing requests again.
3. A timeout is not a failure. The escalation counter reads execution outcomes; an expired wait records a withdrawal, not `execution.failed`, and must not advance the counter. Reads already change nothing (APRV-280); this closes the same hole for side-effecting classes whose wait simply expired.

SPEC: §10.1 hook timeout paragraph and §10.2 escalation counting, both marked (Amended APRV-<this>, pending sign-off). Invariant touched: 6 (any new refusal code is pinned) and the append-only rule (withdrawal is a new record, nothing is edited).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 An expired hook wait appends approval.withdrawn (reason timeout) for its request unless the same command from the same cwd retries within the grace window; tests/cli-hook.test.ts covers withdrawn, adopted-by-retry, and tap-after-withdraw (authorizes nothing, channel reply says so)
- [x] #2 Daemon start and listener reconnect deliver requests older than the hook wait as one summary message with a reject-all action; tests/channels-telegram.test.ts covers the collapsed and the fresh case, and losing the summary degrades to re-showing requests
- [x] #3 An expired wait does not advance the loop-escalation counter; tests/loop-escalation (or the APRV-280 suite) proves three expired waits leave the floor closed while three execution.failed still open it
- [x] #4 SPEC §10.1 and §10.2 amended with pending-sign-off markers; docs/claude-code-hook.md documents the grace window and the withdrawal; CHANGELOG entry
- [ ] #5 A harness-side misfire (a hook-unparseable command, an Edit refused before it ran, a tool-input validation error) is not an execution and does not advance the loop-escalation counter; only a command that started and exited non-zero counts. Test: three unparseable commands leave the floor closed
- [x] #6 One command is one decision: a shell command that classifies into several classes raises ONE request carrying all of them (or one grouped delivery with a single approve), so the human taps once; tests/cli-hook.test.ts and tests/channels-telegram.test.ts cover a five-class command. Seen 2026-09-06: a commit-and-push raised five separate Telegram messages and needed three rounds of taps
- [x] #7 A completed side-effecting command clears the floor, as the refusal text promises: after a granted retry completes, the next command is routed by policy, not by loop safety. Seen 2026-09-06: a granted commit-and-push completed and the very next command was still loop-escalated
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. New module src/core/harness-wait.ts: HOOK_DEFAULT_WAIT (55s), HOOK_DEFAULT_WAIT_MS, HOOK_RETRY_GRACE_MS (5 min, doc comment), abandonedAfterMs(waitMs, graceMs). One home for the two numbers the hook and the channel both need.
2. AC1 withdraw on timeout. hook.ts gains --retry-grace (parseDuration, default HOOK_RETRY_GRACE_MS). gateAndWait sweeps at intake and withdraws at the deadline: a pending harness request this actor opened, whose payload hash is not the one this invocation is asking about, and whose age exceeds wait+grace, is withdrawn with the existing reason timeout. A retry inside the grace still adopts, so APRV-117 carryover is untouched. Tap after withdrawal already refuses request-withdrawn and the channel line already says Withdrawn (channels/contract.ts refusedDecisionLine); both get a test.
3. AC2 collapsed redelivery. channel-telegram dispatchPending splits the first cycle of a process (banner not yet sent, i.e. start or reconnect) into stale (age over the hook wait) and fresh. Stale go to a new channel method as ONE message: count, class tally, oldest age, and a single Reject all button, reusing the digest nonce machinery with a reject-only keyboard. Fresh keep one message each. A failed summary send leaves the keys undelivered so the next cycle re-shows them.
4. AC3 an expired wait records a withdrawal, never execution.failed, so core/loop.ts needs no change: proved by a test that three expired waits leave the floor closed while three execution.failed open it.
5. AC5 harness misfires. Pinned by test: a hook-unparseable command, a hook-denied tool call and an ungated tool-input error write no execution.started, so finishHarnessExecution refuses not-delegated and the floor stays closed. Documented in docs and in the SPEC draft: only a start this runtime wrote can accrue.
6. AC6 one command one decision. groupForDigest gains a pre-pass that groups the requests of ONE tool call (same task, same payload hash) into one digest whatever their classes; digestFacts renders the class set; deliverDigest sends the shared payload ONCE when every member carries the same hash. Per-class records in the log are unchanged: the digest still appends one decision event per member.
7. AC7 a completion clears the floor. Root cause: consumeHarnessGrant writes execution.started under the REQUESTING task, so a carried grant spent by a later tool call leaves the start under the old task id and finishHarnessExecution, which rebuilds the task from the reporting event, answers not-delegated and never records the completion. Fix: the consume record carries the spending task (runtime-derived, already passed as spendingTask for grant_origin) and finishHarnessExecution matches a start by its task OR by that field.
8. AC4 docs/claude-code-hook.md (grace window, withdrawal, collapsed redelivery, counting rules) plus a CHANGELOG entry under 0.1.0 unreleased. SPEC amendment text goes in the implementation notes for the human to apply, not into SPEC.md.
Tests: tests/cli-hook.test.ts (withdraw, adopt, tap-after-withdraw, misfires, clearing), tests/channels-telegram.test.ts (collapsed and fresh delivery, lost summary, five-class command), then npm run build, node --test on the touched suites, npm run lint, npm test.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Added AC5-AC7 after the escalation re-tripped on two harness misfires (an unread-file Edit refusal and a hook-unparseable command substitution), after one commit-and-push produced five separate phone messages, and after a completed granted push failed to clear the floor.

## What was done

New module src/core/harness-wait.ts holds the two durations the hook and the Telegram listener both need: HOOK_DEFAULT_WAIT (55s, moved off the hook), HOOK_RETRY_GRACE_MS (5 min, doc-commented) and abandonedAfterMs(). Two copies would be two answers to the question of whether anybody is still waiting on a request.

AC1, withdraw on timeout (src/cli/hook.ts). A new --retry-grace flag (default HOOK_RETRY_GRACE_MS) bounds how long an expired wait leaves its question open. abandonedRequests() derives, from the verified records the caller already read, the pending harness requests this actor opened whose age exceeds wait plus grace, excluding the payload hash this invocation is asking about; withdrawAbandoned() takes them back through the existing withdraw path with the existing reason timeout. It runs at intake (sweeping what earlier tool calls abandoned) and at the deadline (this invocation's own keys). The deny text states which of the two happened. Inside the grace nothing changes and APRV-117 carryover is untouched. A tap on a withdrawn request was already refused request-withdrawn with nothing appended, and refusedDecisionLine in channels/contract.ts already tells the approver it was withdrawn and nothing was recorded; both are now pinned by tests.

AC2, collapsed redelivery (src/cli/channel-telegram.ts, src/channels/telegram.ts). On a process first cycle under burst delivery, pending requests older than the collapse line go out as ONE message: count, oldest age, class tally, one Reject all button and no approve. Implemented as a reject-only variant of the existing digest (DigestState.stale, renderStaleSummary, TelegramChannel.notifyStale), so the existing all-nonce callback machinery decides it, one log event per member. Fresh requests keep one message each. A failed send reports on stderr and leaves every key undelivered, so the next cycle shows them again.

AC3, an expired wait is not a failure. No change to core/loop.ts was needed once AC1 landed: the timeout path appends approval.withdrawn and never an execution outcome. Pinned by a test that runs three expired waits and asserts no execution record, no accrued scope, and that the next command is answered by policy, with a control test proving three execution.failed still floor the session.

AC5, harness-side misfires. Pinned rather than changed: a command the classifier cannot read is denied before anything is appended, so no execution.started exists and the post-execution report is refused not-delegated. Three unparseable commands leave the floor closed and the next command runs by policy. See the caveat below for the sub-case that is NOT closed.

AC6, one command is one decision. groupForDigest gained a pre-pass: requests sharing one task id and one payload hash, with more than one class, are one tool call and become one digest whatever their classes; every other grouping is untouched, so the APRV-115 burst-of-forty case still groups by class. digestFacts renders the class set, and deliverDigest sends the shared payload ONCE instead of once per member. The log is unchanged: one decision event per class.

AC7, a completed command clears the floor. Root cause found: consumeHarnessGrant writes execution.started under the REQUESTING task, so a grant carried by a later tool call left the start under the old task id, and finishHarnessExecution rebuilds the task from the reporting event, found no start under it and refused not-delegated. No completion was ever recorded, so nothing cleared. Fix: the consume record carries spent_by_task (the spending task id the runtime already had for grant_origin) and finishHarnessExecution matches a start by its task OR by that field. Runtime-derived on both sides, so a report still cannot choose the execution it closes.

AC4, docs and CHANGELOG are done (docs/claude-code-hook.md gained four sections: the retry grace and the withdrawal, one command one decision, a dead queue is one message, and what counts toward the loop floor; CHANGELOG has an entry under 0.1.0 unreleased). SPEC.md is deliberately NOT edited: the amendment text is below for the human to apply under a tap, so AC4 is left unchecked.

## Decisions and deviations worth review

1. The collapse line is the hook wait PLUS the retry grace (about 6 min), not the wait alone as the task text says. Inside the grace a retry can still adopt the question, and past wait plus grace is exactly the line at which the hook itself takes such a request back, so the two halves of this task agree on one number. It also keeps the collapse away from live queues: with the wait alone, fixtures one minute old collapsed.
2. Collapsing applies to burst delivery only. Paced already puts one question at a time in front of the approver behind a summary line, so a restart there is two messages rather than a dozen, and collapsing a paced walkthrough would remove the approve an approver deliberately walking an old queue came for.
3. The collapsed message offers reject-all and no approve, because it carries no payload and SPEC 10.3 requires the canonical payload rendering before a decision is collected. A rejection authorizes nothing, so it needs no such showing. The message says this in as many words and names both other routes to an approval (the request own card, approval grant).
4. Collapsing starts at two stale requests: a lone one keeps its own card, which saves nobody a message and would take away the ability to approve it.
5. No new refusal code was minted. The withdrawal reuses request-withdrawn and hook-timeout, both already frozen in their unions, so SPEC 11.1 invariant 6 needs no new 11.2 row.
6. Invariants touched, as CLAUDE.md requires them to be stated: append-only (the withdrawal is a new record, nothing is edited or reordered, and every test log is built through the real append path), invariant 1 (the sweep reads only verified records and derives request state through requestState), invariant 4 (spent_by_task and the collapse threshold are runtime-derived; nothing a reporter authors chooses a bucket or a grouping), invariant 8 (no verdict is printed before its record, unchanged).

## The sub-case AC5 does NOT close, stated plainly

An Edit the hook ALLOWED and the harness then refused before running it (the unread-file case) is still recorded as execution.failed and still accrues. Claude Code pinned post-execution contract carries no exit code and no structural field saying the tool did not run, so the only discriminator available is the reporter own text, and letting a self-reported field say do-not-count-this is exactly what SPEC 11.1 invariant 4 forbids. Inventing a field no harness sends would be dead code that reads as a fix. What bounds the harm instead is AC7: the next completed side-effecting tool call clears the floor, which it now actually does. Closing it properly needs a harness-side fact the runtime can verify, and that is its own task.

## Tests

tests/cli-hook.test.ts: 8 new cases (withdrawal past the grace and its reason; a tap on a withdrawn request plus the channel line; nothing withdrawn inside the grace and the retry adopting; a later tool call sweeping what earlier ones abandoned; three expired waits leaving the floor closed; three execution.failed still opening it; three harness misfires accruing nothing; a completed carried grant clearing the floor and the next command routed by policy). One existing APRV-117 assertion was sharpened rather than weakened: it asserted the retry task id appeared nowhere in the log, and the spend now names it as spent_by_task, so it asserts instead that no request and no registration carries that task.

tests/channels-telegram.test.ts: 3 new cases (five classes of one command as one card with one approve and the payload sent once; a restarted listener collapsing the stale queue and re-showing it after a memory loss; a failed collapsed send leaving every request to be shown again). One existing APRV-216 burst case was moved from a 60-minute-old queue to a fresh one, because a 60-minute queue is now the collapse case and has its own test.

## SPEC amendment text (apply by hand)

Placement note: the task named 10.1 for delivery pacing; in the current SPEC.md that paragraph is in 10.3, so the third block is written against 10.3. Backticks are omitted here and should be restored on the code identifiers when applying.

### 10.1, new paragraph after the journal paragraph

A harness wait that expires, and the question it leaves behind. A harness adapter blocks for a bounded wait and then answers deny, and the request it opened stays open, because a decision inside the policy TTL still authorizes an identical retry of the identical command. That window is bounded. Implementations MUST hold such a request open for a stated retry grace, measured from the request own runtime-assigned timestamp, and MUST withdraw it (approval.withdrawn, reason timeout) once the grace has elapsed with nothing having adopted it; the requester is the adapter own identity, so it is the only party that may. A withdrawal authorizes nothing and refuses a later decision in the words 11.2 gives request-withdrawn. The reason a bound exists is what an unbounded one costs: a question nobody is holding is re-delivered to an approver by every listener that starts, and a tap on it spends the audit budget of 11 on an act that cannot happen. The grace is configuration with a default, and an implementation MUST state it wherever it states the wait. (Amended APRV-287, pending sign-off.)

### 10.2, new paragraph after the one on what a self-reported outcome may do

What is not an execution. A streak counts executions that failed, and an execution is a command this runtime authorized and the harness ran. Three things are therefore transparent to it. An expired wait records a withdrawal and never an execution.failed, so a gate a human is not answering cannot deepen the floor that routes more questions to them: escalation routes reads to a human, unanswered questions time out, and a timeout that accrued would close that circle. A tool call the adapter refused, whether for an unreadable command, a class the policy reserves, or any other deny, opened no execution.started, so the outcome a harness reports for it closes nothing and MUST be refused as naming no delegated execution. A report for a tool call this runtime never started is the same fact and takes the same answer. Only a command that started and exited non-zero counts, and the start is the runtime own record rather than the reporter claim (11.1 invariants 1 and 4). (Amended APRV-287, pending sign-off.)

### 10.2, second new paragraph, immediately after the one above

A completion clears the streak wherever the grant was carried. The completion counterpart resolves the execution it closes from the log rather than from the report, and a grant carried by a later tool call is spent under the requesting tool call task. An implementation MUST therefore record, on such a start, the tool call that spent it, and MUST accept that name as well as the record own task when it resolves what a report closes. Without it the completion of a granted retry closes nothing, and a floor whose refusal text promises that a completion clears it does not clear (observed 2026-09-06). The name is derived by the runtime from identifiers it minted, so no report chooses the execution it is closing. (Amended APRV-287, pending sign-off.)

### 10.3, appended to the delivery-pacing paragraph (APRV-216)

A channel that re-derives the pending set when it starts or reconnects MAY deliver the requests older than the harness wait of 10.1 as one message naming the count, the classes and the age of the oldest, carrying a single reject-all and no approve. The collapse is this paragraph pacing rule applied to a queue nobody is waiting on: it is process memory, its loss MUST degrade to showing the requests again, and every collapsed request stays pending, listable, and decidable from any copy already delivered. It carries no approve because it carries no payload, and this section requires the canonical rendering of a manual action payload in front of an approver before a decision is collected; a rejection authorizes nothing, so it is not bound by that showing. (Amended APRV-287, pending sign-off.)

One tool call is one question. Where several pending requests share one task and one payload hash they are the classes of one command, and a channel SHOULD present them as one grouped delivery collecting one gesture, with the payload rendered once. The log is unchanged: each member receives its own decision event, per this section batching rule. (Amended APRV-287, pending sign-off.)

### 11.2, no new rows

No refusal code is minted by this task. The withdrawal reuses request-withdrawn and the harness adapter hook-timeout, both already frozen in their unions.

2026-09-07: SPEC amendments applied on PR #319 under three policy.edit.spec taps (10.1 wait grace, 10.2 what is not an execution and completion clears wherever carried, 10.3 collapsed redelivery and one tool call one question), all marked pending sign-off. AC5 stays half-open on purpose: an Edit the hook allowed and the harness then refused still counts as execution.failed, because Claude Code's post-execution report carries no verifiable did-not-run fact and a self-reported one would breach invariant 4. File a follow-up when it bites; AC7's clearing rule bounds the harm. Merged 2026-09-07T05:06Z.

2026-09-07 finalize: SPEC §10.1/§10.2/§10.3 amendment text for this task landed in PR #323 (opened today, pending Carter's sign-off), which applies the five paragraphs quoted above verbatim. AC4 is satisfied on that basis. AC5 (harness-side misfire discrimination for a hook-allowed-but-harness-refused Edit) remains genuinely unimplemented per the notes above: Claude Code's post-execution contract carries no verifiable did-not-run fact, so closing it needs a new task rather than a retry here; AC7's floor-clearing fix bounds the harm in the meantime. Status set Done on the strength of AC1-4,6,7; AC5 is a known, deliberately scoped-out follow-up.
<!-- SECTION:NOTES:END -->
