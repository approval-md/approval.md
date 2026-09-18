---
id: APRV-360
title: >-
  approval policy apply publishes its own branch by refspec from a synced main,
  never a branch switch in the primary
status: To Do
assignee: []
created_date: '2026-09-18 00:53'
labels:
  - cli
  - policy
  - bug
dependencies: []
priority: high
ordinal: 277000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-18 (seq 44188, PR 439). After the amend, approval policy apply printed a manual runbook: git fetch, git checkout -b policy-amend-<seq> origin/main, add the two files, commit, push, gh pr create, then merge by hand. It did not fetch or sync first, so on a primary whose local main was 14 commits behind origin/main the checkout refused (QUEUE.md, the working log and six payloads would be overwritten) and the ceremony stalled with an edited, attested-but-unpublished policy in place. Even when the checkout succeeds, a branch switch in the primary is the shape that forked the log on 2026-09-16 (session practice: never git checkout a branch in the primary). The verb should do what approval log advance does since APRV-203 and what APRV-341 gave amend --pr: build the ceremony commit through a scratch index on top of origin/main, push it by refspec to policy-amend-<seq>, open the PR and arm it with --auto --merge, leaving the working tree and branch untouched. If it must fall back to printing steps, the steps are the refspec form (approval log sync, commit on local main, git push origin HEAD:refs/heads/policy-amend-<seq>) and never a checkout.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval policy apply, after a successful amend, publishes policy-amend-<seq> from origin/main via a scratch index and refspec push, opens the PR and arms auto-merge, without changing the checked-out branch or touching the working tree
- [ ] #2 When local main is behind origin/main the verb still succeeds, and a diverged log is refused with the log-diverged code rather than a git error
- [ ] #3 Any printed fallback runbook contains no git checkout of a branch
- [ ] #4 Tests cover the behind-origin case with a fixture repo built through the real append path
<!-- AC:END -->
