---
id: APRV-149
title: >-
  CI wall-clock: compile once, shard the suite, prove the Node floor in the
  queue
status: Done
assignee:
  - '@fable-wave1'
created_date: '2026-08-29 05:37'
updated_date: '2026-08-29 20:40'
labels:
  - ci
  - infra
dependencies: []
priority: medium
ordinal: 134000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The full gate takes roughly nine to ten minutes per run and every landed PR pays it twice (pull_request event, then the merge-queue candidate), so a landing costs about twenty minutes of waiting. Raised by the human 2026-08-28 (the musing was "switch them off"; the answer is to keep the gate and remove the waste). Three sources of waste, identified by reading ci.yml and scripts/run-tests.mjs: (1) TypeScript compiles three times per full-gate job, because the workflow runs `npm run build`, then `npm test` (whose script is `tsc && node scripts/run-tests.mjs`), then `npm run typecheck` (`tsc --noEmit`), and the second and third passes catch nothing the first did not; (2) the test suite dominates the job and runs as one `node --test` invocation over ~95 files, so on two-core GitHub runners wall clock is bounded by a single pool, which sharding the file list across a small matrix would cut to the slowest shard; (3) the Node 20 floor leg runs on every pull_request although the merge_group run is the one that stands between a candidate and main. Deliberately kept, stated so nobody relitigates it from symptoms: the double PR-plus-queue full gate (the queue run caught the APRV-114/117 cross-PR semantic conflict that both PRs own CI passed), the fail-closed tier classifier, and the single required `ci` aggregator (APRV-44). CI config edits are approval-class; the change lands through the ordinary gated PR path.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A full-gate CI job compiles TypeScript exactly once; tests and typechecking add no second or third tsc pass, and the local `npm test` behavior (build then run) is unchanged for humans
- [x] #2 The full-gate test run is sharded across parallel jobs with deterministic, non-overlapping, exhaustive file assignment; a file matched by no shard or an empty shard fails the run rather than shrinking it, and the `ci` aggregator requires every shard
- [x] #3 The Node 20 floor runs on merge_group (and push to main) but no longer blocks pull_request feedback; the queue still proves the floor before anything becomes main
- [x] #4 Records and light tiers keep their current speed and semantics; the classifier and the required `ci` aggregator contract (skipped-when-required is a failure) are unchanged
- [x] #5 Measured before/after wall-clock for a full-tier PR is recorded in the implementation notes, from real runs
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Runner (scripts/run-tests.mjs): make the module importable (invokedDirectly guard, the pattern classify-tier.mjs already uses) and export discoverTestFiles/selectShard/parseRunnerArgs. Add --shard <k>/<n>: file at sorted position i belongs to shard (i mod n) + 1, with a comment stating why that is exhaustive and non-overlapping. Fail closed: a spec that is not <k>/<n>, a count below 1, an index outside 1..n, an empty selected shard, and --only combined with --shard are all hard errors. --only keeps its exact wording and behavior.
2. Workflow (.github/workflows/ci.yml), one batched approval-class edit, last: the full job becomes node 22 with a 3-shard matrix running npm ci, npm run build, node scripts/run-tests.mjs --shard k/3, npm run lint, so tsc runs once per job instead of three times (no npm test, no npm run typecheck). A new full-floor job runs node 20 unsharded, gated on tier == full AND (merge_group OR push to refs/heads/main). The ci aggregator needs full-floor as well, requires success from it on the queue and push-to-main paths, and requires it to be skipped or successful elsewhere; the full branch requires the whole shard matrix (GitHub reports one result for a matrix job, success only when every shard succeeded). light and records jobs untouched.
3. Guards (tests/ci-guard.test.ts): rewrite the Node-major and full-gate-steps tests for the new job shape, assert compile-once (no npm test / npm run typecheck anywhere in the full-tier jobs), assert the shard matrix is [1,2,3] and each step passes its own index with denominator 3, assert the floor job version, its event condition, and the aggregator needs/branches. Add shard-selection tests: partition properties over the real discovered list and over synthetic lists, plus spawned refusals for an out-of-range index, an empty shard, and --only with --shard.
4. README tier table: the full row is stale once tsc runs once and the floor moves to the queue; update it and the sentence about the two-major matrix.
5. Verify: npm test green, node scripts/run-tests.mjs --shard 1/3 2/3 3/3 counts summing to the discovered count with disjoint sets, npm run lint. AC5 (before/after wall clock from real runs) can only close after the PR runs in CI; local shard timings and file counts go in the notes as the interim evidence.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Implementation (2026-08-29, branch aprv-149-final)

