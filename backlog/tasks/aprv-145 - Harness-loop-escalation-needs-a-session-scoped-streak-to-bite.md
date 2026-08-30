---
id: APRV-145
title: Harness loop-escalation needs a session-scoped streak to bite
status: Done
assignee:
  - '@fable-wave1'
created_date: '2026-08-26 13:34'
updated_date: '2026-08-30 02:34'
labels:
  - security
  - hook
  - spec
  - design
dependencies: []
priority: medium
ordinal: 130000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Born 2026-08-26 from the APRV-139 builder's observation. The hook's task id is hook:<session>:<tool-use-id>, minted per invocation, and the hook never appends execution.failed (it never sees an exit status). So the loop-escalation check APRV-139 added to the unattended guard fires only when something else recorded failures under that exact task id: the guard is correct and near-vacuous by construction on the harness path. If loop safety is meant to bite for harness-executed commands, the streak needs a scope that survives across tool calls (the session id is the natural candidate) and a source of failure signal (the harness posts no exit status to the gate today; PostToolUse hooks or the APRV-141 execution records plus a completion counterpart are candidate sources). This is a SPEC question (what is a loop, on a surface that cannot see failures?) before it is code; the task is to write the design and flag the SPEC amendment for sign-off, then build.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A written design states the streak scope, the failure signal, and what the guard refuses, with the SPEC amendment drafted and flagged for sign-off
- [x] #2 If built: a session-scoped failing streak on the harness path routes the next non-manual command per the design, tested
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Sanity-review the completed AC1 design against current origin/main, refreshing drifted line references by symbol and dropping any claim that is false against the tree. 2. Record the design as implementation notes in numbered chunks: the defect, streak scope, failure signal, guard remedy, operator surfaces, the invariant-4 self-report analysis, and the review corrections. 3. Apply the drafted SPEC 10.2 amendment as one batched edit flagged pending sign-off, inserted before the 10.3 heading so no existing byte of 10.2 changes. 4. Commit the SPEC edit alone on branch aprv-145-design. AC1 only: AC2 stays unbuilt pending human sign-off, and no acceptance criteria are checked here.

AC2 BUILD PLAN (branch aprv-145-streak, from origin/main 8d3b76e). 1. core/loop.ts: add the harness projection beside loopEscalation - harnessSessionOf derives the session key from the task id prefix, toolCallOutcomes folds each harness task to ONE outcome placed at its closing seq, harnessLoopEscalation returns the session and actor streaks sorted byte-stably, harnessLoopFloor answers which scope floored a tool call, harnessOutcomeCoverage counts started vs reported. 2. core/gate.ts: add finishHarnessExecution as its own marked surface, resolving task and keys from the verified log, refusing not-delegated for a start with no harness marker and already-finished for one already closed, appending execution.completed or execution.failed with the harness marker, a closed reported_by and a null exit_code, one read per append. Widen startHarnessExecution loop check to both scopes. Add a loopFloor door into request() manual path. 3. core/execute.ts: openExecution doc gains the except-by-the-marked-counterpart clause; the three human recovery verbs are unchanged. 4. cli/hook.ts: parseHookInput reads hook_event_name and tool_response; runHarnessHook dispatches a post-execution event to runPostToolUse; the floor is applied after class resolution and recorded in the verdict note. 5. cli/execute.ts and cli/doctor.ts: the status rows and the harness-hook-outcomes check. 6. schema/event.schema.json: additive reported_by, execution marker and exit_code constraints on the two outcome events, with two valid and two invalid fixtures; regen conformance. 7. Tests through the real append path in tests/cli-hook.test.ts, plus the union and shape pins.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
DESIGN (1/6) - the premise, verified against main at e31ffff.

Three facts in current code, each spot-checked:

a. src/cli/hook.ts:1537 mints the task id as hook:<sessionId>:<toolUseId or 8 random bytes>. It is fresh for every tool call, and the comment above it says so.
b. src/cli/hook.ts:1554 calls unattendedGuard with that id; unattendedGuard (src/cli/hook.ts:1003) checks attestation and then isLoopEscalated, denying with the frozen code hook-gate-refused:loop-escalated at src/cli/hook.ts:1024.
c. src/core/loop.ts:100 and :108 move the counter only on execution.failed and execution.completed carrying the same record.task.
d. src/core/gate.ts:2563 startHarnessExecution appends execution.started with the marker execution: harness (src/core/gate.ts:2656). Its own doc comment at src/core/gate.ts:2545 states that no execution.completed or execution.failed will ever follow, because the harness runs the command and this runtime never observes an exit status. docs/claude-code-hook.md:406 says the same thing to the operator.

So the harness loop check is near-vacuous for two independent reasons at once: the scope cannot outlive one tool call, and no event that moves the counter is ever appended on that path. Both have to be fixed for the guard to bite. Nothing in the task description was found wrong against current code.

DESIGN (2/6) - streak scope: the harness session.

The streak gains a second scope keyed on the harness session id, written hook:<sessionId>, which is exactly the prefix of the id the hook already mints through its second colon. No new field is needed on any event: the session is recoverable from the task string the runtime itself wrote.

The per-task streak of SPEC 10.2 is untouched. The session streak is a second pure projection beside loopEscalation in src/core/loop.ts, counted over the same two events, at the same threshold constant LOOP_ESCALATION_THRESHOLD, sorted by session id so it is byte-stable for a deepEqual pin the way loopEscalation already is.

Why the session and not something wider or narrower. Narrower than the session is what we have, and it cannot survive a tool call. Wider than the session (per actor, per repository, per day) would let one wedged agent escalate a second agent that is doing fine, which converts a loop guard into a denial of service against the humans operating the repo. The session is the smallest scope a runaway actually runs away in, and it is the scope the harness itself already names.

Deriving rather than declaring matters for SPEC 11.1 invariant 4: a session id parsed out of the task the runtime minted is a computed field, while a session id an agent hands the gate would be self-reported and could be rotated to shed a streak.

