---
id: APRV-211
title: >-
  Daemon advance re-asks every tick: a gated advance must adopt its open
  request, not mint a new key
status: Done
assignee:
  - 'agent:opus-lane-w'
created_date: '2026-09-02 09:05'
updated_date: '2026-09-02 19:43'
labels:
  - daemon
  - bug
dependencies: []
priority: high
ordinal: 174000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-02 on the primary log after Carter ran approval up --advance: the daemon registered and requested log.advance three times in a row (seq 10167/10168, 10172/10173, 10175/10176), each with a new idempotency key daemon-log-advance-1-<seq>, so the human got three questions for one owed advance; APRV-204 notes claim a gated tick leaves its request open and retries next tick, but the key includes the head seq, which moves with every tick, so every tick is a new question. Two later ticks then proceeded without a decision (10180/10181 executed; 10184/10185 executed and 10186 execution.failed exit 1), which is the live draw working in the daemon process, where the launch environment carries the sampling secret. Outcome: while a daemon-minted advance request is live (requested, undecided, unexpired), the next tick adopts it (waits on or re-checks that key) rather than registering another; the key is stable across ticks for the same owed span, or the daemon keys on the open request rather than the head; a decision on the open request authorises exactly one advance. Separately, the failed advance must be explained on the daemon status surface: capture the verb's refusal code and message in the advance DaemonEvent and doctor row (exit 1 with no reason is not a report). Why: the daemon cadence exists to remove taps, not multiply them.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A gated advance tick followed by N further ticks with the request still live produces exactly one approval.requested, proven by a test with a stubbed human that never answers
- [x] #2 A grant on the open request authorises one advance on the next tick; a rejection is honoured and no new request is minted until the owed span changes
- [x] #3 An advance that fails records the verb's refusal code and message on the advance DaemonEvent and the log-advance-cadence doctor row; the failure observed on 2026-09-02 (execution.failed exit 1 at seq 10186) is reproduced or explained in the notes
- [x] #4 The payload hash still changes when the owed span changes, so a supervised-live draw is per distinct advance and never re-rolled for the same span
- [x] #5 npm test passes; lint clean
- [x] #6 No execution token is printed for a daemon-minted action: a grant on one via a stubbed channel leaves no 64-hex token on stdout or stderr
- [x] #7 A callback arriving while an advance is in flight is answered within 1 s (stubbed Bot API, advance stub that blocks for 5 s); the advance runs off the channel loop
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. REPRODUCE (tests first, red): (a) three daemon ticks under POLICY_MANUAL with nobody answering yield three approval.requested; (b) a grant on a daemon-minted action through the real recordChannelDecision + the Telegram handler prints a 64-hex token on stdout; (c) a callback arriving while the advance's git side effect runs is answered only after it finishes.
2. STABLE OWED SPAN. publishedState gains substantiveSeq: the highest unpublished seq that is not advance bookkeeping (publishedSeq when none). advanceTaskId/advanceActionKey key on it instead of workingSeq, so a tick that appended only the daemon's own bookkeeping computes the SAME key and the SAME payload hash. The span is still in the hash, so a changed span is still a different action (AC4).
3. ADOPT, NEVER RE-MINT. core/advance-cycle.ts gains openAdvanceRequest(records, ts, ttlMs): the latest daemon-log-advance-* key with its derived RequestState. attemptAdvance consults it before register/request: state requested -> outcome gated, adopt, append nothing; state granted and unexecuted -> skip register/request entirely and go straight to startExecution on THAT key with its declared payload hash (one advance per decision, single-use enforced by execution.started); state rejected/revoked/withdrawn/expired on the CURRENT owed key -> outcome refused, code advance-decided, no re-ask until the span changes.
4. NO TOKEN FOR A DAEMON-MINTED ACTION. RequestInput gains delivery?: 'self'. request() mints the recipient keypair for it regardless of defaults.token_delivery and records delivery: 'self' on approval.requested; a key that cannot be written refuses the request (fail closed - a self-delivered grant nobody can open is a dead authorisation). decide() withholds the raw token from its own result when the request declared delivery: 'self', so no granting surface has a token to print. The daemon opens the seal in-process through startExecution's existing APRV-105 keyStoreDir path.
5. OFF THE CHANNEL LOOP. attemptAdvance splits into authorizeAdvance (pure gate work, fast, in-process, keeps the sampling secret) / runAdvanceSync (logAdvance in-process, used by the shutdown flush, which must stay synchronous) / runAdvanceAsync (a child process running logAdvance under the APRV-205 child env, awaited by nobody in the tick) / recordFinish (shared). The daemon holds one in-flight slot: a tick with an advance in flight makes no attempt at all, and the advance DaemonEvent is emitted when the child settles.
6. FAILURE CARRIES ITS REASON. finishExecution takes an optional reason {code, message} and records it on execution.failed (payload shape is open in event.schema.json; no schema change). lastAdvance surfaces it and the log-advance-cadence doctor row prints it, so exit 1 with no reason cannot happen again. Reproduce the 2026-09-02 failure shape against a scratch remote whose day records branch already carries foreign history.
7. Tests, lint, build, full npm test with counts; notes; SPEC 10.1/10.2 draft wording in the notes flagged pending sign-off.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Two more defects from Carter's terminal transcript (2026-09-02, approval up --advance): (1) when a daemon-minted advance request was granted via Telegram, the channel printed the raw execution token to the terminal ('single-use, stored nowhere, not sent to Telegram, copy it now'), the APRV-166 relay path meant for an external requester; the daemon IS the requester, in the same process, and must consume its own grant (register with its own sealed-delivery key, or take the in-process grant path) so no token is ever printed for a daemon-minted action. (2) repeated 'telegram could not answer a callback (answerCallbackQuery: HTTP 400)' around the grants: Telegram refuses to answer a callback that sat too long, and the advance runs synchronously on the same loop as the channel (git fetch, scratch-index commit, push, gh pr create), so taps arriving while an advance runs are answered after Telegram's window and get no toast. The advance must run off the channel loop (a child process or an async task the poll loop does not await), with the loop answering callbacks within the window regardless of what the daemon is doing. Add ACs: no token is printed for a daemon-minted action, proven by a test that grants one via a stubbed channel and asserts stdout carries no 64-hex token; a callback arriving during an in-flight advance is answered within 1 s in a test with a stubbed Bot API and an advance stub that blocks for 5 s.

