---
id: APRV-360
title: >-
  approval policy apply publishes its own branch by refspec from a synced main,
  never a branch switch in the primary
status: To Do
assignee: []
created_date: '2026-09-18 00:53'
updated_date: '2026-09-18 00:55'
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
Observed 2026-09-18 (seq 44188, PR 439). approval policy apply docs/proposals/policy-2026-09-18.md, run without --pr as the handover and runbook-2026-09-17 step 4 wrote it, ran the amend without --commit, so the ceremony stopped after the attestation and printed the manual runbook from src/cli/amend.ts (the git checkout -b policy-amend-<seq> origin/main form, line 1692 at b558657). On a primary whose local main was 14 commits behind origin/main the checkout refused (QUEUE.md, the working log and six payloads would be overwritten) and the ceremony stalled with an edited, attested, unpublished policy. A branch switch in the primary is also the shape that forked the log on 2026-09-16. amend --pr already does the right thing (APRV-203 scratch index on the remote tip, refspec push, PR, --auto arm, HEAD untouched), so the fix is small: (1) the printed fallback runbook is the refspec form on a synced main (approval log sync, commit on local main, git push origin HEAD:refs/heads/policy-amend-<seq>, gh pr create, gh pr merge --auto --merge) and never a checkout; (2) approval policy apply, whose whole purpose is one command for the human, passes --pr to the amend by default, with --no-publish to opt out; (3) docs/cli-reference.md and docs/proposals/README.md show the apply line without a trailing flag to remember. The recovery used on 2026-09-18 is in the APRV-360 notes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval policy apply, after a successful amend, publishes policy-amend-<seq> from origin/main via a scratch index and refspec push, opens the PR and arms auto-merge, without changing the checked-out branch or touching the working tree
- [ ] #2 When local main is behind origin/main the verb still succeeds, and a diverged log is refused with the log-diverged code rather than a git error
- [ ] #3 Any printed fallback runbook contains no git checkout of a branch
- [ ] #4 Tests cover the behind-origin case with a fixture repo built through the real append path
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Recovery used live on 2026-09-18 after the refused checkout: git checkout -- the two daemon envelope write-backs (aprv-199, aprv-306), approval log sync (fast-forward 14 commits, log an extension of main, six payloads proved identical), git add APPROVAL.md and the log, git commit, git push origin HEAD:refs/heads/policy-amend-44188, gh pr create --base main --head policy-amend-44188, gh pr merge policy-amend-44188 --auto --merge. PR 439.
<!-- SECTION:NOTES:END -->
