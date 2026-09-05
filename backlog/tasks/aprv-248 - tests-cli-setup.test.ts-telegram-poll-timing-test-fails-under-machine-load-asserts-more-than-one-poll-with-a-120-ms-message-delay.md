---
id: APRV-248
title: >-
  tests/cli-setup.test.ts telegram poll-timing test fails under machine load:
  asserts more than one poll with a 120 ms message delay
status: In Progress
assignee:
  - 'agent:opus-lane-k'
created_date: '2026-09-02 22:12'
updated_date: '2026-09-04 23:33'
labels:
  - test
dependencies: []
priority: medium
ordinal: 193000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Seen by the APRV-228 and APRV-225 lanes on 2026-09-02: the cli-setup telegram case 'message sent after the first poll' queues the human's message 120 ms after the verb starts and asserts polls.length is greater than 1; on a loaded machine the first poll itself lands after 120 ms, finds the message, and the assertion fails, while the test passes in isolation. tests/telegram-tap-latency.test.ts has the same shape (latency bounds that hold only on an idle box). Outcome: timing-shaped tests drive the clock or the poll sequence deterministically (inject the poll schedule or a fake timer; assert on the sequence of polls observed, not on wall-clock ordering) so they pass at any load; where a real latency bound is the point (tap latency), it runs as a separate opt-in benchmark, not in npm test. Why: a suite that fails at random under load costs every lane a full re-run and teaches people to ignore red.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The cli-setup telegram poll-timing test passes deterministically under load (proven by running it with an artificial CPU load or a shortened delay that previously failed) without changing what it proves
- [x] #2 tests/telegram-tap-latency.test.ts wall-clock bounds move behind an opt-in flag or become sequence assertions; npm test never depends on them
- [x] #3 npm test passes; lint clean
- [x] #4 The two sibling TTL races the lanes reported (tests/daemon.test.ts's sweep cases, tests/up.test.ts's 'daemon expires a lapsed request and the channel annotates it') no longer race a fixture TTL against a CLI call, and pass under the same artificial load
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. tests/telegram-mock.ts: add an onGetUpdatesAnswered hook that fires after every getUpdates answer with the poll's ordinal and how many updates it carried. The mock is the only place that knows when a poll has been answered, so it is the only honest release point.
2. tests/cli-setup.test.ts 'a message sent AFTER the first poll came back empty': replace the 120 ms setTimeout with that hook - queue the human's message when poll 1 has been answered empty. The update does not exist until the first poll has come back, so polls.length > 1 holds at any load; the property (the verb re-polls on its own, with no offset and no Enter) is unchanged.
3. tests/telegram-tap-latency.test.ts: move the two wall-clock cases (BOUND 300 ms ack, RATIO decision path) into tests/telegram-tap-latency.bench.ts, which run-tests.mjs never discovers (it collects *.test.js only) and which refuses to run without APPROVAL_BENCH=1. Keep deterministic counterparts in the suite: the ack is the FIRST Bot API call after the callback (sequence, not milliseconds), and the verified-read work a tap does is identical at 1k and 10k records (cache miss/hit counts, not a ratio of times).
4. tests/daemon.test.ts TTL sweep and tests/up.test.ts expiry: stop racing a 2s fixture TTL against a CLI call. Set the case up under the ordinary 1h TTL, then, once the ordering the case needs has been observed (the grant landed; the prompt was delivered), rewrite APPROVAL.md to approval_ttl 1ms and re-attest. The daemon re-reads the TTL every pass by design, so the lapse becomes an event the test causes rather than a deadline it hopes to beat.
5. Prove it: run each changed file under an artificial CPU busy-loop (scripts-free, a .mjs spawned alongside the runner) and record exit codes in the notes. Then npm test and npx oxlint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What changed, and what each test now asserts

Four files, all tests. No production code was touched: every seam used here already existed (the mock's own request loop; the daemon's documented re-read of defaults.approval_ttl on every pass). No test-only switch was added to any runtime path, and no clock was injected into a spawned process.

**tests/telegram-mock.ts — onGetUpdatesAnswered(hook | null).** Fires after each getUpdates response has been sent, with the poll's 1-based ordinal and how many updates that answer carried. The mock is the only participant that knows when a poll has actually been answered, so it is the only honest release point for 'the human replied after the verb had already looked'. Cleared by close(); an injected failure mode never reaches the path, so a dropped or held request does not advance the ordinal.

**tests/cli-setup.test.ts, 'a message sent AFTER the first poll came back empty is still found'.** ASSERTS THE SAME PROPERTY: the verb re-polls on its own initiative, with no offset on any poll, no allowed_updates drift, and no Enter asked of the operator (polls.length > 1 plus the per-body checks are unchanged). HOW IT NOW HOLDS: the human's message is queued from the mock hook when poll 1 has been answered with zero updates, so the update does not EXIST until the first poll has come back empty. The old form queued it on a 120 ms timer, which on a loaded box could land before poll 1 was answered — the verb then found it on poll one and the assertion failed with nothing wrong. Two guards were added so the fixture cannot silently stop being the case it claims: the hook asserts poll 1 delivered 0, and the case asserts the message was released exactly once.

