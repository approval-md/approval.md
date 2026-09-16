---
id: APRV-341
title: >-
  approval policy amend --pr: the amend commits the policy and its attestation,
  pushes, opens the pull request and arms the merge
status: To Do
assignee: []
created_date: '2026-09-16 17:59'
labels:
  - cli
  - policy
  - ergonomics
dependencies: []
priority: high
ordinal: 259000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
After appending the attestation, approval policy amend prints a six-command runbook (fetch, branch policy-amend-<seq>, add APPROVAL.md and events.jsonl, commit, push, gh pr create) and asks the human to run it and then merge with a merge commit. That is the gap APRV-284 closed for the records log with approval log advance --pr, and the same shape applies here: the verb already owns the ceremony and should finish it. With --pr the verb builds one commit carrying exactly APPROVAL.md and .approval/log/events.jsonl in a scratch index on origin/main (the APRV-203 pattern from log advance, so a dirty working tree such as daemon envelope write-backs on task files never rides along), pushes policy-amend-<seq>, opens the pull request with the body it already composes, and arms gh pr merge --merge --auto; the merge queue lands it. The printed runbook stays as the fallback when gh is missing or --pr is not passed. Safe to automate because the whole flow is policy.core, run only by a human who has already typed the amend, and the commit is deterministic from the log state; nothing asks a second question. Motivating instance: 2026-09-16, attestation seq 32573, PR #397, done by hand. Related: APRV-284, APRV-203, APRV-215.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval policy amend --pr appends the attestation, then commits exactly APPROVAL.md and events.jsonl on a scratch index based on origin/main, pushes policy-amend-<seq>, opens the pull request (or updates an open one for that branch) and arms the auto-merge; the checkout ends the verb on the same branch with the same index and working tree
- [ ] #2 A dirty working tree, staged unrelated paths, or an origin/main that already carries a later policy edit each refuse with a distinct machine-readable code before anything is pushed; the attestation is never withheld or duplicated by a refusal of the git half
- [ ] #3 Without --pr, or when gh is unavailable, the verb prints the runbook it prints today, byte for byte
- [ ] #4 Tests exercise the commit content (exactly two paths), the refusal codes, and the idempotent second run; docs/cli-reference.md and docs/dogfood-cutover.md describe the flag
<!-- AC:END -->