Ported from an earlier uncommitted attempt (branch aprv-149-ci-wallclock, base 13b86e2) and
re-applied semantically onto current main (e31ffff). The four touched files were byte-identical
to that older base on main, so the port was a clean re-apply rather than a merge; nothing was
carried over that main had since changed.

**scripts/run-tests.mjs** — new. The script became an importable module: discovery and both
selectors are exported functions (`discoverTestFiles`, `selectShard`, `parseRunnerArgs`) and the
CLI runs only under the `invokedDirectly` guard that classify-tier.mjs already uses, so a test can
exercise selection without spawning the suite it is part of. `--shard <k>/<n>` assigns the file at
sorted position i to shard (i mod n) + 1; the doc comment states why that is exhaustive and
non-overlapping rather than leaving it to be assumed. Round-robin, not contiguous blocks:
neighbouring names in a sorted list are one subsystem and one cost profile, so interleaving spreads
the slow files instead of stacking them. Fail-closed additions, all in the runner's existing voice:
a spec that is not <k>/<n>, a count below 1, an index outside 1..n, an empty selected shard, an
unknown option, a bare positional, `--only` with no names, and `--only` combined with `--shard`
are each a hard error with an explanation of what the refusal is protecting. `--only` keeps its
exact wording and behaviour.

**.github/workflows/ci.yml** — the `full` job is now Node 22 with a `shard: [1, 2, 3]` matrix
running npm ci, npm run build, `node scripts/run-tests.mjs --shard k/3`, npm run lint. tsc runs
once per job instead of three times: no `npm test` (which recompiles), no `npm run typecheck`
(which recompiles again), neither able to fail where the build passed. Lint stays in every shard on
purpose, so a shard is a complete verdict on what it built. A new `full-floor` job runs Node 20
unsharded, gated on tier == full AND (merge_group OR push to refs/heads/main). package.json is
untouched: `npm test` is still `tsc && node scripts/run-tests.mjs` for humans, who have not built.

**The `ci` aggregator** needs `full-floor` as well. `full` is the whole matrix (GitHub reports one
result for a matrix job, `success` only when every shard succeeded), so requiring it requires all
three shards. The floor leg is conditional, and a conditional job whose absence is never checked is
a job that can quietly stop running, so the aggregator computes `FLOOR_REQUIRED` from the same
event condition the job itself uses: queue and push-to-main require `success`, every other event
requires `skipped` or `success`. A `failure`, a `cancelled`, or a vanished floor leg on an event
that owes one all fail the required check. Skipped-when-required stays a failure for every tier;
the light and records jobs and the classifier are untouched.

**tests/ci-guard.test.ts** — the pins moved to the new shape deliberately, and what they guard got
stronger, not weaker. The old node-matrix pin ([20, 22] on one job) became two assertions that both
majors are still exercised (`full` on 22, `full-floor` on 20) with the floor's original reasoning
kept verbatim in the failure message. The old "whole standing gate" pin (which required `npm test`
and `npm run typecheck` to be present) was inverted into a compile-once assertion that both are
absent from both full-tier jobs, since the property it protected (the full tier runs everything) is
now carried by the partition tests instead. New: the shard axis must be exactly 1..n and the
denominator passed to the runner must equal the number of matrix entries, so a matrix that does not
cover its own partition fails; the floor leg's event condition, its lack of a matrix, and its
unsharded command; the aggregator's needs, env, and FLOOR_REQUIRED branches, plus a cross-check
that the floor leg's own `if` and the aggregator's FLOOR_REQUIRED name the same clauses (or one of
them is dead). Selection itself is tested as a partition property over the real discovered list at
counts 1..7 and over synthetic lists of size 0..12 at counts 1..6, and every non-partition request
is spawned and asserted to refuse.