**tests/telegram-tap-latency.test.ts, split.** The fixtures and the single-tap driver moved verbatim to tests/tap-latency-harness.ts (not a .test.ts, so the runner ignores it) and are now shared by both halves, so the two measure the same thing.
- The wall-clock cases (BOUND: ack under 300 ms at 10k records; RATIO: decision path under 8x at ten times the records) moved to tests/telegram-tap-latency.bench.ts. Two things keep them out of npm test: scripts/run-tests.mjs discovers *.test.js only (verified: --only telegram-tap-latency.bench is refused, exit 1), and every case fails fast without APPROVAL_BENCH=1 (verified: exit 1 without it, 2/2 exit 0 with it). Run it with: npm run build && APPROVAL_BENCH=1 node --test dist/tests/telegram-tap-latency.bench.js.
- Two deterministic cases replace them in the suite, asserting the same claims as counts and orders rather than durations. SEQUENCE (the load-proof form of the bound): the first two Bot API calls a tap makes are exactly getUpdates then answerCallbackQuery, the outcome edit comes after the ack, and the log had not grown when the ack was sent — what a human experiences as an instant spinner is that ORDER, and an order holds at any load. COUNTED (the load-proof form of the ratio): after both fixtures are warmed, one tap does the SAME verified-read work at 1k records and at 10k (equal hits/misses/resumed deltas) with zero reads from genesis at either size; a path that re-walked the log per tap would show a miss, one that read more of a longer log would show more reads. Guarded against vacuity by asserting the 1k side made at least one verified read.
- The three structural cases (ack before the append, exactly one ack per callback, the ack claims no decision; and the cache-hit case) are unchanged.

**tests/daemon.test.ts and tests/up.test.ts — lapse(dir), replacing the 2s fixture TTL.** ASSERTS THE SAME PROPERTIES: the daemon's sweep expires a lapsed request exactly once and leaves a decided one alone; a request the gate already expired lazily is not expired a second time; and, in up, the daemon expires a lapsed request while the channel in the same process annotates the prompt and withdraws its buttons. HOW THEY NOW HOLD: the case sets itself up under the ordinary 1h TTL, and once the ordering it needs has been OBSERVED (the follow-up grant landed; the prompt reached the phone) it calls lapse(dir), which rewrites APPROVAL.md with a 1ms defaults.approval_ttl and re-attests through the real CLI verb — the human's own ceremony, and exactly what an operator shortening a deadline does. The daemon re-reads the TTL on every pass by design (daemon/daemon.ts: 'The TTL in force right now, re-read every pass: policy files change'), and gate.ts judges a lapse as ts > requestTs + ttlMs from the policy in force at evaluation time, so the lapse becomes an event the test causes rather than a deadline it hopes to beat. Nothing self-reported and no caller timestamp is involved: the events are still written by the gate with its own clock. Costs came down with the flakiness — up's expiry case is 2.1s instead of ~8s alone, and the lazy-expiry case no longer spends 3s waiting.

## Load proof

A scratch runner spawned 16 busy-loop node children on an 8-core machine (24 for one run) and then ran the file, reading the exit code:
- dist/tests/cli-setup.test.js: 90/90, exit 0, 114.0s under 16 busy loops (72s idle).
- dist/tests/telegram-tap-latency.test.js: 5/5, exit 0, 48.5s under 16 (9.5s idle).
- dist/tests/daemon.test.js: 31/31, exit 0, 272.5s under 16 (63s idle); both sweep cases green.
- dist/tests/up.test.js: 14/14, exit 0, 216.2s under 16 (120s idle).

NEGATIVE CONTROL, because a green run under load only proves the load did not happen to bite. The pre-fix cli-setup.test.ts was restored from 1c3aced and run under 24 busy loops: it passed (123.3s, exit 0) — the busy loops alone do not reliably reproduce it, which is precisely why it survived review the first time. Its delay was then shortened from 120 ms to 5 ms, which is the field condition (the first poll lands after the human's message), and it failed on an idle machine with the reported message: 'it polled once and gave up on the human's timing', 1 test, 0 pass, 1 fail, exit 1. The fixed case, same pattern, same machine: 1/1 exit 0 — and it has no delay left to shorten, because the release point is the poll sequence rather than a clock.

## Verification

- npm test: 3126 tests, 3125 pass, 0 fail, 1 skipped (pre-existing), exit 0, 491.8s.
- npx oxlint src tests: exit 0.
- npm run build: exit 0 (every run above was against a fresh build).
- Runner selectors: node scripts/run-tests.mjs --only telegram-tap-latency.bench → refused, exit 1 (the bench is not discoverable). node --test on the bench without APPROVAL_BENCH → exit 1. With APPROVAL_BENCH=1 → 2/2, exit 0.

## Global invariants (SPEC §11)

None touched. No production file changed; every log in these tests is still built through the real append path (the CLI's own verbs, core/log.ts's appendEvent, and appendAttestation for the re-attest); no event is hand-written; no gate-typed event takes a caller timestamp; the policy edits lapse() makes go through approval policy attest exactly as a human's would, so no enforcement path reads an unattested policy.

## For the reviewer

- The branch is cut from 1c3aced; origin/main has since moved 15 commits (#258 APRV-227, #259 APRV-233/234). Neither touches any of the five files changed here (git diff 1c3aced origin/main over them is empty), so the merge is clean, but the npm test figure above is from the pre-merge tree.
- main's new scripts/run-tests.mjs (APRV-227) still discovers *.test.js only, so the bench file stays out of the suite after that merge.
- The 1ms TTL is the shortest the duration grammar accepts (parseDuration rejects zero), which is why lapse() uses it rather than 0s.
<!-- SECTION:NOTES:END -->
