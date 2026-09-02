---
id: APRV-211
title: >-
  Daemon advance re-asks every tick: a gated advance must adopt its open
  request, not mint a new key
status: In Progress
assignee:
  - 'agent:opus-lane-w'
created_date: '2026-09-02 09:05'
updated_date: '2026-09-02 09:23'
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
- [ ] #1 A gated advance tick followed by N further ticks with the request still live produces exactly one approval.requested, proven by a test with a stubbed human that never answers
- [ ] #2 A grant on the open request authorises one advance on the next tick; a rejection is honoured and no new request is minted until the owed span changes
- [ ] #3 An advance that fails records the verb's refusal code and message on the advance DaemonEvent and the log-advance-cadence doctor row; the failure observed on 2026-09-02 (execution.failed exit 1 at seq 10186) is reproduced or explained in the notes
- [ ] #4 The payload hash still changes when the owed span changes, so a supervised-live draw is per distinct advance and never re-rolled for the same span
- [ ] #5 npm test passes; lint clean
- [ ] #6 No execution token is printed for a daemon-minted action: a grant on one via a stubbed channel leaves no 64-hex token on stdout or stderr
- [ ] #7 A callback arriving while an advance is in flight is answered within 1 s (stubbed Bot API, advance stub that blocks for 5 s); the advance runs off the channel loop
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
<!-- SECTION:NOTES:END -->
