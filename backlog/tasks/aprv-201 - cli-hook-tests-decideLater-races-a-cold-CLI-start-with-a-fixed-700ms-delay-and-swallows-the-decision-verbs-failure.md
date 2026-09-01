---
id: APRV-201
title: >-
  cli-hook tests: decideLater races a cold CLI start with a fixed 700ms delay
  and swallows the decision verb's failure
status: Done
assignee:
  - '@claude'
created_date: '2026-09-01 20:37'
updated_date: '2026-09-01 21:48'
labels:
  - test
  - hook
  - dogfood
dependencies: []
priority: high
ordinal: 165000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the APRV-151 lane on 2026-09-01 and reproduced on main at 5e16ac0 with no other changes: decideLater in tests/cli-hook.test.ts (line ~201) spawns a detached helper that sleeps a FIXED 700ms and then runs approval grant|reject <key> --as human:alice exactly once with stdio ignore. At 700ms the hook under test has not yet appended approval.requested (it must spawn node, load the CLI, verify the chain, check attestation, validate schema), so the decision hits not-requested, the refusal is swallowed, nothing ever decides, and the hook waits its full 20s and returns hook-timeout where the test expects hook-rejected. Instrumented output: status=1, stderr: not-requested: action hook:sess-1:tu-reject:network.call has no approval.requested record to decide. The same fixed-delay race underlies the two sibling tests (a manual command is allowed when a grant lands mid-wait; a grant that lapsed its TTL carries nothing), which fail with load. Every lane this week misfiled these as load flakes; the suite reports the wrong defect because the helper discards its exit status.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 decideLater polls the log for the approval.requested record (bounded, with a clear failure) instead of a fixed delay
- [x] #2 The helper's decision verb exit status and stderr are captured and surfaced in the assertion message, never ignored
- [x] #3 The three affected cli-hook tests pass 10 consecutive runs on a loaded machine (run alongside a full npm test)
- [x] #4 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Replace decideLater's fixed setTimeout with a bounded poller: the detached helper runs 'approval queue --json' in the case dir every 100ms for up to 15s and waits for the target action key to appear as a pending request, then runs the decision verb exactly once.
2. Capture the decision verb's exit status, stdout and stderr (and the poll count, elapsed ms, last queue output) into a JSON report file next to the helper; decideLater returns a handle whose describe() reads that report and whose assertDecided() fails loudly, by name, when the helper never decided or the verb exited non-zero.
3. Thread describe()/assertDecided() into the two decideLater call sites ('a grant lands mid-wait', 'a rejected request denies with hook-rejected') so a helper failure names itself instead of masquerading as hook-timeout.
4. Anchor the TTL-lapse test on observed records: widen the case TTL from 1s to 4s so a cold grant lands inside it under load, read the approval.requested ts back through readVerifiedRecords, and wait until the clock is past requestTs+TTL instead of sleeping a fixed 1400ms; report the observed lag when the grant misses the window.
5. Fix the grantWhenPending doc comment that describes decideLater as a single fixed-delay shot.
6. Verify: the three tests 10x under concurrent load, then npm test, npm run lint, npm run build.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Root cause confirmed by measurement, not inference: on this machine under load a cold `approval` CLI start is 1.3-1.7s (three timed `--version` spawns), and in the mid-wait case the hook's `approval.requested` reached the log ~2.5s after the helper started. A 700ms fixed delay could not have won that race; the decision hit `not-requested`, `stdio: "ignore"` ate the refusal, and the hook's own 20s timeout was reported as the defect.