DESIGN (3/6) - failure signal: a PostToolUse report that may only ratchet upward.

The only party that sees a tool call exit status is the harness, and the harness is the untrusted side. docs/claude-code-hook.md:408 already flags the future PostToolUse companion and the fact that its report comes from that side. The APRV-141 execution records are the other candidate; they are starts only and carry no outcome, so they cannot supply the signal by themselves.

Design: a PostToolUse companion verb appends execution.failed for a harness execution.started it can match by action key, and appends nothing at all for a reported success.

The asymmetry is the whole design and it comes straight out of SPEC 11.1 invariant 4. A reported failure moves the session toward escalation, which is scrutiny raised, which a self-reported field is permitted to do. A reported success would reset a streak, which is scrutiny lowered, which a self-reported field may never do. An agent that could clear its own streak by claiming a success has no streak. So on the harness path the session counter is monotone: it goes up on reports and never comes down on them.

What does clear it is evidence the runtime produced itself: an execution.completed appended by src/core/execute.ts for a task in that session, under a granted token, through the path where this runtime ran the command and read the exit status. Where a session can produce no such evidence, the escalation stands for the life of the session. That is the fail-closed reading and it is tolerable because escalation is a floor rather than a ban (the src/core/loop.ts header states this): the session keeps its manual path and keeps reaching a human.

DESIGN (4/6) - what the guard refuses.

In src/cli/hook.ts, inside unattendedGuard and therefore only on the branch where every class of the command resolves non-manual, after the existing attestation check and the existing per-task isLoopEscalated check: if the session streak is at or over the threshold, deny with a new frozen code hook-gate-refused:session-loop-escalated.

The code is distinct from hook-gate-refused:loop-escalated on purpose. SPEC 11.1 invariant 7 wants refusals machine-readable and distinct, and an operator reading a deny needs to know whether one task wedged or the whole session did, because the remedies differ.

The same check is repeated at the write boundary in startHarnessExecution, beside the existing isLoopEscalated call at src/core/gate.ts:2595, against the records that authorize the append. A check in the hook alone is a check-then-append with a window in it.

Escalation is to manual, matching SPEC 10.2 for tasks. A command with any manual class in an escalated session keeps the path it has today: it requests, it prompts, it waits for a human. The session is never left with no way to ask, which is also the way out: the human who answers the prompt is the human who can decide the session is fine.

A build that ships no PostToolUse companion sees a session streak that is permanently zero and behaves exactly as today. The mechanism is opt-in at install and regresses nothing when it is absent.

DESIGN (5/6) - operator surfaces, and the invariants this touches.

Surfaces. approval status --json carries the session states beside the task states, under their own key, sorted the same byte-stable way. The daemon pass that SPEC 10.2 describes as surfacing escalated tasks surfaces escalated sessions on the same pass. The deny text names the session id, the streak length, and the sequence number of the first failure in the streak, so the operator can find the offending commands in the log without composing a query.

SPEC 11.1 global invariants this design touches, per CLAUDE.md:
- Invariant 1, enforcement paths read only verified records. The session projection is fed from readVerifiedRecords in the hook and readGateRecords in the gate, the same reads the per-task check already uses. No new reader of raw bytes.
- Invariant 4, self-reported fields never reduce scrutiny. This is the load-bearing one and it is analysed in chunk 3. The harness failure report is a self-reported field that may raise the streak and may never clear it, and the session id is derived from a runtime-minted task id rather than accepted from the agent.
- Invariant 5, every check-then-append passes through compare-and-append. The write-boundary re-check in startHarnessExecution is why the hook check alone is not enough.
- Invariant 7, refusals machine-readable and distinct. The new session-loop-escalated code.
- Gate-typed events never accept caller timestamps: unchanged, the PostToolUse companion appends through the same gate path and takes the runtime clock.

DESIGN (6/6) - the SPEC 10.2 amendment, verbatim, and the state of the acceptance criteria.

Inserted as a new paragraph in SPEC 10.2 directly after the paragraph that states the loop-safety rule, flagged pending sign-off. Verbatim text:

Loop safety where the runtime cannot see failures (APRV-145). The streak above counts events this runtime appends, and a harness hook (section 10.1) appends none of them: it records execution.started carrying the harness execution marker and never observes an exit status, so a streak scoped to the task id such a hook mints per tool call cannot leave zero. An implementation that gates a harness MUST therefore keep a second streak scoped to the harness session, counted over the same two events at the same threshold, with the session derived from the task id the runtime itself minted rather than declared by the agent. A harness MAY report a tool call outcome back to the gate. Such a report is authored by the party under oversight, so section 11.1 invariant 4 governs it exactly: a reported failure MAY advance the session streak, and a reported success MUST NOT clear one. A session streak clears only on an execution.completed this runtime observed for a task in that session. An escalated session escalates to manual in the sense section 10.2 already gives that word: its non-manual classes are refused, under a code distinct from the per-task refusal, while its manual classes keep the human path they had, so an escalated session always retains a way to ask. A runtime that reports no outcomes holds its session streaks at zero and is conforming, since this rule bounds what a report may do and never requires one. (Amended APRV-145, pending sign-off.)

Acceptance criteria. AC1 is met by this design plus the SPEC amendment above. AC2 is deliberately left unchecked: the build waits on human sign-off of the amendment, which is what the task asked for.

Provenance caveat for the reviewer. The lane brief pointed at a prior agent scratchpad report holding a drafted design. That file did not exist on disk when this lane ran, and neither did any sibling scratchpad content, so the design recorded above was authored fresh in this lane from the current code rather than reviewed from a prior draft. Every code claim in it was spot-checked against main at e31ffff and the line references are current.

