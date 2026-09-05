---
id: APRV-262
title: >-
  Anchor resolution and publishedState find no committed log in a checkout where
  git show origin/main:<log> succeeds: the daemon reports anchor none and
  highest published seq 0, and the cadence advance refuses
status: To Do
assignee: []
created_date: '2026-09-05 09:59'
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
- [ ] #1 A test reproduces the failure against a scratch clone with a bare origin whose main carries the log (mirroring the primary checkout's ref layout: refs/remotes/origin/main plus refs/approval/advance/* refs) and passes after the fix; approval log verify --anchor in the primary reports pass or behind, never a skip, when origin/main carries the log
- [ ] #2 The daemon's started line names the anchor, log-advance-cadence counts owed records against the highest published seq on origin/main, and the cadence advance proceeds past a seq the trunk already carries
- [ ] #3 When every rev fails the skip reason includes the git command that failed and its stderr, and doctor's log-drift row surfaces it
- [ ] #4 npm test passes; lint clean
<!-- AC:END -->
