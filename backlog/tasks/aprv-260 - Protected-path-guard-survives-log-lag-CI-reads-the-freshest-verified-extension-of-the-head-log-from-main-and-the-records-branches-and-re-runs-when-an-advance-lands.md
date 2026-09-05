---
id: APRV-260
title: >-
  Protected-path guard survives log lag: CI reads the freshest verified
  extension of the head log from main and the records branches, and re-runs when
  an advance lands
status: In Progress
assignee:
  - '@claude'
created_date: '2026-09-05 02:22'
updated_date: '2026-09-05 02:54'
labels: []
dependencies: []
references:
  - scripts/protected-path-guard.mjs
  - src/core/protected-path-guard.ts
  - .github/workflows/ci.yml
priority: high
ordinal: 198000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
PR #270 failed the protected paths (grant cross-check) job on AGENTS.md although the edit and its commit were both granted through the gate: the guard reads the log committed at the PR head, that copy trailed the primary live log by ~2800 records, and the grant sat in the live log until the daemon advanced it (records PR #269 carried seq 1..19207; the grant was 19219). Every gated protected-path edit made during a session hits this: the PR cannot go green until a later advance merges to main AND the branch merges main again, two human-visible waits for an edit a human already tapped. Fix in two parts, both deterministic and read-only. (1) The guard sources its log from the freshest verified extension of the head log: candidates are HEAD, origin/main and every origin/records-log-* branch; a candidate is admitted only if its committed log verifies clean and its record at the head log last seq carries the same hash (the APRV-219 anchoring rule: same chain, longer), and the longest admitted one is used, with payloads read at the same ref and falling back to head. The ordering-rule text names the records branches as a valid carrier. (2) A small workflow on push to main touching the log re-runs the failed protected-paths job of every open pull request, so a merged advance clears the check without a hand rerun or a branch push. Both changes touch .github/workflows (policy.edit) and go through the gate.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 scripts/protected-path-guard.mjs accepts the head log and any verified extension of it found at origin/main or origin/records-log-*, chooses the longest, reports which ref supplied the log in its output and in --json, and refuses a candidate whose prefix does not anchor to the head log (tests cover: head only, main longer, records branch longer than main, a diverging candidate rejected, an unverifiable candidate skipped)
- [ ] #2 The guard message for an uncovered path names the records branches as a carrier of the missing advance, and the CI job fetches the records refs it needs
- [ ] #3 A workflow triggered by a push to main that changes .approval/log/events.jsonl re-runs the failed protected-paths job on every open pull request (only that job, only when it failed), with a test or a dry-run script asserting the selection
- [ ] #4 docs/claude-code-hook.md backstop section explains the log-lag rule: a grant in the live log becomes evidence once any advance carrying it is pushed to a records branch or merged, and what a session does when the guard still fails
- [ ] #5 npm test, lint, typecheck pass; the guard run on this repository over origin/main~20..origin/main still passes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Guard script: read the log at head, origin/main and every origin/records-* ref; admit only candidates that verify clean and anchor to head's last record (same seq and hash); choose the longest; payloads at the chosen ref then head; --log-ref for tests; log_source in output and --json. 2. ORDERING_RULE names records branches as a carrier. 3. ci.yml fetches records-* refs and prints the provenance line; guard-rerun.yml re-runs the failed guard job on open PRs when a push to main changes the log, via scripts/guard-rerun.mjs with --dry-run. 4. Tests: script suite on fixture repos with real logs, rerun selector with a fake gh, ci-guard assertions. 5. docs/claude-code-hook.md: When the log lags.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built by an Opus lane on branch aprv-260-guard-log-lag. Decisions: anchoring is head-defined and fail-closed (a shorter or forked candidate is diverged; a missing, unverified or empty head log admits nothing); payload store read at the chosen ref then head; human output summarises diverged candidates (main carries 45 stale records branches), --json lists every candidate; blobs deduped by oid before verification; guard-rerun.yml holds actions:write and pull-requests:read only, concurrency guard-rerun, selects by the job name and cross-checks it against ci.yml in a test. Orchestrator change: the provenance grep in the CI step tolerates a missing line, since the guard's exit status is the verdict. Verified in the lane: npm test 3214 pass, 0 fail, 1 skipped; lint and typecheck clean; the guard over origin/main~20..origin/main exits 0 and reports origin/main chosen with records-log-2026-09-05 admitted. Both workflow writes passed the policy.edit gate without a wait.
<!-- SECTION:NOTES:END -->