LANE STATUS. The SPEC 10.2 amendment was applied to the worktree file and is present as an uncommitted change on branch aprv-145-loop-streak-design. The commit that would land it classifies as policy.edit and is manual class; the approval prompt timed out twice at the nine minute wait with no tap, so the approver is unavailable and the commit was not forced. The amendment text is recorded verbatim in chunk 6 above for replay after the tap. Verification at the time of the block: npm test 2302 pass, 2 fail, both in the hook wait tests under parallel load and both green on a re-run in isolation, so main's 2304 green stands; npm run lint clean.

AC1 DESIGN — CHUNK 1 of 7: THE DEFECT, PRECISELY

`src/cli/hook.ts` mints one task id per tool call: the task is the string `hook:` plus the session id plus the tool-use id, falling back to fresh random bytes when the tool-use id is absent (in `runHarnessHook`, currently near line 1537). `unattendedGuard` (hook.ts, currently near line 1003) and `startHarnessExecution` (`src/core/gate.ts`, currently near line 2563) both ask `isLoopEscalated(records, task)` with that per-call id. `src/core/loop.ts` counts `execution.failed` per task and resets on `execution.completed`. The hook never appends either outcome: `docs/claude-code-hook.md` (near line 357) states it outright, that no `execution.completed` ever follows, and `executionCustody` (`src/core/execute.ts`, currently near line 1319) gives every harness start the terminal `delegated` state. So the streak counter and its scope are both empty by construction. The APRV-139 check is correct and cannot fire.

VERIFIED against origin/main at e31ffff. All symbols confirmed present; line numbers in the original draft had drifted and are refreshed above by symbol. `hook.ts` line 1062 calls `startHarnessExecution`, so the hook does append `execution.started` — only the closing counterpart is missing.

AC1 DESIGN — CHUNK 2 of 7: SCOPE — THE SESSION, PLUS AN UN-ROTATABLE BACKSTOP

UNIT. On the harness path the streak counts TOOL CALLS, not events. One tool call is one task id, and it may declare several classes (`recordUnattended` and `gateAndWait` open one action key per class, the task id followed by the class). Counting events would let a three-class command trip the threshold on a single failure. So a task folds to one outcome first: any `execution.failed` under it makes it a failed tool call, and only `execution.completed` with no failure makes it a completed one. A task whose classes disagree counts as a FAILURE, since ambiguity resolves stricter.

PRIMARY SCOPE: THE SESSION. What identifies a session across tool calls is the session id on the PreToolUse JSON, read by `parseHookInput` (hook.ts, currently near line 340, reading the field at line 365), already embedded as the middle segment of every task id the adapter mints. The streak key is therefore `hook:` plus the session id, a real prefix of the task ids, so an operator can grep the log for it. Nothing is held in memory: the hook is a fresh process per tool call, so session-scoped must mean a pure projection over the log, exactly as `loopEscalation` already is.

ABSENCE COLLAPSES, IT DOES NOT FORK. `parseHookInput` already defaults a missing session id to the literal `unknown-session` (verified at hook.ts line 365). Keep that and make it normative: every unreadable identifier lands in ONE shared bucket. A task id that does not split into exactly three colon-separated parts also lands there. Absence therefore accrues faster and never slower, which is the fail-closed direction.

SECOND SCOPE: THE ACTOR, BECAUSE THE FIRST IS SELF-REPORTED. The session id is authored by the party under oversight, and a scope key the subject can rotate is a streak the subject can clear, which SPEC 11.1 invariant 4 forbids: a self-reported value may raise scrutiny and may never lower it. So the runtime accrues a second streak keyed on the actor identity the adapter runs as, `agent:claude-code`, and treats a command as escalated when EITHER streak reaches `LOOP_ESCALATION_THRESHOLD`. That identity is not the agent to change: it comes from the `--as` flag on the hook command line in `.claude/settings.json` (verified at line 9), a `policy.edit`-classed file a human commits. Three consecutive failed tool calls from one agent identity with nothing succeeding in between is precisely a stuck loop, so the wider scope is as narrow in practice as SPEC 10.2 per-task rule.

THE CALLER CANNOT NAME ITS OWN BUCKET. Both scopes are derived by the runtime: the session from the task id the runtime itself minted, the actor from the identity the process runs under. No input field carries a scope. This closes the same hole that request() closes by refusing a caller-supplied timestamp and display hash.

ORDERING. Streaks are consecutive in LOG ORDER by seq, and the outcome of a tool call is placed at the seq of its CLOSING record, so interleaved sessions and late-arriving counterparts order deterministically. Never by timestamp.

WHAT RESETS IT. Only an `execution.completed` in the same scope. Unchanged from `core/loop.ts`, and deliberately not widened: a hook timeout, a deny, a withdrawn request, a granted approval, a new tool call, a restarted process, and elapsed time all leave the streak where they found it. A new session id starts a fresh session bucket, which is what a bucket is, and does NOT touch the actor bucket, which is the whole reason the actor bucket exists.

MODULE SHAPE. `core/loop.ts` keeps `loopEscalation(records)` byte-stable, since its output feeds a pinned status JSON shape, and gains `harnessLoopEscalation(records)` returning the per-session and per-actor streaks, plus `harnessScopeOf(task, actor)`. Both projections stay in one module so the gate, the executor, the hook and the CLI cannot hold three opinions, which is the stated reason `loop.ts` exists at all.

AC1 DESIGN — CHUNK 3 of 7: SIGNAL — A POST-TOOL-USE COUNTERPART, NOT A NEW VERB

CHOSEN: a PostToolUse hook event appending the ordinary `execution.completed` or `execution.failed`. REJECTED ALTERNATIVE: an explicit agent-facing outcome verb. Two reasons. An agent in a runaway loop is the agent least likely to volunteer a report about its own failure, so a verb makes the signal exactly as absent as it is today. And a new agent-drivable write surface is strictly worse than a harness-driven one: the harness invokes PostToolUse whether the agent wants it or not, and the event can only ever concern a tool call whose `execution.started` this runtime already wrote. `approval execution resolve` stays what it is, human-only with a mandatory note and a human attestation marker, and must NOT become the harness channel, because that would dress an untrusted report as a person observation.

