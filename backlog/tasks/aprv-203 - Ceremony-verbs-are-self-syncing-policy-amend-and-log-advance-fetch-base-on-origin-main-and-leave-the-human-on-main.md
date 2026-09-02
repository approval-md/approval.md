---
id: APRV-203
title: >-
  Ceremony verbs are self-syncing: policy amend and log advance fetch, base on
  origin/main, and leave the human on main
status: To Do
assignee: []
created_date: '2026-09-02 00:29'
labels:
  - dogfood
  - cli
dependencies: []
priority: high
ordinal: 167000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Today's two amend ceremonies (seq 7355 and 7413) and the advance between them each needed the human to run git fetch plus git reset --keep origin/main by hand first, and the second amend still went wrong: the amend verb commits on the branch you are standing on, so a primary checkout whose local main had not been synced produced a policy-amend branch stacked on the previous ceremony commit (without that ceremony's test pins), which failed CI until the orchestrator rebased it. The advance verb has the same shape (PRIMARY CHECKOUT ONLY, commits on the current branch, checks out nothing). A human running a ceremony should not need to know any of this. Outcome: the ceremony verbs own their own git preconditions. Before committing, amend and advance fetch the remote, refuse (machine-readable) if the live log or the policy file in the working tree diverges from origin/main in a way the verb cannot reconcile, base the ceremony commit on origin/main rather than on whatever the local branch holds, push by refspec as today, and leave the checkout exactly as they found it (on main, working tree untouched apart from the ceremony's own edit). Amend additionally runs the dogfood policy suite against the amended file before pushing and prints the expected pin diff when it fails, so a red ceremony PR is caught on the laptop rather than in CI. Why: the human's part of a ceremony is the decision and the tap; every git step they are asked to perform is a place for the gate to be blamed for a divergence it could have prevented.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 policy amend run from a primary checkout whose local main is behind or diverged from origin/main produces a policy-amend branch whose parent is origin/main, and leaves the checkout on the branch it started on with its working tree unchanged apart from the amended policy file; covered by a test against a scratch repo with a stale local main
- [ ] #2 log advance fetches first and bases the records commit on origin/main when the local branch is behind; a diverged local main that cannot fast-forward is refused with a distinct machine-readable code that names the fix, and no commit is made
- [ ] #3 policy amend runs the dogfood policy suite (or an equivalent in-process check of every declared class resolution) against the amended file before pushing; on failure it prints the expectation diff and exits non-zero without pushing, and --commit can be re-run after the pins are staged
- [ ] #4 docs/dogfood-cutover.md and docs/cli-reference.md no longer instruct the human to fetch or reset before a ceremony; the runbook for a ceremony is edit, run the verb, tap
- [ ] #5 npm test passes; lint clean
<!-- AC:END -->
