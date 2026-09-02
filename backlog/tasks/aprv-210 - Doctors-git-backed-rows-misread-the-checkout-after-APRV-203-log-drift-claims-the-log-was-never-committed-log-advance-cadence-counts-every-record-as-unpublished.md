---
id: APRV-210
title: >-
  Doctor's git-backed rows misread the checkout after APRV-203: log-drift claims
  the log was never committed, log-advance-cadence counts every record as
  unpublished
status: In Progress
assignee:
  - 'agent:opus-lane-v'
created_date: '2026-09-02 08:44'
updated_date: '2026-09-02 18:32'
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
- [ ] #1 On a scratch repo whose HEAD commit carries the log, log-drift passes and reports the committed seq; it never prints 'never been committed' when git show HEAD:<log> succeeds
- [ ] #2 On a scratch repo with a bare remote whose trunk carries seq 1..N and a working log at seq N+k, log-advance-cadence reports k owed, not N+k, and names the ref it read
- [ ] #3 Both rows resolve paths repo-relative from the checkout root via git-scope helpers; no row builds a HEAD:<absolute path> spec
- [ ] #4 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. log-drift: fixed by construction in APRV-219 — the row becomes the anchor check, whose path resolution is repo-relative from the checkout root through git-scope helpers with realpath on both sides, so a checkout reached through a symlinked spelling (/tmp vs /private/tmp) can no longer produce a bogus relative path and a false 'never been committed'.
2. log-advance-cadence: publishedState already reads refs/remotes/<remote>/<base> and refs/approval/advance/*, but the row never says which ref it read and a rev that resolves to nothing is indistinguishable from a rev that carried nothing. Return the winning rev from publishedState (publishedRev) and print it in the row; keep counting the max clean head across every candidate rev.
3. Tests: a scratch repo whose HEAD carries the log (log-drift passes, reports the committed seq), and a scratch repo with a bare remote whose trunk carries seq 1..N with a working log at N+k (cadence reports k owed and names the ref).
4. tests/cli-doctor.test.ts row counts unchanged: both rows keep their name and position.
<!-- SECTION:PLAN:END -->