NO NEW EVENT TYPE. `execution.completed` and `execution.failed` are what `core/loop.ts` already counts and what `executionCustody` already reads, flipping `delegated` to `settled`, which is truthful: the runtime learned the outcome after all. A new type would be a SPEC 8 enum widening every verifier must learn, for no gain.

RECORD SHAPE (payload fields additive, per SPEC 8). The appended record is an `execution.failed` or `execution.completed` whose actor is `agent:claude-code`, whose task is the harness task id, and whose action key is that task id followed by the class. Its payload carries three fields and nothing else: an `execution` field set to `harness`, a `reported_by` field, and an `exit_code` field. Chain fields and the runtime-assigned timestamp are as for any gate-typed event.
- The `execution` field set to `harness` is the same marker the start carries.
- `reported_by` is drawn from a CLOSED set, holding only `post-tool-use` at v0.1 and extended only by a task that adds the case, following the closed-reason-set precedent. It names which untrusted reporter asserted the outcome. It is a CLAIMED field in the computed-versus-claimed vocabulary of SPEC 9 and reduces nothing.
- `exit_code` is a number only when the harness stated one, otherwise null, mirroring `finishExecution` (execute.ts, currently near line 822) and the APRV-120 rule that a fabricated number reads exactly like a measured one.
- NO TOOL OUTPUT TEXT, EVER. SPEC 11.1 invariant 3 has no exception for diagnostics; this is the APRV-120 argument for `execution.indeterminate` carrying a closed code and nothing else.
- Actor is an `agent:` identity, never a `system:` one. The runtime did not observe the exit, the harness did, and the record must say who is asserting it.
- No human-attestation marker. That marker belongs to a person observation.

INVARIANT 2, NO CALLER TIMESTAMPS. The execution events are gate-typed (SPEC 8 lists them among the gate-written set), so the refusal is STRUCTURAL exactly as it is everywhere else in `core/gate.ts`: the new function input interface carries no timestamp field, so there is no parameter to pass, and it reads the clock once per operation as `finishExecution` and `startHarnessExecution` do. A PostToolUse event may well carry a harness clock; the parser does not read it, for the same reason `parseHookInput` does not read the self-reported command description. And because the streak orders by seq, a caller timestamp could not steer the escalation even if one were accepted.

NEW CORE SURFACE. `finishHarnessExecution(logPath, input, actor, options)` in `core/gate.ts`, beside `startHarnessExecution` and `consumeHarnessGrant`, where the input names the session id, the tool-use id, the outcome and an optional exit code. It takes NO task and NO action key: it resolves every `delegated` start whose task is the harness task id for that session and tool-use id from the VERIFIED log (invariant 1) and appends one counterpart per key, each through compare-and-append with the head observed at that read (invariant 5). Legality, all fail-closed:
1. the named start must exist and its payload must carry the `harness` execution marker, otherwise refuse `not-delegated`, a new code in the refusal union, so a harness report can never close an `approval run` execution it does not own;
2. a key already settled, indeterminate or reconciled refuses `already-finished`, since an execution has exactly one outcome;
3. a partial close, some keys settled and some not, is left as-is: it over-counts failures and under-counts completions, both of which are the strict direction.

THE COUNTERPART AUTHORIZES NOTHING. It charges no budget (`core/budgets.ts` charges at grant and at execution start; a close charges nothing) and it grants no capability, so SPEC 11.1 invariant 8 does not bind it: an append that fails is reported and blocks nothing, and the start stays `delegated`. PostToolUse cannot deny a tool call anyway.

UNREADABLE OUTCOME MEANS APPEND NOTHING. The one thing the design needs from the event is whether this tool call failed, and the Claude Code tool-response shape is tool-specific. So the verb reads a CLOSED, pinned set of readings and treats everything else as unreadable, appending neither outcome. Stated affirmatively: recording a failure nobody observed trips escalation on noise, and a control that trips on noise is one operators learn to silence (SPEC 8 makes exactly this argument about timestamp anomalies); recording a completion nobody observed clears a streak on nothing, which invariant 4 forbids outright. Appending nothing leaves the path exactly as vacuous as it is today for that tool and manufactures neither a failure nor a clearance. AC2 MUST pin the field names against a CAPTURED real PostToolUse event rather than guess them; until one is pinned the verb appends nothing, so nothing regresses.

INSTALL DELTA AND A LIVE FOOTGUN. One verb, dispatching on the hook event name from stdin, registered in `.claude/settings.json` under both PreToolUse and PostToolUse. `parseHookInput` does NOT read the hook event name today (verified: no such read exists in hook.ts) and `runHarnessHook` assumes PreToolUse unconditionally, so an operator who adds a PostToolUse matcher to the CURRENT binary would gate every command a second time and double every Telegram prompt. AC2 must read and branch on the hook event name FIRST, and treat an unrecognized event as a no-op that appends nothing.

AC1 DESIGN — CHUNK 4 of 7: WHAT THE GUARD REFUSES — ESCALATE TO MANUAL, NOT DENY

Today `unattendedGuard` returns a hook-gate-refused verdict carrying `loop-escalated`, which is a DENY. That is a dead end once the streak can actually accrue: the only thing that clears a streak is an `execution.completed`, and under a deny nothing ever executes to complete. It also contradicts the documented property of `core/loop.ts` itself, that escalation is a floor and never a ban, and that the manual actions of an escalated task still request, still grant, and still execute (verified: that wording is in the module header near line 37). The harness path cannot honour it, because a class the policy calls autonomous has no manual sibling to fall back to.

THE REMEDY: A FLOOR. When either streak is tripped, the hook treats every class of the command as `manual` FOR THIS INVOCATION: it registers, requests, waits, and the human tap authorizes it, by the ordinary `gateAndWait` path, unchanged. Loop escalation becomes a second floor applied after class resolution, exactly like the SPEC 7 irreversibility floor, and SPEC 7 already requires the decision trace to record when a floor rather than the matched rule decided. The floor is applied at the enforcement sites and NOT inside the `resolve` function of `policy-match.ts`, because `resolve` is pure over policy text and loop state is a log projection.

