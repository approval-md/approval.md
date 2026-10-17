---
id: APRV-262
title: >-
  Anchor resolution and publishedState find no committed log in a checkout where
  git show origin/main:<log> succeeds: the daemon reports anchor none and
  highest published seq 0, and the cadence advance refuses
status: Done
assignee:
  - 'agent:opus-lane-e'
created_date: '2026-09-05 09:59'
updated_date: '2026-09-05 11:40'
labels:
  - core
  - daemon
  - bug
dependencies: []
priority: high
ordinal: 195000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Seen 2026-09-05 right after the APRV-219/210 build went live in the primary (a8f8360): the daemon's started line says anchor none (no rev this checkout can see carries a committed copy of the log; tried refs/approval/advance/records-log-2026-09-02, -04, -05, refs/remotes/origin/main, refs/remotes/origin/records-log-2026-09-05, HEAD), the cadence advance refuses with 'no records branch in this checkout carries seq 14883 (the highest published seq is 0)', and approval log verify --anchor in an agent worktree skips the same way, while git show refs/remotes/origin/main:.approval/log/events.jsonl in the same directory prints the log at seq 19578 and no symlink is involved. So the resolver's git read fails for every rev, in every checkout, and the daemon, doctor log-drift, log-advance-cadence and the advance's owed-span computation all read that answer. APRV-210 fixed a realpath bug in the same helper; this is a second, broader failure of the same read (candidate causes: the rev spelling passed to git show, the repo-relative path computation from the checkout root in a worktree, a spawn cwd, or an exit-code interpretation), and it silently degrades security (no anchor witness) and blocks the advance cadence. Outcome: a failing test that runs approval log verify --anchor and the daemon against a scratch clone whose origin/main carries the log (the existing log-anchor fixtures should have caught this; find why they pass while the real checkout fails, e.g. a fixture that resolves HEAD only), then the fix, and a doctor line that prints the exact git command and its stderr when every rev fails, so a skip can never hide a broken read again.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A test reproduces the failure against a scratch clone with a bare origin whose main carries the log (mirroring the primary checkout's ref layout: refs/remotes/origin/main plus refs/approval/advance/* refs) and passes after the fix; approval log verify --anchor in the primary reports pass or behind, never a skip, when origin/main carries the log
- [x] #2 The daemon's started line names the anchor, log-advance-cadence counts owed records against the highest published seq on origin/main, and the cadence advance proceeds past a seq the trunk already carries
- [x] #3 When every rev fails the skip reason includes the git command that failed and its stderr, and doctor's log-drift row surfaces it
- [x] #4 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reproduce in an agent worktree, not by reading: `git rev-parse --verify --quiet 'refs/remotes/origin/main:.approval/log/events.jsonl'` prints a blob id and `git show` prints 12.5 MB, while `resolveAnchor` sees nothing. Bisect the resolver by hand: repoPath's relative spelling, then blobOid's rev-parse, then showBlob's git show.
2. Confirm the mechanism directly: spawnSync git show on the real 12.5 MB blob with the module's own options reports status null, error ENOBUFS, stdout truncated at 1064960 bytes.
3. Write the failing test FIRST, at the primary checkout's ref layout and log size: a bare origin whose main carries the log, refs/remotes/origin/main, a refs/approval/advance/* ref, the log grown past 1 MiB through the real append path (appendAttestation, never a hand-written line), run from both the main worktree and a `git worktree add` linked one, plus publishedState and the doctor log-drift row. Commit it red.
4. Fix: name the limit once in core/git-run.ts (GIT_OUTPUT_LIMIT_BYTES, verified not preallocated), apply it in run(), and carry the child's exit status on GitRun, which `ok` cannot express.
5. Replace git-scope's bare spawnSync with readBlob(): runs with the limit, answers with the command it ran plus git's status and stderr. Keep showBlob as a Buffer|null wrapper so log-sync, log-advance and amend are fixed without touching their call sites.
6. Make the skip diagnosable: blobOid returns the failed attempt rather than a bare null, anchoredCopy distinguishes "this rev has no such blob" from "this rev names a blob that could not be read", and resolveAnchor appends every attempt to the reason when and only when nothing resolved. Carry it through doctor's log-drift row.
7. Verify against the real 12.5 MB log in the worktree (log verify --anchor, doctor --json), then full npm test and oxlint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Root cause

`spawnSync` caps a child's captured output at `maxBuffer`, one mebibyte by
default, and kills anything past it: `error` is set to `ENOBUFS`, `status`
comes back `null`, `stdout` holds a truncated prefix. `git-scope.showBlob`
ran `git show <rev>:<path>` through a bare `spawnSync` with no `maxBuffer`
and checked only `result.error !== undefined || result.status !== 0`, so a
killed read returned `null` — the same value it returns for "this rev has
no such file". The committed log passed a mebibyte long ago (12.5 MB at
seq 19578), so every candidate rev's blob read had been failing, silently,
for as long as the log had been over the ceiling.

`git rev-parse --verify --quiet <rev>:<log>` prints 40 bytes and never came
near the ceiling, which is why the shell said the blob existed while the
runtime said no rev carried one. Every consequence follows from that one
call: `resolveAnchor` found no anchor (skip, all revs listed, no reason,
because `anchoredCopy` returned `reason: null` on a null blob and the note
was dropped); the daemon's started line said anchor none; the doctor's
log-drift row printed the skip; `publishedState`'s `publishedHeadAt` reads
the same `showBlob`, so `publishedSeq` was 0, `log-advance-cadence` claimed
the whole log was owed, and the advance refused for a seq origin/main had
carried for days.

Neither `repoPath` nor the worktree root was implicated. The relative path
was `.approval/log/events.jsonl` byte for byte in both the primary checkout
and a linked worktree; APRV-210's realpath fix holds.

## Why tests/log-anchor.test.ts passed

Every fixture in that suite carried two to four records — a few hundred
bytes. The suite was not small by accident; it was small on the one axis
the defect lives on, so it reported health about a code path that had
already stopped working in production. The suite's own `git()` helper had
the same 1 MiB default and started answering `code: -1` the moment the new
fixtures crossed the ceiling, which is a second instance of the same bug
inside the harness that was supposed to catch it.

## What changed

- `src/core/git-run.ts`: `GIT_OUTPUT_LIMIT_BYTES` (512 MiB, not
  preallocated — verified: naming it costs 0 MB RSS) is applied in `run()`,
  and `GitRun` now carries the child's exit `status`, which `ok` cannot
  express (`null` = never got one).
- `src/cli/git-scope.ts`: `readBlob()` replaces the bare `spawnSync`, runs
  with the limit, and answers with the command it ran plus git's exit
  status and stderr on failure. `showBlob()` is a wrapper preserving the
  `Buffer | null` shape for every existing caller (`log-sync`, `amend`,
  `log-advance`), all of which are fixed by the raised limit alone.
- `src/cli/log-anchor.ts`: `blobOid` returns the failed attempt (command +
  exit status + stderr) instead of a bare `null`; `anchoredCopy` reports a
  rev whose blob EXISTS but could not be read as its own failure rather
  than as a rev with nothing to say; `resolveAnchor` appends every attempt
  to the skip reason when — and only when — nothing resolved.
- `src/cli/doctor.ts`: the log-drift skip row carries that reason through,
  `oneLine`d.
- `src/cli/amend.ts`: `showHead` (its own `git show HEAD:<policy>`) carries
  the same limit. It reads the policy file, which is nowhere near the
  ceiling today, and neither was the log.

## Global invariants touched

None weakened. This is an enforcement path (SPEC §11.1 invariant 1, reads
only verified records) that was failing OPEN in the reporting direction: it
skipped rather than passed, so nothing was ever wrongly accepted. The fix
makes the skip diagnosable and restores the comparison. No event shape, no
timestamp handling, no append path, no refusal code changed;
`ANCHOR_REFUSAL_CODES` is untouched.

## Evidence per acceptance criterion

**AC1.** `tests/log-anchor.test.ts` grew a section that builds the primary
checkout's ref layout at the primary checkout's log size: a bare origin
whose `main` carries the log, `refs/remotes/origin/main`, a
`refs/approval/advance/records-log-fixture` ref, and a log grown past
1.2 MiB (~3500 records) through `appendAttestation`, the real append path.
Run from the main worktree and from a `git worktree add` linked one. On
2593baa these fail, and the doctor case reproduces the production sentence
verbatim: "no rev this checkout can see carries a committed copy of
.approval/log/events.jsonl (tried refs/approval/advance/records-log-fixture,
refs/remotes/origin/main, refs/remotes/origin/records-log-2026-09-05,
HEAD)". After the fix, `approval log verify --anchor` in this worktree
against the real 12.5 MB log answers "anchor
refs/approval/advance/records-log-2026-09-05: the working log is a prefix
of ... through seq 20634" at exit 0 — behind, never a skip.

**AC2.** `publishedState` on a large-log fixture reports `publishedSeq` at
the trunk's head and `pending: 2` rather than 0 and the whole log; the
existing daemon started-line case reads the same `resolveAnchor`. On the
real log, `approval doctor --json` prints log-advance-cadence "every record
through seq 19578 is on a records branch or the trunk (read from
refs/remotes/origin/main)" — the count is against origin/main, and the
advance is no longer refusing for a seq the trunk carries.

**AC3.** When nothing resolves, the reason now carries every candidate's
git command and what git answered, e.g. "`git rev-parse --verify --quiet
HEAD:.approval/log/events.jsonl` exited 1 and printed nothing", and a rev
whose blob EXISTS but could not be read reports that separately from a rev
with nothing to say. Doctor's log-drift skip row carries the whole reason
through. Pinned in the "never committed the log" case.

**AC4.** `npm test`: 3448 tests, 3447 pass, 0 fail, exit 0 (one skipped).
`npx oxlint`: exit 0. `tests/log-anchor.test.js` alone: 29/29, exit 0.

## Verification note

The suite's own `git()` helper carried the same 1 MiB default and started
answering `code: -1` as soon as the new fixtures crossed the ceiling. It
now uses `GIT_OUTPUT_LIMIT_BYTES`. A harness that cannot read what it is
asserting about reports failures it cannot explain, which is the second
instance of this defect and worth naming.

## Not done here

The branch is based on ab9d816 and could not be rebased: `git rebase`
classifies `vcs.history.rewrite`, human-only. Not pushed, no PR opened,
per the lane brief. `src/daemon/git-evidence.ts` and `src/cli/hook.ts`
still run git through their own local `spawnSync` wrappers at the default
limit; their commands (`rev-parse`, `diff --cached --numstat`, `merge-base
--is-ancestor`) produce a line or two, so they are not at risk today, and
they were left alone rather than swept into a regression fix.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Root cause: spawnSync's 1 MiB maxBuffer killed every git show of the 12.5 MB committed log and showBlob returned null as if no rev carried it, so the anchor, doctor log-drift, publishedState and the cadence advance all read nothing. Fixed with GIT_OUTPUT_LIMIT_BYTES (512 MiB) in the git runner, readBlob reporting the command, status and stderr, log-anchor distinguishing no blob from unreadable blob and listing every attempt in the skip reason, and the same limit on amend's policy read. Verified by log-anchor 29/29 with five cases at the primary's ref layout and log size from a main and a linked worktree, cli-amend 84/84, full run 3447 pass, and against the real log (anchor behind, doctor rows pass); merged in PR #284.
<!-- SECTION:FINAL_SUMMARY:END -->