STATUS 2026-09-02 (opus-lane-w, paused mid-task by the fleet operator; nothing is finished and nothing is verified).

DONE — reproduced, red, in tests/daemon-advance-adopt.test.ts (a new file, real git topology + stubbed gh, no hand-written log lines): three gated daemon ticks over ONE owed advance open THREE approval.requested (daemon-log-advance-2-2, -2-5, -2-7 — the key moves because it embeds the head and the daemon's own bookkeeping moves the head); decide() on a daemon-minted action returns a raw execution token to the granting surface, which is what the Telegram listener printed; a grant does not authorise the next tick's advance at all, because that tick mints a new key rather than adopting the granted one. Five of the six cases in that file are red and one (the failure-reason case) currently passes only vacuously, guarded by an if.

DONE — partial implementation, unbuilt and untested:
- src/cli/log-advance.ts: PublishedState gains substantiveSeq, the highest unpublished seq that is not advance bookkeeping (publishedSeq when none). This is the owed span's end, and it is stable across ticks that appended only the daemon's own records.
- src/core/advance-cycle.ts: new openAdvanceRequest(records, ts, ttlMs) returning the latest daemon-log-advance-* key with its derived RequestState, declared payload hash and whether an execution.started has spent it; it matches on the recorded class, not on the key prefix alone, so the daemon cannot be made to adopt somebody else's question. LastAdvance gains code/message.
- src/core/execute.ts: new FailureReason/FinishOptions; finishExecution records {code, message} on execution.failed only, and only when the caller states them.
- src/core/seal.ts: new SELF_DELIVERY_FIELD (token_delivery_self).
- src/core/gate.ts: RequestInput.delivery?: 'self'; request() mints the sealed delivery address for such a request regardless of defaults.token_delivery and refuses the new code token-delivery-unavailable when the private key cannot be written (fail closed).

NEXT, in order, none of it started:
1. decide(): withhold the raw token from DecideResult when the request declared token_delivery_self and the seal was written. That is the single choke point for AC6 — no granting surface can print a value it is never handed.
2. daemon/advance.ts: key the task id and idempotency key on substantiveSeq rather than workingSeq; consult openAdvanceRequest before register/request — state requested adopts (outcome gated, appends nothing), state granted and unspent goes straight to startExecution on THAT key with its declared hash, a terminal decision on the CURRENT owed key refuses with code advance-decided and re-asks nothing until the span changes.
3. Split attemptAdvance into authorizeAdvance / runAdvanceSync / runAdvanceAsync / recordFinish, so the shutdown flush keeps its synchronous path and the periodic tick spawns a child that runs logAdvance under the APRV-205 child env. The daemon holds one in-flight slot and emits the advance event when the child settles. The sampling secret must stay in the DAEMON process: the scrub strips APPROVAL_* from a child, so the gate work has to happen in-process and only the git side effect may move.
4. finishExecution call site passes the verb's refusal code/message; the log-advance-cadence doctor row prints them.
5. AC7's test is not written: a stubbed Bot API plus an advance stub blocking 5 s, asserting answerCallbackQuery lands within 1 s. A companion case with a SYNCHRONOUS 5 s runner is the pre-fix reproduction of the HTTP 400s.
6. tests/daemon-advance.test.ts has a case asserting that two gated ticks leave TWO approval.requested ('the retry did not open a second question' — the message and the assertion disagree). It encodes the bug and must be changed to 1. Flagging it rather than changing it quietly.

UNRUN: everything. No tsc, no lint, no npm test since the last edits. The tree does not necessarily compile — SELF_DELIVERY_FIELD is imported into gate.ts and written on the request payload, but decide() has not been touched.

DONE 2026-09-02 (opus-lane-w). Branch merged with origin/main first (49 commits behind; only this task file conflicted, resolved to the in-progress copy). Full npm test: 2994 tests, 2993 pass, 1 skipped, 0 fail. oxlint clean. Commits: 19b084f (adoption, self-delivery, off-loop split), dec7d10 (doctor row, AC7 test, the mis-encoded assertion), de8d1f5 (frozen refusal union + conformance vector), plus a docstring fix on DecisionOutcome.tokenIssued.

WHAT WAS DONE

1. Stable owed span. cli/log-advance.ts PublishedState.substantiveSeq (landed earlier) is now what daemon/advance.ts keys on: advanceTaskId(substantiveSeq) and advanceActionKey(publishedSeq+1, substantiveSeq), and the payload seq span ends there too. A tick that appended only its own bookkeeping computes the same key and the same hash, which is the whole defect: the key embedded the head, the head moved with the gated attempt own two records, so every tick was a new question.

2. Adoption. authorizeAdvance() reads core/advance-cycle.ts openAdvanceRequest() before it registers anything, aged against the policy TTL loaded here (loadPolicy; a policy that will not load gives ttl null, i.e. never expire, i.e. keep adopting and never re-ask — the strict direction). Four branches: state requested -> gated, code advance-open, nothing appended; state granted and unspent on the CURRENT key -> skip register/request entirely and startExecution on that key with the hash THAT request declared; terminal state on the current key -> refused, code advance-decided; granted-and-spent on the current key -> refused, code advance-spent.

3. No token for a daemon-minted action. The advance request declares delivery: "self" (RequestInput.delivery, landed earlier), and decide() now withholds the raw token from DecideResult when the request carried token_delivery_self AND the seal was written. One choke point, so no granting surface can print a value it is never handed; startExecution opens the seal in-process through the existing APRV-105 keyStoreDir path. CLI grant and the Telegram listener already guarded their token panels with `!== undefined`, so both simply print no panel.

4. Off the channel loop. attemptAdvance split into authorizeAdvance / runAdvanceSync / runAdvanceAsync / recordFinish. A periodic tick spawns src/daemon/advance-child.ts (node, one JSON argument, one JSON line back, childEnvironment() env) and returns to the loop; the daemon holds ONE in-flight slot and a tick that finds it taken makes no attempt. The gate work never leaves the daemon process, because the APRV-205 scrub strips APPROVAL_* and the supervised-live draw needs the sampling secret. The parent VALIDATES the child line and treats anything else as a failed advance with a machine-readable code.

5. Failure carries its reason. recordFinish passes the verb code/message to finishExecution (FinishOptions.reason, landed earlier), lastAdvance surfaces them, and the doctor log-advance-cadence row prints them.

DECISIONS WORTH ARGUING WITH

- An OPEN (undecided) question is adopted even when the owed span has grown behind it. A grant on it publishes the log as it stands, so a second question would be a second tap for work the first already covers. AC4 hash property is therefore tested across two DISTINCT spans (a rejection between them) rather than by piling records behind an open question, and the test says so in prose.
- granted-and-spent on an unchanged span refuses (advance-spent) rather than re-asking. A failed advance therefore waits for the next substantive record instead of putting the same question up again every tick — report, do not loop. The reason is on execution.failed and on the doctor row.
- --once uses the SYNCHRONOUS path, like the shutdown flush. A process that exits at the end of the tick cannot record an advance that settles afterwards, and every existing test drives the daemon that way.
- AdvanceInput.runner / DaemonOptions.advanceRunner is a test seam (tests/fixtures/advance/slow-advance.mjs holds a child open for 5s). Production always spawns daemon/advance-child.js.
- The AC3 reproduction is a SHAPE, not the live cause: seq 10186 recorded exit_code 1 and nothing else, so what actually failed cannot be recovered — which is the defect. The test fails the advance by making the remote unreachable between the decision and the run.
- tests/daemon-advance.test.ts asserted TWO approval.requested after two gated ticks under the message "the retry did not open a second question". The message was right and the number was the bug; it now asserts 1, with a comment saying why it read 2.
- The conformance regen script also wanted to pin APRV-214 six new gate-window schema fixtures (schema-validation.v1.json, +201 lines). Left out of this diff and restored to main version: not this task work. WORTH A FOLLOW-UP TASK — the vectors and the fixtures directory have drifted and nothing fails when they do.

GLOBAL INVARIANTS TOUCHED (SPEC 11.1)

- (1) enforcement reads only verified records: openAdvanceRequest is pure over the records the daemon already verified; it reads nothing itself.
- (2) no caller timestamps: unchanged; every append here still takes ts at the write boundary.
- (3) no raw secrets or tokens in the log: strengthened. A self-delivered grant now records only the token digest and the sealed blob, and the raw value reaches nothing but the requester process.
- (5) compare-and-append: unchanged. Adoption appends nothing; every append still goes through register/request/startExecution/finishExecution.
- (6) refusals machine-readable and distinct: three new codes — token-delivery-unavailable (gate union, pinned in tests/gate.test.ts and conformance/vectors/refusal-unions.v1.json) and the daemon-local advance-open / advance-decided / advance-spent / log-advance-child-unspawnable / log-advance-child-unreadable on AdvanceAttempt.code, which is a free-form reporting field rather than a frozen union.
- (9) no verb minting authority for human-only classes: untouched.

SPEC DRAFT, PENDING SIGN-OFF (behaviour that diverges from what 10.1/10.2 currently say; NOT applied — agents do not edit SPEC.md):
  "A request MAY declare self-delivery, which mints the sealed delivery address regardless of `defaults.token_delivery` and refuses `token-delivery-unavailable` when the private half cannot be written. A grant on such a request returns no raw token to the granting surface: the requester is a process that opens the seal itself, and a token printed on a terminal nobody will run the action from is a credential with no owner."
  "The daemon advance is authorized once per owed span. While a request for the current span is open, a tick adopts it and appends nothing; a grant on it authorises exactly one execution; a terminal answer on it is honoured until the owed span changes. The span the request declares ends at the last unpublished record that is not the advance own bookkeeping, and the advance publishes the log as it stands when the decision is spent."

UNRESOLVED / FOR THE ORCHESTRATOR
- The second SPEC sentence admits something worth Carter eye: the payload declares the owed span at ask time and the advance publishes whatever the log holds when it runs (this was true before APRV-211 too — the old key just moved with the head). If that binding must be exact, log.advance needs a --through-seq the payload can bind to.
- A daemon stopped while a child advance is in flight warns and leaves the execution open until the child settles; if the process does not outlive it, `approval status` shows a dangling execution. No auto-repair, deliberately.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Daemon advance keys on the owed span and adopts its open request (one question per span; grant authorises one advance, rejection honoured), the request self-delivers so no raw token is printed for a daemon-minted action (new fail-closed refusal token-delivery-unavailable, in the frozen union), and the git side effect runs in a scrubbed child off the channel loop so callbacks answer within 1 s. Failure reasons land on execution.failed and the doctor row. Verified by tests/daemon-advance-adopt.test.ts (7) and the full suite 2993/0/1 skip, lint clean; merged in PR #235.
<!-- SECTION:FINAL_SUMMARY:END -->
