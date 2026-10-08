---
id: APRV-210
title: >-
  Doctor's git-backed rows misread the checkout after APRV-203: log-drift claims
  the log was never committed, log-advance-cadence counts every record as
  unpublished
status: Done
assignee:
  - 'agent:opus-lane-v'
created_date: '2026-09-02 08:44'
updated_date: '2026-09-02 22:18'
labels:
  - doctor
  - bug
dependencies: []
priority: high
ordinal: 173000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-02 on the primary checkout right after syncing to main and rebuilding: approval doctor says log-drift SKIP 'git has no HEAD:.approval/log/events.jsonl blob: this log has never been committed', while git show HEAD:.approval/log/events.jsonl in the same directory prints the log; and log-advance-cadence says all 9,875 records are not yet on a records branch, when seq 1..8379 were merged to main through PR #203 an hour earlier. Both rows read git; both went wrong on the same day APRV-203 rewrote the advance to build its commit on the remote tip through a scratch index and anchor it under refs/approval/advance/<branch> instead of a local records-log-<date> branch, and APRV-204 added publishedState reading local refs only. Outcome: log-drift resolves the HEAD blob the way git-scope.showBlob does (repo-relative path, cwd at the checkout root, realpath-safe), and log-advance-cadence counts as published whatever the remote's trunk or records branches already carry (fetching is the verb's job, so the row may read refs/remotes/* and refs/approval/advance/* as well as local branches, and must say which it read). Both rows get a test against a scratch repo whose log IS committed at HEAD and whose records were merged remotely, asserting pass with the right counts. Why: doctor is the surface an operator trusts to say whether the log is safe; a row that says never committed about a log with 9,875 committed records teaches people to ignore it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 On a scratch repo whose HEAD commit carries the log, log-drift passes and reports the committed seq; it never prints 'never been committed' when git show HEAD:<log> succeeds
- [x] #2 On a scratch repo with a bare remote whose trunk carries seq 1..N and a working log at seq N+k, log-advance-cadence reports k owed, not N+k, and names the ref it read
- [x] #3 Both rows resolve paths repo-relative from the checkout root via git-scope helpers; no row builds a HEAD:<absolute path> spec
- [x] #4 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. log-drift: fixed by construction in APRV-219 — the row becomes the anchor check, whose path resolution is repo-relative from the checkout root through git-scope helpers with realpath on both sides, so a checkout reached through a symlinked spelling (/tmp vs /private/tmp) can no longer produce a bogus relative path and a false 'never been committed'.
2. log-advance-cadence: publishedState already reads refs/remotes/<remote>/<base> and refs/approval/advance/*, but the row never says which ref it read and a rev that resolves to nothing is indistinguishable from a rev that carried nothing. Return the winning rev from publishedState (publishedRev) and print it in the row; keep counting the max clean head across every candidate rev.
3. Tests: a scratch repo whose HEAD carries the log (log-drift passes, reports the committed seq), and a scratch repo with a bare remote whose trunk carries seq 1..N with a working log at N+k (cadence reports k owed and names the ref).
4. tests/cli-doctor.test.ts row counts unchanged: both rows keep their name and position.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
FIXED, on branch aprv-219-log-anchor with APRV-219 (commits e31c5f6, 038eb3b, 4f4e2fa).

ONE ROOT CAUSE, TWO ROWS. Both rows resolve the log's repo-relative path with cli/git-scope.ts's repoPath(). git rev-parse --show-toplevel prints the PHYSICAL path, so a checkout reached through any other spelling of the same place (a symlinked directory, /tmp for /private/tmp on macOS, a bind mount) handed repoPath a root and a path that did not share a prefix. relative() then produced a path climbing out of the repository, git had no blob at HEAD:<that>, and showBlob returned null. log-drift read that null as 'this log has never been committed'; publishedHeadAt read it as 'no rev carries a copy of this chain', which is publishedState returning publishedSeq 0 and therefore every record unpublished. Same call, same day, two rows.

repoPath() now resolves realpath on both sides, through a realish() helper that resolves the existing part of a path and re-appends the missing tail so a log file that does not exist yet gets the same spelling as one that does. That is AC3: no row builds its own path, and no row builds a HEAD:<absolute path> spec - pinned structurally by a test over log-anchor.ts, log-advance.ts and doctor.ts.

log-drift (AC1) is now the APRV-219 anchor check's result, so it looks at every rev a committed copy may live at rather than only HEAD, and reports the committed seq on a pass. It cannot print 'never been committed' any more: that string is gone, and the skip it was attached to now names every rev it tried.

log-advance-cadence (AC2) counts what the remote trunk and the records refs already carry - publishedState already consulted refs/remotes/* and refs/approval/advance/*, it was the path resolution that made them all miss - and now NAMES the ref: PublishedState gained publishedRev (the rev the count came from, null when none carried this chain) and revs (everything tried), and the row prints 'read from <rev>' or, when nothing carried it, the list. A row that says N records are unpublished is unreadable without it: a rev that resolved to nothing and a rev that carried nothing are the same number and completely different facts.

TESTS (AC4 in part). In tests/log-anchor.test.ts: 'log-drift never says never been committed when git show HEAD:<log> succeeds' asserts the premise with real git first; 'log-drift resolves the log through a symlinked spelling of the checkout' is the reproduction, a real symlink to the checkout; 'log-advance-cadence counts what the trunk carries and names the ref' builds a bare remote whose trunk carries seq 1..2 with a working log at seq 4 and asserts 2 owed, not 4, plus the ref name, and cross-checks publishedState directly. tests/cli-doctor.test.ts row names, order and count are UNCHANGED (20 rows): both rows kept their name and position.

One behaviour note. log-drift's skip no longer carries a fix field (a fix belongs to a failing row, which is the rule every non-git doctor fixture pins); what a reader might still run is said in the detail instead. The pass-that-owes-records and the behind rows keep the fixes they always had.

VALIDATION. Full npm test on the final tree: 3011 tests, 3010 pass, 0 fail, 1 pre-existing skip. npx oxlint exit 0. tests/cli-doctor.test.ts 55/55 with its row names, order and count unchanged; the three new reproduction tests live in tests/log-anchor.test.ts and pass.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Both doctor misreads shared one root cause: git-scope.repoPath() built relative paths without realpath while git prints the physical toplevel, so a symlinked checkout spelling climbed out of the repo and git show found no blob; the same call inside publishedHeadAt made the cadence row count every record unpublished. Fixed once; log-drift is now the anchor check's result and the cadence row names the ref it read. Verified by cli-doctor 55/55 and the log-anchor suite; merged in PR #241.
<!-- SECTION:FINAL_SUMMARY:END -->