NARROWNESS — IT ONLY BITES WHERE THE COMMAND WOULD OTHERWISE PROCEED. A class that already resolves `manual` is untouched. A command all of whose classes are manual takes the path it takes today. A mixed command manual classes are unchanged and only its would-have-proceeded classes are lifted. This is the identical property gate.request already states where it declines to refuse the manual half of a mixed command.

SEAM. request() already has a fall-through door into the manual path for an action the APRV-127 live draw selected (verified in gate.ts near lines 1266 to 1276, where an undeclared action falls through and is treated as manual from that point). The floor uses the same door: request() gains a third way in, namely resolved manual, or selected by the live draw, or floored by loop escalation, and the intake `loop-escalated` refusal is replaced by that fall-through. The CODE stays in the refusal union, which invariant 6 freezes, because `startHarnessExecution` still emits it, and its check should be WIDENED to the same session and actor scopes, so the write boundary refuses an escalated unattended start even if a caller reaches it without asking the hook first. Belt and braces, the same split `core/execute.ts` already documents. The behaviour of `approval run` is unchanged by this design.

AC1 DESIGN — CHUNK 5 of 7: WHAT AN OPERATOR SEES

`approval status --json`, additive to the existing loop escalations array (built in `src/cli/execute.ts`, currently near line 1145): each entry keeps its task, its consecutive-failure count and its escalated flag, and gains a `scope` field reading `task`, `session` or `actor`. The task field carries the scope key, either `hook:` plus the session id or the actor identity, so it stays a non-empty string an operator can grep the log for, and pre-existing consumers read the same three fields unchanged. Escalations still count against the healthy verdict and the exit code.

Human table (the row name at execute.ts near line 1241 is kept):

    loop escalations   2
      hook:0f3c9a (3 consecutive failed tool calls, session) — escalated to manual
      agent:claude-code (3 consecutive failed tool calls, actor) — escalated to manual

Plus one new INFORMATIONAL row, because the fail-closed append-nothing rule is otherwise invisible:

    harness outcomes   1420 started, 1398 reported, 22 unreported

Coverage moves no health verdict and no exit code, for the reason the timestamp anomalies row moves neither (execute.ts near line 1178): it is a coverage measurement, not an integrity verdict. A persistently high unreported count is how an operator learns the PostToolUse hook is not installed or not firing.

`approval doctor` gains one check in its existing shape of a check name, a status, a detail and a fix:
- check: harness hook outcome reporting
- status: fail
- detail: `.claude/settings.json` registers `approval hook claude-code` for PreToolUse and not for PostToolUse, so no tool call reports an outcome and loop escalation (SPEC 10.2) cannot accrue on this path
- fix: `approval instructions hook` — prints the PostToolUse entry to add to `.claude/settings.json`, which a human commits, since it is `policy.edit`

The status is `skip` when there is no `.claude/settings.json`, meaning this is not a Claude Code checkout. The fix begins with `approval `, which is in the pinned fix-command prefix list (verified at `src/cli/doctor.ts` line 149), and doctor still repairs nothing.

AC1 DESIGN — CHUNK 6 of 7: THE ATTACK, ANSWERED (SPEC 11.1 INVARIANT 4)

The signal is self-reported by the harness side, so it is bounded in one direction only.

IT MAY RAISE SCRUTINY. A reported failure accrues the streak and costs its author capability: the next command from that author goes to a human. That is the safe direction and the only direction the report moves anything by itself. An agent that spams false failures escalates only itself, and every false report is a permanent record in a log nobody can rewrite.

ABSENCE NEVER CLEARS. This is the load-bearing rule and it is the existing rule of `core/loop.ts`, deliberately not widened: an accrued streak is cleared by an `execution.completed` in the same scope and by nothing else. A hook timeout, a deny, a fresh tool call, a granted approval, a restarted hook process, a rolled log, and elapsed time all leave it where they found it. Silence is not evidence of recovery.

A LYING COMPLETION BUYS NOTHING. An agent that reports a completion it did not earn does clear its own streak. It gains nothing by that lie which silence would not have given it for free, because a failure it simply omits never accrues in the first place. The completion path therefore grants no capability beyond the do-nothing path, and it is strictly more expensive: omission leaves no record, while a false completion leaves a permanent positive assertion bound to an actor and to the content binding of the start, which the retrospective sampler can draw.

STATED AS PLAINLY AS SPEC 11 STATES THE REST: this catches the honest loop and does not catch a liar, exactly as SPEC 7 says of the irreversibility floor, that it is a floor and not a proof. What answers the liar is the class rule, a class the operator writes as manual that no declaration can loosen, plus the actor-scoped streak, which no rotation of the session id can escape.

INVARIANTS TOUCHED (SPEC 11.1, implicit acceptance criteria)
1 (verified records only): the counterpart resolves its task and key from the verified log, and both guards keep reading verified records.
2 (no caller timestamps): answered structurally in chunk 3.
3 (no raw secrets): no tool output text in the record, closed codes only.
4 (self-report never reduces scrutiny): the whole of this chunk, plus the actor-scoped backstop and the derived-not-declared scope.
5 (compare-and-append): every counterpart append passes the head observed at its authorizing read.
6 (frozen refusal unions): the gate refusal union gains `not-delegated`, and `loop-escalated` is retained.

FILES AC2 WOULD TOUCH
`src/core/loop.ts` (harness projection and scope derivation), `src/core/gate.ts` (the new finish function, the floor fall-through in request, widened scope in `startHarnessExecution`, the `not-delegated` code), `src/cli/hook.ts` (hook-event-name dispatch, PostToolUse handler, the `unattendedGuard` remedy), `src/cli/execute.ts` (status rows), `src/cli/doctor.ts` (one check), `tests/loop.test.ts`, `tests/cli-hook.test.ts`, `tests/gate.test.ts`, and the gate-verdict vectors under `conformance/`.

