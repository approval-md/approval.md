---
id: APRV-420
title: >-
  policy amend --pr races the records advance: the amend PR carries the log and
  conflicts with every records PR that lands first, handing the human a by-hand
  merge of events.jsonl
status: Done
assignee:
  - '@claude'
created_date: '2026-09-21 03:41'
updated_date: '2026-09-22 01:46'
labels:
  - policy
  - records
  - cli
dependencies: []
priority: high
ordinal: 322000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-21 (Carter): approval policy amend --as human:carter --pr opened PR 530 carrying APPROVAL.md, .approval/log/events.jsonl and a payload file. Two records advances (PR 529, PR 531) landed first and carried the same records (the attestation at seq 65736 and its payload are on main through PR 531), so PR 530 went DIRTY and lost its arm; re-running amend answered nothing to amend because the attestation exists; the repair was a hand merge in a throwaway worktree taking main's log and payload, which is exactly the log-touching hand work the idioms exist to remove. Fix options to decide: (a) when the attestation and payload are already on main (or on the open records branch), the amend PR carries only the policy bytes, so it cannot conflict with the log; (b) the amend joins the records branch: the policy commit rides the open records-log PR, which already self-arms (APRV-284), so one PR carries policy and log together and there is no race; (c) amend --pr detects a DIRTY state on re-run and re-merges the log from main itself, since main's log is a superset by construction. Also the re-run message should say what to do when the PR exists and is dirty rather than nothing to amend. Related: APRV-284, APRV-360 (policy apply publishes by refspec), APRV-412 (amend named as the way), APRV-389 (log sync under a daemon).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 An amend PR opened while a records advance is pending or landing merges cleanly, by carrying only the policy bytes when the log records are already published or by riding the records branch; the choice is recorded in the notes and docs/cli-reference.md policy amend
- [x] #2 Re-running amend against an existing dirty amend PR repairs it (re-merging main's log, which is a superset) or says exactly what to run, never nothing to amend
- [x] #3 A test builds the race through the real append and advance paths (attest, open the amend PR, land a records advance, re-run) and asserts a clean merge; build, typecheck, lint and the policy and advance suites pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Chose fix a plus fix c, and not b. Recorded here, in the notes and in docs/cli-reference.md policy amend.

WHY NOT b, the amendment riding the records branch: it would put a policy edit and its human attestation on a branch whose whole claim to self-arming, APRV-284, is that it carries only the log, QUEUE.md and payloads. The advance withholds its own arm when anything else rides the branch, so riding it would either lose the arm or require weakening that guard. A policy amendment is the one commit that must be reviewable on its own.

FIX A. THE AMENDMENT CARRIES THE LOG ONLY WHEN IT IS THE THING PUBLISHING IT.
1. decideLogCarriage in src/cli/amend.ts, called at commit-assembly time against the base the commit is parented on. Three answers: the base already carries every record this attestation added, so the log is published and the log path is omitted; a records advance branch is live on origin, so that advance publishes the whole log including this attestation and the log path is omitted; otherwise carry it, which is what the verb has always done. Detected with ls-remote over the records branch pattern rather than the GitHub CLI, so the answer is the same on a box with no CLI and no token.
2. The commit's path list drops the log on the first two answers. A commit that does not touch the log cannot conflict on the log, whichever side lands first, so there is nothing left to race over. Fails toward carrying: any answer the function cannot establish leaves the amendment holding the log, because a dirty pull request is a nuisance and an attestation that reaches the trunk in nobody's commit is a policy in force the committed log does not record.
3. The report says which of the three happened, so the pull request's file list is never a surprise.

FIX C. A RE-RUN REPAIRS THE OPEN AMEND PR INSTEAD OF SAYING NOTHING TO AMEND.
4. Today the second run stops at nothing to amend at exit 0, because the live policy already matches the attestation the first run appended. That sentence is true and useless: the pull request carrying the amendment is open and unmergeable. So before that exit, when the commit or pr flag was asked for and origin carries the amendment branch, the verb fetches the base and computes what the base still lacks: the policy bytes, the payload, and the log per step 1.
5. Nothing lacking means the amendment landed: say so and name the command that closes the branch.
6. Something lacking means rebuild the commit on the CURRENT base carrying exactly that, force-update the branch by refspec, and re-arm auto-merge. The trunk's log is a superset by construction, so rebuilding on it is the re-merge without a merge. The checkout never moves, as everywhere else in this verb.
7. Under dry-run, no-publish, or with no GitHub CLI, print exactly the commands instead of running them. Never nothing to amend.

TESTS in tests/cli-amend.test.ts, building the race through the real paths in a scratch gate with a bare remote: attest, amend with pr, then a real log advance that lands the same records on the base, then re-run amend, then assert a real merge of the branch into the base reports no conflict. A second case pins the policy-only file list while a records branch is open, and a third pins the re-run message when the amendment already landed. No test writes the log by hand.

8. docs/cli-reference.md policy amend gains the carriage rule and the re-run repair; the log advance section gains the cross-reference.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
CHOICE: fix a plus fix c, not b. Two publishers were carrying the same bytes, so the fix leaves one of them holding the log, and a re-run repairs what the old behaviour already left standing.

