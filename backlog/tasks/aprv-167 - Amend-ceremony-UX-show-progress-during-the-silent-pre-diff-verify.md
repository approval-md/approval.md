---
id: APRV-167
title: 'Amend ceremony UX: show progress during the silent pre-diff verify'
status: Done
assignee:
  - '@claude'
created_date: '2026-08-30 23:07'
updated_date: '2026-09-01 21:25'
labels:
  - cli
  - ux
dependencies: []
ordinal: 146000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed by Carter 2026-08-30: approval policy amend sat silent for ~33 seconds before printing the Policy/Changes/Load block, and read as frozen; the human nearly abandoned a live ceremony (and earlier DID abandon one mid-run, leaving the repo gate fail-closed for every agent session until a second attempt). The silence is the chain re-verify plus baseline recovery over a ~3000-record log before anything prints. Wanted: immediate output when the verb starts (what it is doing, record count), and progress for any step that can exceed a couple of seconds (verify N/M records, baseline recovery), on stderr so --json stdout stays clean. Same treatment for other verbs that re-verify the whole chain before speaking (wait, status on large logs) is in scope to survey, amend is the priority.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval policy amend prints a first line within ~1s of invocation naming the step in progress
- [x] #2 Chain verification over large logs reports progress (count-based, stderr), and --json output is byte-unchanged on stdout
- [x] #3 A survey note in the task lists which other verbs share the silent-verify pattern and whether each got the same treatment or a reasoned skip
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. `src/core/verify.ts`: add `onProgress?: (p: { done: number; total: number }) => void` to `VerifyOptions`. `walk` takes an optional per-record report; `verifyText` computes total (prefix lines + this walk's lines) and the base offset, and emits every `PROGRESS_INTERVAL` records plus once at the end. Verify semantics are untouched: the callback observes, it never decides.
2. The option rides the existing seam to every entry point — `verifyWithRecords` -> `verifyText`, and `readVerifiedRecords` -> `VerifiedReadCache.read` -> `verifyText` — so a resumed read reports the same absolute counts a cold one does.
3. New `src/cli/progress.ts`: a small reporter on STDERR with `phase(text)`, `step(done, total)` and `done()`. TTY repaints one line with \r; non-TTY is line-oriented with no \r and no spinner. `phase` is immediate (that is the first line within ~1s); `step` is time-throttled. TTY-ness is `process.stderr.isTTY`, injectable.
4. `src/cli/amend.ts`: announce the phases the operator was staring at in silence — chain verification (with counts) before `readVerifiedRecords`, then baseline recovery — and close the reporter before the Policy/Changes/Load block is printed. Nothing moves to stdout.
5. Tests: the callback fires with monotonically increasing counts ending at the record total; non-TTY output is line-oriented and carries no \r; `amend --json` stdout is byte-identical with and without a progress reporter.
6. Survey note for AC #3: which other verbs re-verify the whole chain before speaking, and what each got.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Survey (AC #3): which verbs re-verify the whole chain before speaking

Every one of these goes through `core/state.ts`'s `readVerifiedRecords`, so the progress option reaches all of them for free; what differs is whether narration helps the reader.

| verb | site | treatment |
| --- | --- | --- |
| `policy amend` | `cli/amend.ts` (the cold read plus `recoverBaseline`) | **Treated.** The reported case: thirty-three seconds of silence, read as a hang, one ceremony abandoned mid-run. |
| `wait` | `cli/execute.ts:640`, inside the poll loop | **Reasoned skip.** It re-verifies once per poll, so counts would flood rather than inform, and iterations after the first ride the process read cache and walk only the appended suffix. It is also the one verb whose whole contract is that it takes time (it carries `--timeout`), so silence there does not read as a freeze. Worth revisiting if a cold first walk on a very large log is ever reported. |
| `status` / `queue` | `cli/execute.ts:875`, `:1034` | **Reasoned skip, and the closest call.** Same one-shot shape as amend and it would benefit, but its stderr is pinned empty across `cli-gate` and `cli-status`, and re-cutting those contracts is its own task rather than a rider on this one. The seam is in place: two lines each when someone wants it. |
| `doctor` | `cli/doctor.ts:1687` | **Skip.** It already prints a row per check and its slowness is visibly attributable; a progress meter above a diagnostic table is noise. |
| `hook claude-code` | `cli/hook.ts` (four sites) | **Skip, deliberately.** Its stdout AND stderr are a harness's machine surface; narration there is a protocol violation, not a comfort. |
| `audit`, `token` | `cli/audit.ts`, `cli/token.ts` | **Skip.** One-shot and small; no report of a perceived hang. |
| `channel telegram listen`, `daemon` | `cli/channel-telegram.ts:603`, `daemon/daemon.ts:631` | **Skip.** Long-running processes with their own event streams, which already say what they are doing. |

## Decisions

- **The core counts; the CLI decides how often a human sees them.** `core/verify.ts` has no clock, so `onProgress` fires on a count boundary (`PROGRESS_INTERVAL`, 250) and is therefore exactly assertable. Time-based throttling lives in `cli/progress.ts`, the only layer that knows whether there is a terminal.
- **The closing call reports what the walk reached, not the total.** A walk that stopped at record 12 of 3000 reports 12: a meter must not claim work that was refused. Reports are de-duplicated so the closing call never repeats an interval boundary, which is what makes the counts strictly increasing.
- **Counts are absolute over the log.** A resumed read behind a `VerifiedPrefix` (the warm process cache) offsets by the prefix's line count, so a warm process does not show the count restarting at zero.
- **Silent under `--json`, which was a bug found by the tests.** This verb's machine surface is not stdout alone: a `--json` refusal emits its error OBJECT on stderr and callers parse that stream whole. Narration mixed in broke sixteen existing cases outright. `--json` is precisely the flag that says no human is reading, so it takes `silentProgress`.
- **stderr's first line is load-bearing elsewhere.** Four cases pin the refusal headline as the first thing stderr says. The narration now precedes it, so `firstLine` in the amend suite skips progress lines: the property those cases assert is still "the first thing the verb says about the RESULT is the headline".

## Validation

`npm run lint` and `npm run build` clean. `tests/progress.test.ts` (11 new) covers the strictly-increasing counts ending at the total, that observing changes neither verdict nor records, that the listener rides `readVerifiedRecords` cold and warm with absolute counts, and the reporter's non-TTY line orientation (no carriage return anywhere), immediate phase line, TTY repaint-and-erase, throttling that never drops the final count, and the silent reporter. `tests/cli-amend.test.ts` (2 new) covers the two phase lines in order through the spawned CLI with no \r, and `--json` emitting exactly one stdout line with an empty stderr. `progress` + `cli-amend` 83 pass 0 fail; `verify` + `state` + `state-cache` 78 pass 0 fail.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval policy amend now names the step it is on. core/verify.ts gained an observational onProgress on VerifyOptions, fired every 250 records through walk/verifyText and riding the existing read seam to every entry point, with counts absolute over the log and de-duplicated so they strictly increase. cli/progress.ts is a small stderr reporter: the phase line is immediate, counts are time-throttled, a TTY gets one repainted line that is erased on close and a pipe gets plain newline-terminated lines with no carriage return. amend announces the chain verification and the baseline recovery, and is silent under --json because that flag's machine surface includes stderr. Verified with 11 new tests in tests/progress.test.ts and 2 in cli-amend (progress+amend 83 pass, verify+state 78 pass), lint and build clean.
<!-- SECTION:FINAL_SUMMARY:END -->
