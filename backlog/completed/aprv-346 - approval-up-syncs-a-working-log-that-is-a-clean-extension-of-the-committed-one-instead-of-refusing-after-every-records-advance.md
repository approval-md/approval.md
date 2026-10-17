---
id: APRV-346
title: >-
  approval up syncs a working log that is a clean extension of the committed one
  instead of refusing after every records advance
status: Done
assignee:
  - '@opus-lane-ergonomics'
created_date: '2026-09-16 23:59'
updated_date: '2026-09-17 00:35'
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
- [x] #1 approval up on a working log that is a byte-for-byte extension of origin/main's committed log performs the reconcile sync does, prints one line saying what it fast-forwarded and how many local records it kept, and starts the daemon
- [x] #2 approval up on two chains that share a prefix and then differ still refuses with up-preflight-log-diverged and the current next steps; a held append lock or unrelated dirty paths still refuse as today
- [x] #3 The reconcile is implemented once, in log sync's code path, and up calls it; tests through the real append path cover the clean extension, the fork, and the locked cases
- [x] #4 README and docs/cli-reference.md describe up's automatic sync and the fork as the only case that needs approval log sync by hand
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. preflight.ts gains a read-only planLogSync that fires only when the protected-path collision is the routine one: the log sits at the default repo-relative path, no other upstream-touched path is dirty, and compareChains of the working log against the log blob at the fetched target answers anything but diverged. An unverifiable side answers null, fail closed. inspectPreflight returns the plan on its ok shape; a null plan keeps today's up-preflight-log-diverged refusal byte for byte.

2. runPreflight calls logSync before its own merge when the plan is present, so the APRV-215 guards stay the single implementation. A logSync refusal becomes the same up-preflight-log-diverged refusal with the sync code and message added to YOUR STATE, and nothing starts.

3. Facts gain log_synced, an additive json field, and a new preflight_sync event carries the synced line naming the remote tip and how many local records were kept. up.ts and daemon.ts get it through PreflightEvent.

4. doctor main-behind-origin names the same plan when it finds one and stays a fail for a real fork.

5. Tests in tests-cli-up-preflight build records through appendAttestation, the real append path, and drive the built CLI: clean extension, fork, held append lock.

6. README and the cli reference describe the fork as the only remaining hand-run approval log sync.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented. inspectPreflight now asks planLogSync whether the protected-path collision is the routine one and returns a PreflightSyncPlan on its ok shape; runPreflight delegates the reconcile to logSync before its own fast-forward, so the APRV-215 ceremony stays the single implementation and this module supplies a caller rather than a copy.

Fail-closed by construction: planLogSync answers null, and the old refusal stands, unless all four hold. The log is the repository's own default path, no other upstream-touched path is dirty, both chains verify clean through compareChains, and the relation is a prefix one. SPEC 11.1 invariant 'enforcement paths read only verified records' is the reason the third is a refusal rather than a best guess: compareChains verifies each side before it compares a single seq, so an unverifiable log can never become a reconcile.

A logSync refusal after the plan was found (a held lock, an appender that won the race, git) comes back as the same up-preflight-log-diverged code with the sync code and message in YOUR STATE, so the frozen four-code union is unchanged. A distinct code whose repair is another code's repair would be a synonym, not a distinction.

PreflightFacts gains log_synced and the event union gains preflight_sync. Both additive: no field was added to a shape that already existed, and the frozen-fact-set test in tests-cli-up-preflight lists log_synced explicitly so a further field cannot appear without a line changing there.

Verification: node scripts-run-tests --only cli-up-preflight is 38 tests, 38 pass, 0 fail, exit 0, with six new cases. A working log that extends the committed one is synced and up starts; the sync line names the tip and the kept count; a fork still refuses; a held append lock refuses and names log-sync-locked; a dirty unrelated path still refuses; doctor names the reconcile. A second run over cli-log-verbs, cli-doctor, up, cli-help, cli-long-help and the daemon suites is 202 tests, 202 pass, 0 fail, exit 0. Build, typecheck and lint all exit 0.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval up's preflight now tells the routine protected-path collision from a fork. planLogSync compares the working chain against the log blob at the fetched tip through core-log-reconcile, the same comparison log sync and doctor's log-drift use; a prefix relation is delegated to logSync, which performs its whole APRV-215 ceremony, and up prints 'synced: fast-forwarded to origin-main <sha>, kept K local records' before starting. A fork, an unverifiable chain, a held append lock or a dirty unrelated path all keep the up-preflight-log-diverged refusal, unchanged. Verified by six new cases in tests-cli-up-preflight built through appendAttestation, the real append path, driving the built CLI: 38 tests, 38 pass, 0 fail, exit 0; 202 pass 0 fail across the neighbouring suites.
<!-- SECTION:FINAL_SUMMARY:END -->
