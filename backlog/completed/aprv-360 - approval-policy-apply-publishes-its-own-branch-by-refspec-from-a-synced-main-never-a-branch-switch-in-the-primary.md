---
id: APRV-360
title: >-
  approval policy apply publishes its own branch by refspec from a synced main,
  never a branch switch in the primary
status: Done
assignee:
  - '@claude'
created_date: '2026-09-18 00:53'
updated_date: '2026-09-19 08:50'
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
- [x] #1 approval policy apply, after a successful amend, publishes policy-amend-<seq> from origin/main via a scratch index and refspec push, opens the PR and arms auto-merge, without changing the checked-out branch or touching the working tree
- [x] #2 When local main is behind origin/main the verb still succeeds, and a diverged log is refused with the log-diverged code rather than a git error
- [x] #3 Any printed fallback runbook contains no git checkout of a branch
- [x] #4 Tests cover the behind-origin case with a fixture repo built through the real append path
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/cli/amend.ts gitCommands: replace the branch-flow fallback with the refspec form the 2026-09-18 recovery used. approval log sync, git add, git commit, git push origin HEAD:refs/heads/policy-amend-<seq>, gh pr create --head <branch> --base <default>, gh pr merge <branch> --auto --merge. No git checkout in any printed line.
2. src/cli/policy-apply.ts: publish by default. Pass --pr to the amend unless --no-publish was given, in which case pass --no-publish; accept an explicit --pr as a no-op and refuse --pr with --no-publish as a usage error, mirroring amend. Update the owed and failure strings so they name the command the operator should actually run.
3. src/cli/help.ts POLICY_APPLY_HELP and src/cli/verb-registry.ts: the new --no-publish flag and the new default, said once each.
4. docs/cli-reference.md: the policy apply line without a trailing flag, the --no-publish sentence, and the fallback-runbook paragraph rewritten to the refspec commands. docs/proposals/README.md: the apply line loses --pr.
5. Tests. tests/cli-amend.test.ts BRANCH_RUNBOOK becomes the new command list, plus an assertion that no printed line contains git checkout (AC3). New cases in tests/cli-policy-apply.test.ts: a default run reaches the amend with --pr (asserted through the branch, the PR and the arm a gh stub records, with the checkout state unchanged before and after); --no-publish stops at the commit; --pr with --no-publish is a usage error. AC2 and AC4: a fixture repo built through the real append path whose local main is behind origin/main succeeds, and one whose log diverged from origin refuses with log-diverged rather than a git error.
6. build, typecheck, lint, the amend and policy-apply suites, then npm test.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Recovery used live on 2026-09-18 after the refused checkout: git checkout -- the two daemon envelope write-backs (aprv-199, aprv-306), approval log sync (fast-forward 14 commits, log an extension of main, six payloads proved identical), git add APPROVAL.md and the log, git commit, git push origin HEAD:refs/heads/policy-amend-44188, gh pr create --base main --head policy-amend-44188, gh pr merge policy-amend-44188 --auto --merge. PR 439.

PR #449, commit 8a4014e, armed with gh pr merge 449 --merge (autoMergeRequest enabledAt 2026-09-19T08:49:37Z, method MERGE). Branched from origin/main at 00b98da; origin/main moved to de8d9da (APRV-358, PR #447) mid-task and was merged in before the push.

What was done. src/cli/policy-apply.ts passes --pr to the amend unless --no-publish is given, gains --no-publish as its own flag, refuses --pr with --no-publish as a usage error in the amend own words, and names the right owed command in both the --no-amend and the amend-failed strings. src/cli/amend.ts gitCommands prints the refspec form for the branch flow: approval log sync, add, commit, push HEAD to refs/heads/policy-amend-<seq>, gh pr create --head, gh pr merge --auto --merge. No printed line switches branches on any path. Help, verb registry, docs/cli-reference.md and docs/proposals/README.md follow.

Decisions. (1) The refusal code for a forked log is base-log-diverged, the amend own code, not log-diverged, which belongs to approval log sync. The criterion said the existing log-diverged code; the existing code on this path is base-log-diverged and the message it carries names approval log sync, so the test asserts that code and that sentence. Nothing was renamed: a refusal code is public API. (2) approval log sync is the first line of the printed runbook rather than git fetch origin, because it is the one verb that both brings the checkout current and refuses rather than fast-forwarding over a fork. A hand fetch leaves the operator to notice. (3) --pr on apply is kept as an accepted no-op rather than removed: three proposal pages already committed in docs/proposals/ carry it in their run line, and the handover tells Carter to type it.

Reproduction and evidence. tests/cli-policy-apply-publish.test.ts builds a bare remote on disk, attests through the real CLI, and stubs gh on PATH. The behind-origin case clones the remote, commits an unrelated file and pushes, so the local main is behind by a commit that touches neither policy nor log; apply still publishes and the checkout branch and HEAD are unchanged. The diverged case builds a second repository with the same APPROVAL.md bytes (so base-policy-diverged, checked first, passes) attested as human:dana, and force-pushes its main, giving origin a genuinely different chain.

Global invariants (SPEC section 11.1). None weakened. The log is still append-only and untouched by this change; the base-log-diverged refusal stays machine-readable and distinct; nothing here reduces scrutiny or mints a class. The verb stays human-only twice over (apply-agent-actor, and policy.core in the classifier).

Validation. npm run build, npm run typecheck, npm run lint clean. npm test 4633 tests, 4610 pass; the 22 failures are the SMTP and email adapter suites, which fail on this laptop under Node v26 (Setting the TLS ServerName to an IP address is not permitted, against the 127.0.0.1 mock) and are untouched by this diff. cli-amend, cli-policy-apply, cli-policy-apply-publish, cli-long-help, cli-instructions and harness-enum together: 169 tests, 169 pass, after merging origin/main. node scripts/protected-path-guard.mjs --base origin/main --head HEAD: no protected paths changed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval policy apply now publishes: the amendment runs with --pr, so the branch is created on the remote by refspec, the pull request is opened, the merge is armed, and the checkout never moves; --no-publish is the opt-out. Every printed fallback runbook lost its branch switch and gained approval log sync as its first line, which is the sequence the 2026-09-18 recovery used. Verified by tests/cli-policy-apply-publish.test.ts against a bare remote on disk with gh stubbed: the default publish, --no-publish, the flag clash, a local main behind origin publishing anyway, and a forked log refusing base-log-diverged rather than a git error. PR #449, armed.
<!-- SECTION:FINAL_SUMMARY:END -->
