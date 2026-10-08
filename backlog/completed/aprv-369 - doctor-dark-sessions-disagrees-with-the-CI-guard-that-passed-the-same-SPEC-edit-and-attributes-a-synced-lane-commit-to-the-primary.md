---
id: APRV-369
title: >-
  doctor dark-sessions disagrees with the CI guard that passed the same SPEC
  edit, and attributes a synced lane commit to the primary
status: Done
assignee:
  - '@claude'
created_date: '2026-09-18 02:09'
updated_date: '2026-09-19 09:29'
labels:
  - doctor
  - guard
  - bug
dependencies: []
priority: medium
ordinal: 286000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-18 02:08Z in the primary, daemon up, right after approval log sync brought main level: dark-sessions FAIL, primary [no-evidence], SPEC.md 1 line(s) trace to no authorized material, 25 evidence records covered part of it. The commit is ea7427a (fix: a harness launch resolves only under an explicit rule, APRV-354, PR 432), a one-line SPEC.md edit made in a lane worktree and merged 2026-09-17T10:00Z; the protected paths (grant cross-check) job on PR 432 PASSED. Two things to settle. First, the disagreement: the doctor row and the CI guard replay the same records against the same bytes and reach different verdicts, so one of them is wrong about coverage (the guard is the enforcement path, the doctor row is the health view; a health view stricter than enforcement is noise, one looser is a hole). Compare the two code paths (src/core/protected-path-guard.ts versus the dark-sessions replay in src/cli/doctor.ts) on ea7427a and make them one function or document the intended difference. Second, the attribution: the primary made no edit; the commit arrived by fast-forward. The row should attribute a change to the checkout that authored it (commit author and the lane branch it came from) or say it cannot, rather than naming the checkout that synced it. Related: APRV-357 (guard replay budget), APRV-192 (the detector).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 On ea7427a the doctor row and the CI guard give the same verdict, with a test pinning the shared replay on that fixture
- [x] #2 A commit that reached a checkout by fast-forward is not attributed to that checkout as its own dark activity
- [x] #3 The row detail names the commit hash it judged
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reproduce on ea7427a before changing code, and record the input diff in the notes (done: the two GuardInputs differ in the blob span, the change timestamp, and the sign-off inputs; the blob span is the cause).
2. src/core/dark-session.ts arm A: replay PER COMMIT rather than over the union of every in-window commit that touched the path. base is the commit parent, head is the commit, changedPaths are that commit guarded paths, changeTsFor is that commit own date. This is the same unit the CI guard replays and the same unit a grant binds.
3. Pass organSha256AtHead and pathSha256AtHead, which arm A omitted, so a path ratified by gate.path.signed_off (APRV-338) is visible to the doctor exactly as it is to CI.
4. Attribution (AC2): mark each observed commit with whether it is on HEAD first-parent path. A commit off that path arrived through a merge, so it was authored on a branch and reached this checkout by fast-forward. A failure on such a commit is reported under its own code and its detail says which commit and where it came from, instead of reading as the checkout own edit. The verdict stays dark: no hole is opened by this task.
5. AC3: every arm A failure names the commit hash it judged, in the finding detail and therefore in the doctor row.
6. Tests: a fixture in tests/dark-session.test.ts driving the injected observe hook with the ea7427a shape (several commits over one guarded path in one window) that fails on the union span and passes per commit, plus a test that a merged commit is attributed to its own hash rather than to the checkout.
7. build, typecheck, lint, dark-session, doctor and guard suites, then npm test.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reproduction on ea7427a, recorded before any code changed (scratch script, read-only, against main tip 90426538f230 and the committed log at that tip, 44204 records seq 1..44204).

The two sides feed evaluateProtectedPaths different inputs. Three differences, and the first is the cause.

1. THE BLOB SPAN. The CI guard replays the pull request range: ea7427a^ .. ea7427a, one change. The doctor replays the parent of the OLDEST in-window commit that touched the path through the NEWEST: 60c9125226f3^ .. ea7427a. Inside the doctor 24h window six commits from four different pull requests touched SPEC.md (60c9125 APRV-352, 5ac1023 39717cc 2c2f124 APRV-324, 04e2734 ea7427a APRV-354). Replayed as one change that union defeats per-grant before-state matching (each grant binds a before-state that no longer occurs at the union base, because an earlier commit in the span already moved those bytes) and the exact base-to-head replay refuses after reaching its byte limit. Verdicts, same records, same policy: CI inputs PASS (granted by human:carter at seq 32598, 1 added and 1 removed line all trace to authorized material, 26 evidence records); doctor inputs FAIL uncovered-hunk, 1 line traces to no authorized material, 25 evidence records covered part of it. That is the row Carter saw, byte for byte.
2. THE SIGN-OFF INPUTS. The CI guard passes organSha256AtHead and pathSha256AtHead; arm A passes neither, so the doctor cannot see a path ratified by gate.path.signed_off (APRV-338) at all. On ea7427a this changes no verdict (checked: the same FAIL with and without), but it is a second way the doctor can be stricter than enforcement, and the handover records that a SPEC edit HAS been ratified that way (PR 427).
3. THE CHANGE TIMESTAMP. The CI guard passes both of git dates as a pair (author for staleness, committer for ordering, APRV-339); arm A passes one string, the author date of the newest touching commit, which then answers both questions. Not the cause here (both dates are equal on these commits) but the same class of drift.

