---
id: APRV-159
title: >-
  CI: shard the Node 20 floor leg so queue candidates stop paying the unsharded
  suite
status: Done
assignee:
  - '@claude'
created_date: '2026-08-30 20:56'
updated_date: '2026-08-30 23:53'
labels:
  - ci
  - infra
dependencies: []
ordinal: 143000
approval:
  origin:
    app: manual
    created_by: 'agent:fable'
  route:
    assignee: 'agent:fable'
    rationale: >-
      CI-config change built on branch aprv-159-floor-shard by a spawned agent
      whose protected-path Edit on .github/workflows/ci.yml raised no gate
      prompt (APRV-151 shape, evidence on that task). Publishing the branch was
      therefore routed explicitly: the grant blessed pushing the change for
      review; the merge to main stayed its own approval.
  state: executed
  actions:
    - class: policy.edit
      summary: >-
        git push origin aprv-159-floor-shard from /Users/carter/dev/approval-md:
        publish the APRV-159 CI change (full-floor becomes the same 3-shard
        matrix as the Node 22 gate; aggregator untouched; ci-guard pins updated;
        README tier row updated). Local: 2402 tests pass, lint clean, base
        759e4eb.
      reversible: true
      est_cost_usd: '0'
      idempotency_key: 'aprv-159:publish-ci-floor-shard:2026-08-30'
      payload_hash: '8885e1a86bbbae7c4aa1803f2a4c01d7a077dc77c383f625d27f4bca7497d941'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-149 cut pull_request feedback from ~9-10 min to ~4.5-6 min but deliberately left the merge-queue candidate at ~11-14.5 min (measured on merge_group runs 2026-08-29/30) because the full-floor job runs the whole 2311-test suite unsharded on Node 20. With per-task PRs, every landing pays that queue candidate serially, which the human has flagged repeatedly as the dominant drag (~12+ min per task). Fix: run the floor leg as the same 3-shard matrix the Node 22 full gate uses (scripts/run-tests.mjs --shard k/3 already exists and is partition-proven fail-closed). Queue candidate wall clock becomes roughly max-of-shards (~6-7 min), and nothing is sacrificed: the floor still runs in full on merge_group and push-to-main, the ci aggregator still requires the whole matrix (GitHub reports one result per matrix job, success only when every shard succeeds). Requires updating tests/ci-guard.test.ts pins (floor job shape, unsharded-command assertion, aggregator cross-checks) and the README tier table sentence about the floor. CI config edits are approval-class: the ci.yml edit lands through the ordinary gated PR path.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 full-floor runs as a 3-shard matrix on Node 20 with the same fail-closed shard semantics as the Node 22 gate, still gated on merge_group or push-to-main only
- [x] #2 The ci aggregator requires the whole floor matrix wherever FLOOR_REQUIRED is true; skipped-when-required stays a failure; light/records tiers and the classifier untouched
- [x] #3 tests/ci-guard.test.ts pins the new floor shape (matrix axis, per-shard command, event condition, aggregator cross-check) and npm test is green
- [x] #4 Measured before/after merge_group wall clock from real queue runs recorded in implementation notes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read tests/ci-guard.test.ts pins for full-floor and the aggregator, scripts/run-tests.mjs shard mechanics (already partition-proven), README tier table.
2. Change .github/workflows/ci.yml: full-floor gains strategy.matrix shard [1,2,3] and runs node scripts/run-tests.mjs --shard k/3; name reflects the shard; event condition and aggregator FLOOR_REQUIRED semantics unchanged (matrix job reports one aggregate result, so the aggregator needs no edit unless a pin says otherwise).
3. Update ci-guard tests: floor job now sharded (matrix axis exactly 1..3, denominator matches entries, per-shard command), keep the event-condition and aggregator cross-check pins, drop/invert the unsharded-floor assertion.
4. Update the README sentence describing the floor leg as unsharded.
5. Verify: npm test green locally; the ci.yml edit is approval-class and lands through the gate (prompt must fire; silent success on a protected path is an APRV-151-class incident and stops the work).
6. AC4 (measured merge_group before/after) closes after the PR rides the queue.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built by an Opus subagent in an isolated worktree (base 759e4eb, branch aprv-159-floor-shard, commit 2dd92ed); diff reviewed by fable. floor leg now the same 3-shard matrix; aggregator verified untouched (matrix job reports one aggregate result). Local: 2402 tests pass, lint clean. INCIDENT: the subagent's Edit to .github/workflows/ci.yml raised no gate prompt (APRV-151 shape; evidence commented on APRV-151). Remediation: branch quarantined unpushed; publish routed explicitly through the live gate from the orchestrating session — envelope on this task file, register seq 2909 (after 4 attempts racing concurrent hook appends, APRV-150 shape), request seq 2911 (policy.edit, manual), Telegram grant seq 2919, manual token handed by Carter, approval run executed git push at seq 2957-2958 exit 0. PR: https://github.com/approval-md/approval.md/pull/154. AC4 stays open until the PR's own merge_group run provides the measured after wall clock. Envelope schema note: est_cost_usd must be a string post-APRV-121.

AC4 closed with real queue runs: the grouped candidate carrying PR #154 + #155 ran as two merge_group builds at 7m42s (23:32:44-23:40:26) and 7m46s (23:33:35-23:41:21) on 2026-08-30, against 11.7-14.5 min for the four pre-change candidates measured the same day. The candidates' own trees carried the sharded floor, so the effect applied immediately. Merged as PR #154 (main, 23:40:53Z). Combined with queue grouping (maximumEntriesToBuild 5, minimumEntriesToMerge 1, wait 0), the two PRs landed 52 seconds apart off one candidate build.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The Node 20 floor leg runs as the same 3-shard matrix as the Node 22 gate; aggregator untouched, guard pins strengthened. Measured: merge-queue candidates dropped from 11.7-14.5 min to ~7.7 min (real runs both sides). Landed as PR #154 after an explicit gate ceremony for the CI-config publish (policy.edit, granted seq 2919, executed 2957-2958) occasioned by a hook miss logged on APRV-151.
<!-- SECTION:FINAL_SUMMARY:END -->