AC1 DESIGN — CHUNK 7 of 7: REVIEW AGAINST CURRENT MAIN, AND WHAT NEEDS SIGN-OFF

Reviewed at origin/main e31ffff (Merge PR #135, policy-amend-1056). Every symbol the design names exists; the line numbers in the original draft had drifted and are refreshed by symbol throughout chunks 1 to 6. Two claims needed correcting and one carries a live collision.

CORRECTION A — APRV-146 HAS NOT LANDED. It was described to this lane as merged. It is not: commit cf6c393 lives only on `origin/aprv-146-harness-binding` and PR #145 is still OPEN. There is no `execution-delegated` code anywhere in `src/` on main, and `startHarnessExecution` on main appends no content binding. So every APRV-146-dependent statement is ANTICIPATORY, not current fact.

COLLISION — APRV-146 AND THE COUNTERPART OF CHUNK 3 ARGUE AGAINST EACH OTHER. This is the one thing AC2 must not discover late. APRV-146 makes `openExecution` refuse a new code, `execution-delegated`, over any start carrying the `harness` execution marker, so that `finishExecution`, `resolveExecution` and the reconcile verb can no longer close a delegated start. Its refusal message states the rationale explicitly: no outcome may be written over such a record, because a completed or failed recorded there would report an exit code nobody watched, AND an `execution.completed` would additionally clear the loop-escalation streak of the task, citing SPEC 10.2. That is a direct normative argument against precisely the mechanism chunk 3 proposes. The design is not mechanically blocked, because chunk 3 appends through a NEW surface, `finishHarnessExecution`, rather than through `openExecution`. But it cannot be built as if the tension were absent. AC2 must reconcile the two before writing code, and the reconciliation is a human call: either APRV-146 blanket refusal gains a narrow carve-out for the PostToolUse counterpart (the counterpart is the case APRV-146 rationale did not consider, since it closes the record with a marked, untrusted-side report rather than with a runtime observation), or the counterpart is dead on arrival and AC1 signal design must be reopened. Land AC2 only after PR #145 merges and this is settled.

CORRECTION B — FINDING 7 OF THE DRAFT IS TRUE TODAY AND FALSE SOON. The draft observed that `openExecution` (execute.ts, currently near line 868) does not filter on custody, so `approval execution resolve` against a harness action key already closes a delegated start by hand. That is correct against main today, and APRV-146 is exactly the change that removes it. Do not build on it.

INTERACTION WITH SPEC 11.1 INVARIANT 1. The drafted amendment and invariant 1 DO touch, and the touch is compatible. Invariant 1 already carries an APRV-139 pending-sign-off scope note naming the harness hooks and requiring that a hook verdict letting a command run with no human in the loop MUST verify policy attestation AND LOOP-ESCALATION against the verified log, failing closed when it cannot reach the log. The amendment in this task supplies what that clause presupposes but does not define: a scope at which loop escalation can actually accrue on that surface. Invariant 1 needs no edit. Worth stating in review that APRV-139 wrote the obligation and APRV-145 makes it non-vacuous.

CONFIRMED AGAINST MAIN, NOT DROPPED: the per-tool-call task id and its random fallback; the two `isLoopEscalated` call sites; the reset-on-completed and threshold-of-three projection; the `unknown-session` default; the `--as agent:claude-code` identity fixed in `.claude/settings.json` line 9; the terminal `delegated` custody state; the pinned fix-command prefix list; the unique SPEC anchor. The live footgun of chunk 3 is confirmed: nothing in hook.ts reads the hook event name.

FINDING, STILL LIVE, WORTH ITS OWN TASK: `docs/claude-code-hook.md` lines 406 to 410 assert that the hook writes no execution records and that what it records is the approval lifecycle only. APRV-141 falsified that; hook.ts line 1062 calls `startHarnessExecution`. The same paragraph does already name a PostToolUse companion as future work and does already flag that its report comes from the untrusted side, which anticipates this design rather than contradicting it. The stale sentence should be corrected regardless of AC2.

DESIGN DECISIONS NEEDING CARTER SIGN-OFF, each a genuine choice:
1. The remedy changes from DENY to ESCALATE-TO-MANUAL. Strictly weaker than the current `unattendedGuard` behaviour, and deliberate: SPEC 10.2 is normative that escalation is to manual, and `core/loop.ts` states escalation is a floor and never a ban. Under the current deny an escalated session has no way back. Keeping the deny is a one-line divergence and the rest of the design is unaffected.
2. The SECOND, actor-scoped streak is an addition beyond the brief, which named only the session. It exists because the session id is authored by the party under oversight, so a session-only streak is clearable by rotating one string, which invariant 4 forbids. It is wider than the SPEC 10.2 phrase for one task. Drop it and the design still works, with rotation as a free and undetected escape.
3. Reusing the existing completed and failed event types rather than minting a new one. Cheaper for every verifier and it lets `executionCustody` flip `delegated` to `settled` truthfully, but a harness-reported outcome and a runtime-observed one then share a type and are told apart only by `reported_by` plus the `harness` marker. Note this is the decision APRV-146 pushes back on hardest.
4. The gate refusal union gains `not-delegated`. Invariant 6 makes a union widening a spec change; the union is pinned by `tests/gate.test.ts` and by the conformance gate-verdict vectors. PR #134 (APRV-147) has already merged, so that conflict is cleared; PR #145 is the one to sequence behind.

AC2 IS NOT STARTED AND NO ACCEPTANCE CRITERIA ARE CHECKED. No runtime code was changed by this task.

AC1 LANDED — SPEC EDIT AND VERIFICATION

The SPEC 10.2 amendment of the design was applied as ONE batched edit and committed as e81aa05 on branch `aprv-145-design` (based on origin/main e31ffff). Five paragraphs, all flagged (Amended APRV-145, pending sign-off.), INSERTED immediately before the `### 10.3 Channels` heading, which was verified unique in the file, so no existing byte of section 10.2 changed. The diff is 10 insertions in `SPEC.md` and nothing else; the commit carries the SPEC edit alone.

The edit was not refused by the gate and needed no retry. `approval hook classify` reports Edit of SPEC.md as unclassified rather than as `policy.edit`, which is worth noting: the original draft predicted a manual-class Telegram prompt and none was raised.

Verification: `npm ci` clean, `npm run build` clean, `node --test dist/tests/docs-guard.test.js` 6 of 6 passing, and the full `npm test` suite 2304 of 2304 passing with 0 failures.

NOT DONE, deliberately: AC2 is unbuilt, no acceptance criteria are checked, the task is not moved to a terminal status, and nothing was pushed and no PR was opened. The next actor should read chunk 7 before starting AC2, in particular the APRV-146 collision and the four decisions needing sign-off.

AC1 landed: the SPEC 10.2 design amendment merged as PR #149 (main fcc2125), five paragraphs flagged pending sign-off, committed through a granted policy.edit (replacing an earlier ungated application of the same bytes, tracked as APRV-151). RECONCILIATION DECISION 2026-08-29 (Carter, in session): the completion counterpart reconciles with APRV-146 execution-delegated via the NARROW CARVE-OUT as drafted — the three human recovery verbs keep refusing execution-delegated exactly as merged, and the counterpart is a separate marked surface accepting only harness-reported outcomes for harness-marked starts (task and key resolved from the verified log, reported_by from a closed set, invariant-4 one-directional: a reported failure accrues, only a completion in the same scope clears). The alternative (a new non-execution event type feeding the streak) was considered and declined for its permanent schema surface. AC2 (the build) is now unblocked on this design; when it builds, the execution-delegated refusal doc gains the except-by-the-marked-counterpart clause.

AC2 BUILT - branch aprv-145-streak, one commit db5f932, based on origin/main 8d3b76e. Not pushed, no PR, no acceptance criteria checked, status unchanged.

WHAT THE POST-TOOL-USE CONTRACT ACTUALLY CARRIES, and how the outcome is derived. Established against the official Claude Code hooks reference before any code was written, because chunk 3 of the design required pinning rather than guessing. The event carries session_id, transcript_path, cwd, permission_mode, hook_event_name, tool_name, tool_input, tool_use_id and tool_response; the first eight are shared with PreToolUse and tool_response is the one field only the post-execution events carry. tool_response is ALWAYS an object, never a bare string, shaped as a type field of text, error or base64 plus the matching text, error or base64 member. THERE IS NO EXIT CODE ANYWHERE IN THE EVENT, for Bash or for any other tool, and this is not an oversight of the docs: a tool call that failed outright fires a SEPARATE event, PostToolUseFailure, instead of PostToolUse. So the closed reading set is exactly three cases - a type of text or base64 is a completion, a type of error is a failure, and the PostToolUseFailure event is a failure whatever its response says - and everything else (no tool_response, a non-object one, an unknown type) is UNREADABLE and appends nothing. exit_code is therefore always null on this adapter, which is why the schema constrains it to integer-or-null rather than to a number. A post-execution hook cannot block anything, so the verb prints an empty stdout and exits 0 on every path, and its refusals go to stderr as one JSON line under a closed POST_TOOL_CODES vocabulary.

PER PIECE. (1) The counterpart: core/gate.ts finishHarnessExecution, its own function, reached only from the hook. It takes a session id and a tool-use id, reconstructs the task the pre-execution run minted, and reads the starts for that task out of the VERIFIED log; it refuses not-delegated when the task started nothing or when nothing it started carries the harness marker, already-finished when every delegated key is closed, and appends one counterpart per still-open key with a fresh read and a fresh head each time. Payload is exactly three fields: the harness marker, reported_by from a closed set holding only post-tool-use, and exit_code. No attestation is required and no budget is charged, deliberately: the counterpart authorizes nothing, and a failure report an unattested policy could block would be a self-report lowering scrutiny by omission. (2) Accrual and the floor: core/loop.ts gained harnessLoopEscalation and harnessLoopFloor; cli/hook.ts computes the floor from the verified log after class resolution and, when either scope is at three, routes every class through gateAndWait. That needed a third door into the manual path, so RequestInput gained loopFloor, which skips the non-manual branch exactly as an APRV-127 live draw does - nothing below that line knows how the action arrived. startHarnessExecution re-checks both scopes at the write boundary, so a caller that reaches it without asking the hook is refused loop-escalated. (3) Surfaces: status loop_escalations entries keep task, consecutive_failures and escalated and gain scope of task, session or actor, with the harness scopes reporting their key in the task field so it stays greppable; a new informational harness_outcomes object and human row report started, reported and unreported and move neither healthy nor the exit code. doctor gained harness-hook-outcomes, appended last, reading .claude/settings.json and never writing it: fail when an approval hook entry exists for PreToolUse and not for a post-execution event, pass when both, skip when the file is absent, unparseable, or registers no approval hook at all. (4) Schema: one additive if/then on execution.completed and execution.failed constraining reported_by to the closed set, the execution marker to the harness constant and exit_code to integer-or-null; two valid fixtures and two invalid ones (an open reported_by carrying a credential-shaped string, a stringy exit code). (5) Tests, every record through the real CLI: the defect pin asserts that three failed tool calls escalate NO task and both harness scopes, accrual and escalation at each scope, the rotated-session actor backstop, the shared unknown-session bucket, clear-on-completed, the counterpart happy path with the tool output text absent from the log, error and PostToolUseFailure both recording a failure, every refusal (not-delegated for no start and for an unmarked start, already-finished, unreadable outcome across four shapes, no tool-use id, ungated tool, non-principal actor), the invariant-4 one-directionality (a completion report that closes nothing appends nothing and leaves the streak standing), the unknown-event-name strict direction, and the status and doctor surfaces.

INVARIANTS TOUCHED (SPEC 11.1). 1, enforcement paths read only verified records: the counterpart and the floor both read readVerifiedRecords / readGateRecords, and the counterpart resolves task and key from those records rather than from the report. 2, no caller timestamps on gate-typed events: structural, HarnessFinishInput has no timestamp field and the clock is read at the write boundary; a harness clock on the event is never parsed. 3, no raw secrets: none of tool_response text, error or base64 reaches the record, and reported_by is a closed code - the invalid fixture is exactly a credential-shaped string in that field. 4, self-reported fields never reduce scrutiny: the load-bearing one. Both scope keys are DERIVED (the session from the task id the runtime minted, the actor from the process identity), so no input names its own bucket; a reported failure accrues and only a completion in the same scope clears; a report that closes nothing appends nothing, which is pinned. 5, compare-and-append: every counterpart append carries the head of the read that judged the key delegated and open, and the loop re-reads per record rather than reusing one head. 6, frozen refusal unions: gate_refusal_codes gained not-delegated and already-finished, pinned in tests/gate.test.ts and regenerated into refusal-unions 5.0.0. 7, refusals machine-readable and distinct: the two new gate codes plus the closed POST_TOOL_CODES on the hook side. 8 does not bind the counterpart: it authorizes nothing and charges nothing, so an append that fails blocks nothing and leaves the start delegated.

DIVERGENCES FROM THE AC1 DESIGN, each deliberate. (a) The design named ONE new gate code, not-delegated. The build adds a second, already-finished, because a second report over a settled key is a different fact from an unowned one and the design chunk 3 already required refusing it - it just did not name the code. (b) The design proposed a new hook deny code, session-loop-escalated. The build has none, because the merged SPEC paragraph settles the remedy as a FLOOR rather than a deny: nothing is refused, the command is routed to the human, so there is no new deny to name. (c) The design left the dispatch as recognise-post-or-no-op. The build treats an unrecognised event name (and an absent one) as the PRE-execution path instead, which is the strict direction: an event this runtime cannot name is a harness about to run a command, and a no-op there would be an ungated one. Pinned by a test. (d) The design put the floor note only in the deny text; the build puts it in the verdict reason on every path, which is the decision trace SPEC 10.2 requires, and it is the way core/execute.ts already names the section 7 irreversibility floor beside a resolution provenance. (e) A cost the design did not price: the floor adds one verified log read per gated tool call, on top of the two the hook already performs. Worth revisiting if the section 13 fast path ever lands.

PROPOSED SPEC CORRECTION, NOT APPLIED (no SPEC edit was made by this task). Section 11.2 gate_refusal_codes is a registry table and now omits two codes the runtime can produce. The proposed rows, verbatim, to be inserted after the loop-escalated row:

| not-delegated | A harness outcome was reported for an action key whose execution.started carries no harness execution marker, or for a task that started nothing at all. The mirror of execute_refusal_codes execution-delegated: that code refuses a human recovery verb over a harness start, this one refuses a harness report over an execution the runtime is watching itself. Nothing is appended. |
| already-finished | Every delegated execution the reported tool call opened already carries an outcome. An execution has exactly one, and a second report would be a streak cleared by repetition rather than by recovery. |

Also worth a separate task, unchanged from the AC1 finding: docs/claude-code-hook.md said the hook writes no execution records, which APRV-141 had already falsified. That paragraph is corrected in this commit as part of the install runbook the counterpart needs.

VERIFICATION at db5f932: npm test 2401 of 2401 passing, 0 failing; npm run conformance 232 of 232 vectors, 106 negative controls, manifest ok; npm run lint clean. The two conformance suites that moved are refusal-unions (4.0.0 to 5.0.0, a union grew) and schema-validation (1.1.0 to 1.2.0, four vectors added and no expectation moved), both recorded in the regen script and in conformance/README.md.

AC2 merged: PR #151 as main 75cef01 through the merge queue, built to the merged 10.2 design under the recorded narrow-carve-out decision. Evidence: finishHarnessExecution is its own marked surface (task/keys from the verified log, not-delegated for unmarked starts, already-finished for settled ones, reported_by closed, no tool text, ts at the write boundary) and the three human recovery verbs kept refusing execution-delegated byte-for-byte; the hook reads hook_event_name at last and dispatches PostToolUse/PostToolUseFailure with outcomes drawn from a pinned three-case reading of the actual hooks contract (no exit code exists in any hook event; unreadable outcomes append nothing; an unrecognized event name takes the stricter pre-execution path, pinned); streaks count tool calls at the session scope (derived from the runtime-minted task-id prefix) and the actor backstop, unreadable sessions share one bucket, either scope at three consecutive failures floors would-have-proceeded classes to manual after class resolution with the floor named in the verdict, cleared only by a same-scope completion; status gains scoped escalation rows and the informational coverage row, doctor fails harness-hook-outcomes on PreToolUse-only wiring; schema additions are additive with fixtures, refusal-unions at 5.0.0, and the 11.2 registry gained the two new codes rows in the same PR so the registry stays complete against the shipped union. Verified twice independently: 2401/2401 tests, conformance 232/232 with 106 controls, lint clean. Invariants touched: 1, 2, 3, 4 (load-bearing), 5, 6, 7; 8 does not bind the counterpart. Deliberate divergences from AC1 prose recorded by the builder: the second refusal code already-finished (the design named the fact, no code), no separate deny code (the merged SPEC settles the remedy as a floor), and one extra verified log read per gated tool call as the floor cost.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Harness loop safety is real: the hook now learns outcomes through the PostToolUse counterpart (its own marked gate surface; human recovery verbs untouched), failures accrue per session and per actor in tool calls, three consecutive failures floor the session to the human gate, and only a genuine completion clears. Design merged as PR #149, mechanism as PR #151 (main 75cef01); verified 2401/2401, conformance 232/232, lint clean, twice independently.
<!-- SECTION:FINAL_SUMMARY:END -->