The decisive experiment: replaying PER COMMIT, every one of the 16 commits in that window that touched a guarded path passes, in 1233 ms total, ea7427a among them. So the unification is not a trade: it is both cheaper and correct. The union span was asking a question nobody authorizes against, since a grant binds one edit and CI checks one change.

Attribution, separately (AC2): commitsOf uses the range HEAD for the primary with no --not trunk, so all 73 commits in that window, every lane commit that reached main by merge, count as the primary own activity. ea7427a was authored in a lane worktree; the granted material in the log names /Users/carter/dev/approval-md/.claude/worktrees/emilia-protocol-comparison-af4ffb/SPEC.md. The primary made no edit.

PR #450, commit 1dd39b1, armed with gh pr merge 450 --merge (autoMergeRequest enabledAt 2026-09-19T09:28:30Z, method MERGE). Branched from origin/main at 4796c4b; merged origin/main at 2a8de2b before pushing.

What was done. Arm A in src/core/dark-session.ts replays one commit at a time: base is the commit parent, head is the commit, changedPaths are that commit guarded paths, the timestamp is that commit own. It also passes organSha256AtHead and pathSha256AtHead, which it omitted before. commitsOf additionally asks git for the checkout first-parent history and marks each observed commit arrivedByMerge, and a failure whose commits all arrived that way takes the new code no-evidence-merged with a detail naming the judged commits and saying the edit was made in the branch the commit came from.

Decisions, all three reviewable.
(1) UNIFICATION, not an intended difference. The task left this open; the reproduction settles it. The union span asks a question nobody authorizes against, since a grant binds one edit and CI checks one change, and per commit the same window costs 1233 ms where the union hit its byte limit and gave up. There was no trade to make.
(2) A FAILING MERGED COMMIT KEEPS THE DARK VERDICT. AC2 asks that such a commit not be attributed to the checkout as its own dark activity, and the code and the sentence now carry that. The verdict stays dark because loosening it while removing a false alarm would be a second bug wearing the first one clothes, and because after the unification no such case exists on main today. Flagged in the PR for a second opinion; if the orchestrator wants the row downgraded for a merged commit it is a one-line change to the verdict beside the code.
(3) THE UNION FAILURE IS NOT PINNED BY A TEST, and the test says why. On ea7427a the union failed only because the exact base-to-head replay reached its byte budget on a 200 KB file; on a small fixture the replay finishes and rescues the union. That budget is APRV-357 subject. What the test pins instead holds at any size: per commit the doctor and the guard agree, and the middle commit sign-off counts for the doctor, which it could not before pathSha256AtHead was supplied. Removing that input makes the test fail, which was checked.

Global invariants (SPEC section 11.1). This task touches invariant 1 (enforcement paths read only verified records: unchanged, arm A still refuses to read anything when the chain does not verify) and the write boundary, by widening audit.dark_session.payload.code. The widening is additive and is now pinned equal to DARK_VERDICT_CODES by a test, so the failure mode APRV-358 found (a value the runtime can produce and the schema refuses) cannot recur here. Nothing is loosened: the dark verdict is unchanged for every case that produced one before and still fails per commit.

Validation. npm run build, npm run typecheck, npm run lint clean. npm run conformance 374/374. npm test 4663 tests, 4640 pass; the 22 failures are the SMTP and email adapter suites, which fail on this laptop under Node v26 (Setting the TLS ServerName to an IP address is not permitted, against the 127.0.0.1 mock) and are untouched by this diff. dark-session, event-schema, fixtures, cli-doctor and the three guard suites together: 332 + 197 tests, all passing. node scripts/protected-path-guard.mjs --base origin/main --head HEAD: no protected paths changed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Arm A of the dark-session detector now replays one commit at a time, which is the unit the CI guard replays and the unit a grant binds, and supplies the two head-digest inputs it was missing, so a path ratified by a human sign-off is evidence the doctor can read. On the observed window that turns a FAIL into sixteen per-commit passes in 1.2 seconds, where the single union replay had reached its byte limit and given up. A commit that arrived through a merge is marked as such, and a failure on one takes the new code no-evidence-merged with a detail naming the commits judged, so the row no longer reads as the primary own edit. Schema: audit.dark_session.payload.code gains that value, pinned equal to the recordable codes by a test. Verified by a real-git fixture in the ea7427a shape driving the CLI doctor and the guard side by side. PR #450, armed.
<!-- SECTION:FINAL_SUMMARY:END -->
