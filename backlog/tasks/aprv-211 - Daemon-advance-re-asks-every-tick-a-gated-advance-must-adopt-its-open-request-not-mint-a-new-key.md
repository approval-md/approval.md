---
id: APRV-211
title: >-
  Daemon advance re-asks every tick: a gated advance must adopt its open
  request, not mint a new key
status: To Do
assignee: []
created_date: '2026-09-02 09:05'
updated_date: '2026-09-02 09:08'
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Two more defects from Carter's terminal transcript (2026-09-02, approval up --advance): (1) when a daemon-minted advance request was granted via Telegram, the channel printed the raw execution token to the terminal ('single-use, stored nowhere, not sent to Telegram, copy it now'), the APRV-166 relay path meant for an external requester; the daemon IS the requester, in the same process, and must consume its own grant (register with its own sealed-delivery key, or take the in-process grant path) so no token is ever printed for a daemon-minted action. (2) repeated 'telegram could not answer a callback (answerCallbackQuery: HTTP 400)' around the grants: Telegram refuses to answer a callback that sat too long, and the advance runs synchronously on the same loop as the channel (git fetch, scratch-index commit, push, gh pr create), so taps arriving while an advance runs are answered after Telegram's window and get no toast. The advance must run off the channel loop (a child process or an async task the poll loop does not await), with the loop answering callbacks within the window regardless of what the daemon is doing. Add ACs: no token is printed for a daemon-minted action, proven by a test that grants one via a stubbed channel and asserts stdout carries no 64-hex token; a callback arriving during an in-flight advance is answered within 1 s in a test with a stubbed Bot API and an advance stub that blocks for 5 s.
<!-- SECTION:NOTES:END -->