What changed (tests/cli-hook.test.ts only, no src/):
- `decideLater(dir, verb, actionKey)` lost its `delayMs` parameter. The detached helper now polls for the key's `approval.requested` record every 100ms with a 15s deadline, then runs the decision verb exactly once.
- The poll reads the log FILE (dropping a trailing partial line, parsing each line in a try) rather than shelling out to `approval queue --json`. That was the first implementation and it was measured and rejected: a CLI-per-poll costs ~3.5s per poll under load, so the grant landed 7.4s after the helper started and the test took 12.3s. Reading the file makes the poll free and the helper's latency the request's own. Nothing is *decided* on that read: the decision verb does its own verified read, and every test still ends at `assertClean` / `log verify`, so this is a synchronisation point and not an enforcement path (SPEC §11.1 untouched).
- The helper writes a JSON report (write-then-rename) carrying the verb's exit status, stdout, stderr, the poll count, elapsed ms, and what the log held. `decideLater` returns `{ describe, assertDecided }`; the two call sites now `await decision.assertDecided()` BEFORE asserting on the verdict, so a helper failure names itself instead of masquerading as `hook-timeout`, and `describe()` is interpolated into the verdict assertions' messages.
- TTL-lapse test: the 1s TTL was itself a race in the other direction. `grantLapsed` measures from the REQUEST's ts, so a cold `approval grant` taking longer than a second arrives after its own request lapsed and is refused. TTL widened to 4s (the grant now has room for a cold start, and the assertion says how late it was if it misses), and the flat `await delay(1_400)` replaced by a wait anchored on the request record's own ts read back through `readVerifiedRecords` (new `requestedAtMs` helper): `while (Date.now() <= requestedAt + ttlMs + 250)`.
- Fixed the `grantWhenPending` doc comment, which described `decideLater` as a single fixed-delay shot.

Loudness verified by deliberately breaking the helper twice (both reverted):
- wrong action key -> `decision helper (reject hook:sess-1:tu-NEVER-ASKED:network.call) NEVER DECIDED after 146 polls in 15081ms: deadline: no approval.requested for ... | log held: 4 records, requests for [hook:sess-1:tu-reject:network.call]`
- `--as agent:not-a-human` -> `decision helper (reject hook:sess-1:tu-reject:network.call) decided after 22 polls in 3115ms: exit 2 stderr: approval: --as expects a human identity ... reject is human-only`

Verification evidence:
- AC#1/#2 (loudness): the two deliberate breakages above; both failed by naming the helper, its poll count, its elapsed time and either the deadline or the verb's exit status and stderr. Neither presented as hook-timeout.
- AC#3: 10 consecutive runs of the three tests under load (a script restarting two concurrent full `scripts/run-tests.mjs` suites in this worktree for the whole soak): 10/10 green, 0 red, pass=3 fail=0 every run, 32.6s-47.6s per run. Before the fix the same three tests were the ones PR #180 lost on CI.
- AC#4: full `npm test` on Node v24.2.0: 2492 pass, 0 fail, 0 cancelled, 0 skipped, duration 992s. `npm run lint` (oxlint src tests) clean; `npm run build` clean.
- Cost: the mid-wait tests now take ~8s each on a loaded machine (the helper waits for the real request instead of guessing 700ms) and the TTL test ~19s (4s TTL plus five cold CLI starts). On an idle machine they are far shorter. Correctness over duration was the trade taken.
- Global invariants: none touched. No src/ change, no log written by hand, the enforcement path still reads only verified records (the helper's file read decides nothing and every affected test still ends at `log verify`).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Replaced decideLater's fixed 700ms sleep in tests/cli-hook.test.ts with a bounded poller (100ms, 15s deadline) that waits for the target key's approval.requested record before deciding, and made the detached helper report the decision verb's exit status, stdout and stderr to a file the test folds into its assertion messages, so a helper that misses its window names itself instead of appearing as a hook timeout. The TTL-lapse test's 1s TTL and flat 1400ms sleep, both bets on machine speed, became a 4s TTL and a wait anchored on the request record's own timestamp read back through readVerifiedRecords. Test-only, no src/ change. Verified: the three tests 10/10 green under two concurrently restarting full suites; both failure modes shown loud by deliberate breakage; npm test 2492 pass / 0 fail; lint and build clean.
<!-- SECTION:FINAL_SUMMARY:END -->
