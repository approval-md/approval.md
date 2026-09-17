---
id: APRV-341
title: >-
  approval policy amend --pr: the amend commits the policy and its attestation,
  pushes, opens the pull request and arms the merge
status: Done
assignee:
  - '@opus-lane-ergonomics'
created_date: '2026-09-16 17:59'
updated_date: '2026-09-17 00:59'
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
- [x] #1 approval policy amend --pr appends the attestation, then commits exactly APPROVAL.md and events.jsonl on a scratch index based on origin/main, pushes policy-amend-<seq>, opens the pull request (or updates an open one for that branch) and arms the auto-merge; the checkout ends the verb on the same branch with the same index and working tree
- [x] #2 A dirty working tree, staged unrelated paths, or an origin/main that already carries a later policy edit each refuse with a distinct machine-readable code before anything is pushed; the attestation is never withheld or duplicated by a refusal of the git half
- [x] #3 Without --pr, or when gh is unavailable, the verb prints the runbook it prints today, byte for byte
- [x] #4 Tests exercise the commit content (exactly two paths), the refusal codes, and the idempotent second run; docs/cli-reference.md and docs/dogfood-cutover.md describe the flag
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. amend.ts gains a --pr boolean that implies --commit and forces the branch flow. --pr with --direct or --no-publish are usage errors. The scratch-index commit builder is already shared: git-scope commitOnBase, the APRV-203 path both this verb and log advance call, so nothing is copied or extracted.

2. planCommit's failure gains a code so the two conditions AC2 names get distinct machine-readable codes: staged-unrelated for an index carrying anything beyond the ceremony files, dirty-tree for a ceremony file whose index and working tree disagree. base-policy-diverged already covers an origin that carries a later policy edit. All three fire before the attestation.

3. The PR step becomes create-or-update: gh pr list --head names an open request, and the verb edits its title and body instead of failing gh pr create. That is what makes a second run idempotent.

4. Without --pr the printed runbook is untouched, pinned by a fixture test over the six commands.

5. Tests in tests-cli-amend: exact two-path commit content with an unrelated dirty working tree, both refusal codes, the create-or-update path, and an unchanged runbook. Docs: the cli reference and the dogfood cutover runbook.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented as a --pr flag on approval policy amend. The scratch-index builder APRV-203 uses, git-scope commitOnBase, is already shared with log advance, so nothing was copied and no extraction was needed; --pr forces the branch flow whatever the protection probe answered, and the existing APRV-130 publishing half pushes, opens the PR and arms gh pr merge --merge --auto. --pr with --direct or --no-publish are usage errors.

The PR step became create-or-update: gh pr list --head names an open request and the verb edits its title and body instead of failing at gh pr create. publishing.prUpdated reports which happened. A gh that cannot answer falls through to create, the path that was there before.

DECISION on AC2's 'dirty working tree'. A literal refusal on any unstaged path outside the ceremony files would be a defect rather than a guard: the scratch index lays exactly the ceremony paths over the remote tree, so nothing else can reach the commit, and the primary checkout carries daemon envelope write-backs on task files as a matter of course, so the refusal would have blocked the very ceremony it is meant to protect. What IS refused, with its own code dirty-tree, is a ceremony file staged in one state and modified again in the working tree: the commit takes the working-tree bytes, so the operator would be signing for bytes their staged diff never showed. staged-unrelated is the second distinct code, split out of commit-preconditions, and base-policy-diverged already covers an origin carrying a later policy edit. The reading is flagged for the human.

SPEC 11.1 global invariants touched: none is weakened. The attestation still goes through appendAttestation's compare-and-append, refusals are machine-readable and distinct by repair, and no self-reported field reduces scrutiny: --pr chooses a ceremony, it does not choose a policy class. The verb stays policy.core and human-only.

Verification: node scripts-run-tests --only cli-amend is 97 tests, 97 pass, 0 fail, exit 0, with seven new cases. Exactly two paths in the commit while the working tree carried an untracked backlog task file; the checkout's branch, HEAD, index, other-path status and policy bytes are deep-equal before and after; a second run edits the open PR and never calls gh pr create; a re-run with nothing to amend is a no-op that attests nothing twice; both new codes fire before the attestation and before any push; base-policy-diverged likewise; the two usage errors; and a fixture pinning the six runbook commands printed without --pr. A wider run over cli-amend, cli-help, cli-long-help and cli-doctor is 204 tests, 204 pass, 0 fail, exit 0. Build, typecheck and lint exit 0.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The amend verb finishes the ceremony under a new --pr flag: it implies --commit, forces the branch flow, and the existing publishing half pushes policy-amend-<seq>, opens or UPDATES that branch's pull request, and arms the auto-merge. The commit is assembled by the shared scratch-index builder that log advance already uses, so the verb checks nothing out and the checkout ends on the same branch with the same HEAD, index and working tree, which removes the cause of the 2026-09-16 fork. Two refusal codes were split out and are distinct by repair, staged-unrelated and dirty-tree, both firing before the attestation. Verified by seven new cases: 97 tests, 97 pass, 0 fail, exit 0.
<!-- SECTION:FINAL_SUMMARY:END -->
