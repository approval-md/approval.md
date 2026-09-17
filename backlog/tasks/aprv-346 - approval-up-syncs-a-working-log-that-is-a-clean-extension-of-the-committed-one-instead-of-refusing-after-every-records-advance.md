---
id: APRV-346
title: >-
  approval up syncs a working log that is a clean extension of the committed one
  instead of refusing after every records advance
status: To Do
assignee: []
created_date: '2026-09-16 23:59'
labels:
  - cli
  - daemon
  - ergonomics
dependencies: []
priority: high
ordinal: 263000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
approval up's preflight refuses with up-preflight-log-diverged whenever origin/main changed .approval/log/events.jsonl and the working copy did too, and tells the human to run approval log sync and then up again. Since every records advance moves origin/main's log while the hook keeps appending locally, this is the normal state after every advance rather than an edge case: on 2026-09-16 the restart after PR #402 merged hit it, and the same refusal hit twice the week before. The preflight already has the information to tell the safe case from the dangerous one, because log sync's own check distinguishes a working log that is a byte-for-byte extension of the committed copy (main's records 1..N appear unchanged, local records N+1.. follow; nothing rewound, nothing moved) from two chains that share a prefix and then differ. Change: when the working log is a clean extension, up runs the same reconcile sync performs, reports it in one line (synced: fast-forwarded to origin/main <sha>, kept K local records), and starts; it keeps refusing, with the current message, when the chains have diverged, when the working tree carries changes an advance may not carry, or when another process holds the append lock. The existing sync guards (APRV-215: a dirty working log plus an upstream change is sync's, always) stay the single implementation; up calls it rather than copying it. README and docs/cli-reference.md then describe the one remaining two-step ritual, the fork, as the case that deserves a human's attention. Related: APRV-215, APRV-203, APRV-341, APRV-342.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval up on a working log that is a byte-for-byte extension of origin/main's committed log performs the reconcile sync does, prints one line saying what it fast-forwarded and how many local records it kept, and starts the daemon
- [ ] #2 approval up on two chains that share a prefix and then differ still refuses with up-preflight-log-diverged and the current next steps; a held append lock or unrelated dirty paths still refuse as today
- [ ] #3 The reconcile is implemented once, in log sync's code path, and up calls it; tests through the real append path cover the clean extension, the fork, and the locked cases
- [ ] #4 README and docs/cli-reference.md describe up's automatic sync and the fork as the only case that needs approval log sync by hand
<!-- AC:END -->