**README.md** — the tier table's full row and a new paragraph on compile-once, the shard rule, the
refusals, and why the floor moved to the queue.

### Verification (local, macOS, 2026-08-29)

- `npm test`: 2311 tests, 2311 pass, 0 fail.
- `npm run lint` (oxlint src tests): clean.
- Shards sum to the whole suite exactly, which is the property the matrix rests on:
  | run | files | tests | duration |
  | --- | --- | --- | --- |
  | full | 94 | 2311 | 202.0 s |
  | --shard 1/3 | 32 | 749 | 57.2 s |
  | --shard 2/3 | 31 | 606 | 91.6 s |
  | --shard 3/3 | 31 | 956 | 84.1 s |
  | shards summed | 94 | 2311 | — |

  32 + 31 + 31 = 94 discovered files and 749 + 606 + 956 = 2311 tests, so the three shards are
  non-overlapping and exhaustive by count as well as by the partition test.

### AC5 status: open

AC5 asks for measured before/after wall clock from real runs, and that can only be read off CI once
this branch runs there. Interim evidence, local and single-machine: the slowest shard is 91.6 s
against 202.0 s for the unsharded suite, so the test phase of the full tier should fall to roughly
45% of its former wall clock, before the two tsc passes the job no longer runs and the second whole
Node-20 suite a pull request no longer waits for. GitHub's two-core runners are slower and more
contended than this machine, so treat the ratio as indicative and the absolute numbers as not
transferable. Close AC5 against the actual before/after run times on the PR.

Merged: PR #148 as main 60cd170 through the merge queue. AC5 closed with measured wall clock from the PR own CI runs: the pull_request event (sharded node 22 matrix, no floor) ran 20:12:01Z to 20:16:27Z, 4m26s, against the roughly 9-10 minute pre-change full gate; the merge-queue candidate (shards plus the unsharded node 20 floor) ran 12m59s, in line with pre-change candidates (12m36s-12m41s), since the queue keeps the full-rigor floor leg by design. Local interim evidence recorded earlier: 2311 tests in 202s unsharded, shards of 32/31/31 files running 749/606/956 tests in 57/92/84s, summing exactly. AC1 compile-once verified by the ci-guard assertions that npm test and npm run typecheck are absent from both full-tier jobs; AC2 sharding fail-closed pinned by partition tests over real and synthetic file lists plus spawned refusals for out-of-range, empty shard, malformed spec, and --shard with --only; AC3 floor-leg condition, aggregator FLOOR_REQUIRED, and their clause-for-clause cross-check pinned; AC4 classifier and light/records tiers untouched (their guard pins unchanged). Salvage lineage: the wave-1b agent drafted the four-file diff under the closed gate; the finisher re-applied it onto e31ffff (files byte-identical to its base), fixed one stale comment, and landed the ci.yml edit through the gate. Two process notes: the finisher used a heredoc for its commit message and the hook permitted it (a classifier leniency worth remembering during APRV-150 planning), and the guard suite grew a floor-if-versus-FLOOR_REQUIRED consistency check so the two conditions cannot drift apart.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
CI compiles once per job, the node 22 full gate runs as a 3-shard matrix, and the node 20 floor runs only where it decides something (merge_group and push to main). Measured: PR feedback 4m26s versus roughly 9-10 minutes before; queue candidates hold about 13 minutes with the full floor. Sharding is fail-closed (partition proven, empty and out-of-range refuse) and the required ci aggregator keeps skipped-when-required-is-a-failure. Merged as PR #148 (main 60cd170).
<!-- SECTION:FINAL_SUMMARY:END -->