Not b, the amendment riding the records branch: that branch self-arms, APRV-284, precisely because it carries only the log, QUEUE.md and payloads, and the advance withholds its own arm when anything else rides it. Putting a policy edit and a human attestation there would either lose the arm or need that guard weakened, and a policy amendment is the one commit that must be reviewable alone.

FIX A, prevention. decideLogCarriage in src/cli/amend.ts runs at commit-assembly time against the base the commit will be parented on, and asks two questions in order: does the base log already carry every record this attestation added, and is a records advance live on origin. Either yes and the log path leaves the commit; the amendment is then the policy bytes, the attested text and the pins, and a commit that does not touch events.jsonl cannot conflict on events.jsonl whichever side lands first. Otherwise it carries the log as it always has. Asked with ls-remote over the records branch pattern rather than the GitHub CLI, so the answer is identical on a box with no CLI and no token. Fails toward CARRYING: every answer the check cannot establish leaves the amendment holding the log, because a dirty pull request is a nuisance and an attestation reaching the trunk in nobody's commit is a policy in force the committed log does not record. The ceremony prints which of the three happened.

FIX C, repair. The no-op exit gained one exception: when the commit or pr flag was asked for and origin already carries the amendment branch, repairAmendBranch fetches the default branch, computes what it still lacks, and either says the amendment landed in full and prints the close command, or rebuilds that commit on the current default branch, force-updates the branch and re-arms the merge. The trunk log is a superset by construction, so rebuilding on it is the re-merge without a merge. Never nothing to amend over a dirty amendment.

The force-push is bounded, and this is the part a reviewer should look at hardest. The remote branch must be a single commit on top of a commit the base already contains, which is the shape this ceremony creates and nothing else; a branch carrying more is reported with a log range and left untouched, and a case pins that a peer commit survives. The rebuild goes through commitOnBase's scratch index like every other commit here, so nothing is checked out and no live appender has the log moved underneath it. dry-run and no-publish compute it, print the commands, run none of it; only the failed state is a nonzero exit.

TESTS: tests/cli-amend-records-race.test.ts, 6 cases, real version control with a bare remote, the ceremonies through their real entry points, and no log line written by hand. Three things the tests found, each a real bug rather than a test problem:
1. The landed case. rev-list --count over an already-merged branch answers 0, and the shape guard treated 0 as unaccountable. The guard now runs only once a rebuild is actually owed, so a merged branch leaves through the landed exit.
2. A peer commit pushed to the branch is not an OBJECT in the working repository, so rev-list over it answered nothing and the refusal said an unknown number of commits. The tip is now fetched before it is counted.
3. The conflict case initially merged CLEANLY, because an advance carrying only the attestation the amendment already carries produces byte-identical logs on both sides. The fixture now appends further records through the real register path between the amendment and the advance, which is what the incident had, and the case asserts the conflict BEFORE asserting the repair, so the repair is never proved against nothing.

Global invariants: none touched. Nothing here appends, reorders or mutates the log; the change is which paths one commit carries and what a second run does with a branch. Invariant 5 is unaffected, since no check-then-append is added. The amendment still attests exactly once, through the same path.

VERIFICATION: build, typecheck and lint clean, no warnings. The selection cli-amend-records-race, cli-amend, cli-policy, log-advance-automerge, log-advance-rebuild, daemon-advance, docs-guard, ci-guard, ci-baseline, cli-help, cli-long-help gives 238 tests, 238 pass, 0 fail, exit 0. The policy set on its own, cli-amend plus cli-policy plus cli-policy-apply plus cli-policy-apply-publish plus cli-attest plus attest plus policy-proposal, gives 211 pass, 0 fail. The conformance runner gives 461 vectors, 461 passed, 0 failed, 176 controls, manifest ok. APRV-426's new baseline flag caught the one regression this task created, by name: the cli-amend case that pins every frozen no-op JSON key, which needed the additive repair key.

DOCS: docs/cli-reference.md policy amend gains a section on who publishes the log and one on the re-run repair; the log advance section gains the cross-reference.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The amendment and the records advance no longer race for events.jsonl. Chose fix a plus fix c: the amendment carries the log only when it is the thing publishing it, and a re-run repairs a pull request a landed advance made unmergeable instead of answering nothing to amend. decideLogCarriage asks two questions of the base the commit will sit on, does it already carry these records and is a records advance live on origin, and on either yes the commit is the policy bytes, the attested text and the pins, which cannot conflict on a file it does not touch. repairAmendBranch rebuilds the branch on the current trunk, force-updates it and re-arms the merge, bounded to a branch that is the single commit this ceremony makes so a peer commit is never lost. Verified by 6 new cases in tests/cli-amend-records-race.test.ts that build the race through the real attest, amend and advance paths in a scratch gate with a bare remote, assert the conflict before asserting the repair, and merge for real in a throwaway clone; 238 pass 0 fail across the amend, policy, advance, daemon-advance and guard suites, 211 pass 0 fail across the policy set, 461 of 461 conformance vectors, build, typecheck and lint clean. Recorded in docs/cli-reference.md under policy amend and cross-referenced from log advance.
<!-- SECTION:FINAL_SUMMARY:END -->
