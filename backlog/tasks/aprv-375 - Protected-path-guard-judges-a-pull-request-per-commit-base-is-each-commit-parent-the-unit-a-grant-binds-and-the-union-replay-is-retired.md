---
id: APRV-375
title: >-
  Protected-path guard judges a pull request per commit: base is each commit
  parent, the unit a grant binds, and the union replay is retired
status: Done
assignee:
  - '@claude'
created_date: '2026-09-19 09:53'
updated_date: '2026-09-19 10:21'
labels:
  - guard
  - ci
  - spec
  - security
dependencies: []
priority: high
ordinal: 290000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter ruled option B on 2026-09-19 after the APRV-357 reproduction (PR 452): PR 427 SPEC.md diff was 671 of 798 lines because the lane merged origin/main into itself twice while four lanes were editing the file, so the guard was replaying what the branch absorbed, against before-states that no longer occur at the merge base. The doctor already replays per commit since APRV-369 (PR 450) and agrees with CI wherever CI can answer. Make the CI guard (scripts/protected-path-guard.mjs over src/core/protected-path-guard.ts) judge a pull request one commit at a time: for every non-merge commit in base..head, base is the commit parent, head is the commit, changedPaths are that commit guarded paths, timestamps are that commit own pair (APRV-339), and the commit passes or fails on its own records. Commits the branch absorbed by merging main are commits main already carries; they are excluded because they are reachable from base, which two-dot base..head does by construction. A merge commit on the branch is judged on the paths whose result differs from every parent (dense combined), against its first parent, or the task records why not (APRV-374 asks the same of the doctor). The PR verdict is the conjunction; the report lists each commit sha with its verdict and the records that covered it, in order. The security argument to write into the guard header and docs/git-evidence.md: every changed byte between base and head is in some commit of the range, so nothing goes unjudged; the guard stops asking about the combined diff because a grant binds one edit and the combined diff has no grant. The exact-replay byte budget stays as it is; per commit it is not reached in any case observed. Retires the union replay path once the per-commit path covers every fixture the old one did; APRV-357 closes as superseded when this lands, with a note. Related: APRV-357, APRV-369, APRV-374, APRV-338 (sign-off stays as the escape hatch), APRV-339, APRV-340, APRV-151, APRV-316.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 On the PR 427 fixture (base 6d1b2bbe1dde, head e66ba9e689a2, log at 42403) the guard passes SPEC.md by per-commit replay, naming each judged commit and its records, with no sign-off record present; the fixture is built through the real append path or replayed from the committed log
- [x] #2 Exactness unchanged, each with a test: a commit missing its record fails uncovered-hunk naming that commit; a record whose after-state was later altered outside the log fails; a hunk that only appears in the combined diff and in no single commit cannot exist, and a test documents why (two-dot range covers every byte)
- [x] #3 Absorbed commits (reachable from base after a merge of main into the branch) are not judged again, with a fixture that merges main into the branch and asserts those commits are neither listed nor failed
- [x] #4 A merge commit on the branch whose result differs from every parent on a guarded path is judged against its first parent and fails when unevidenced; a clean merge is listed as skipped
- [x] #5 The report and the doctor row name the same unit and the same verdict on the APRV-369 fixture; a shared helper builds the per-commit GuardInput for both, or the two are pinned equal by a test
- [x] #6 Guard header, scripts/protected-path-guard.mjs header and docs/git-evidence.md state the unit of judgment and the security argument; SPEC section 11 or the guard section is amended in one commit if it describes the union replay, and the edit is called out
- [x] #7 Runtime on the PR 427 fixture measured and recorded; build, typecheck, lint, guard, guard-script, dark-session and doctor suites pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reproduce PR #427 exactly as PR #452 did (base 6d1b2bbe1dde, head e66ba9e689a2, --log-ref e66ba9e689a2 so the committed log is the 42403-record copy at head). DONE: uncovered-hunk, 14 uncovered lines, 29 naming and 27 covering records, and the sentence about the exact BASE-to-HEAD replay reaching its byte limit. Per commit, each of the three non-merge commits PASSES (5ac1023 policy-authorized-file; 39717cc and 2c2f124 granted-file at seq 32598).
2. New shared module src/core/commit-guard.ts: a GitReader seam (args to stdout or null); commitGuardInputParts(read, commit) building the per-commit blobsFor, sha256At, changeTsFor and window that arm A already builds inline; listCommits(read, base, head, isJudged) enumerating base..head oldest first; judgeCommits() running evaluateProtectedPaths per commit; renderCommitGuardReport().
3. Enumeration rules. Non-merge: git log --reverse with a record-separated format and --name-only over base..head; base is the commit first parent; changedPaths are everything it touched. Absorbed commits are excluded by two-dot base..head construction, since the CI base is git merge-base origin/main HEAD and a branch that merged main has those commits reachable from base. Merge commits: dense combined only. The -c --name-only candidate set over-reports (SPEC.md is listed at e66ba9e while its combined PATCH is empty), so each guarded candidate is re-asked with a per-path --cc patch and judged only when that output is non-empty; base is the first parent.
4. scripts/protected-path-guard.mjs stops calling evaluateProtectedPaths on the combined base..head diff (the union replay) and calls judgeCommits instead. JSON keeps ok, findings, exempt, window and log_source, and gains commits with sha, base, merge, status, ok, findings and covered; each flattened finding names its commit. Human rendering lists each commit sha with its verdict and the seqs that covered it, in order.
5. src/core/dark-session.ts arm A calls commitGuardInputParts with its own scrubbed git seam, so one helper builds the per-commit GuardInput for both sides (AC5).
6. Tests. protected-path-guard-script.test.ts: an absorbed-commit fixture (merge main into the branch, assert those commits are neither listed nor failed); a commit missing its record fails uncovered-hunk naming that commit; a record whose after-state was altered outside the log fails; a merge that invents a line on a guarded path fails against its first parent; a clean merge is listed as skipped; a test documenting that two-dot plus dense-combined covers every changed byte. dark-session.test.ts: guardSpan replaced by a real run of the script over the APRV-369 fixture, asserting the same unit and the same verdict as the doctor row.
7. Docs: the headers of src/core/commit-guard.ts, src/core/protected-path-guard.ts and scripts/protected-path-guard.mjs, plus docs/git-evidence.md and the backstop section of docs/claude-code-hook.md, state the unit of judgment and the security argument. SPEC.md needs NO amendment: it describes the after-the-fact check on a pull request (the 5.2 sign-off bullet, 10.1) and never states the union replay or any unit of judgment; recorded in the notes as the checked alternative.
8. Measure runtime on the PR #427 fixture; run build, typecheck, lint and the guard, guard-script, dark-session and doctor suites.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
APRV-375 implemented: the CI guard judges a pull request one commit at a time, the union replay is retired, and one shared helper builds the per-commit GuardInput for both the guard and the doctor.

WHAT LANDED

- New src/core/commit-guard.ts. A GitReader seam (args to stdout or null) so each caller keeps its own git invocation (the CI script in the cloned checkout, dark-session in its APRV-205 scrubbed environment) while the QUESTIONS live in one place. listCommits enumerates base..head oldest first; commitGuardInputParts builds blobsFor, sha256At, changeTsFor and the window labels for one commit; judgeCommits runs evaluateProtectedPaths per commit and returns the conjunction; renderCommitGuardReport prints each commit sha with its verdict and the covering seqs.
- scripts/protected-path-guard.mjs no longer builds any per-commit input and no longer calls evaluateProtectedPaths on the combined diff. Its JSON keeps ok, findings, exempt, window and log_source (so every existing consumer and all twelve prior tests are unchanged) and gains commits[] plus a commit field on each flattened finding.
- src/core/dark-session.ts arm A calls the same helper. Its inline blobsFor and sha256At are gone, which is the two-code-paths-kept-in-step problem APRV-369 was filed about.
- evaluateProtectedPaths is untouched as an evaluator. Two internal policy-path comparisons became one exported predicate, namesPolicyFile, because commit-guard has to ask the same question.

DECISIONS

1. Merge commits are judged on the DENSE combined diff, against the first parent. The naive route (git log -c --name-only) over-reports: at PR 427 merge e66ba9e it lists SPEC.md, whose result differs from both parents as a blob while every hunk came verbatim from one side, and judging that against the first parent would have failed the PR for what main did. So each guarded candidate is re-asked with a per-path --cc patch and judged only when that output is non-empty. Passing the path as a pathspec rather than parsing it out of a diff --cc header keeps quoted filenames out of the parser. A merge with an empty dense diff is listed SKIP.
2. policySha256AtHead is now the digest at the COMMIT rather than at the pull request head, computed only when that commit touched the policy file. Under per-commit judgment the attested verdict should ask about the bytes the change under judgment left behind. On a single-commit range this is the identical value, which is why no existing test moved.
3. A failing merge keeps the ordinary codes (uncovered-hunk, no-evidence). No new code was minted; the report carries merge: true and the renderer says merge resolution.
4. Dark-session arm A still drops merge commits (they report no paths under --name-only). APRV-374 asks the same dense-combined question of the doctor; judging merges there is that task, not this one, and the note is in the code at the skip.
5. SPEC.md needs NO amendment, which is AC6 conditional. SPEC describes the after-the-fact check on a pull request (the 5.2 sign-off bullet and 10.1) without stating any unit of judgment; the word replay appears twice in SPEC.md and neither is the guard. The alternative considered and NOT taken: adding a normative sentence naming the unit to 10.1. It would cost a protected-path edit and a records advance for a statement about an implementation choice, and 11.1 is for cross-cutting safety properties rather than for the granularity one checker reads git at. If the orchestrator wants it stated normatively, that is a one-sentence follow-up.

SECTION 11 INVARIANTS: none weakened. The guard still reads only verified records, still reads committed trees rather than any working copy, still fails closed on an unreadable blob or an unverified log, and the exact-replay byte budget is unchanged. The security argument for asking a smaller question is written into three headers and two docs: every byte that differs between the two trees was written by some commit of base..head (two-dot semantics), a non-merge commit contributes its diff against its parent, and a merge contributes only its dense combined diff, which is judged. Work the branch absorbed by merging main is mains own and is excluded by construction, since CI base is git merge-base origin/main HEAD.

RUNTIME (AC7), on the PR 427 fixture, base 6d1b2bbe1dde head e66ba9e689a2, committed log pinned to head with --log-ref: 3.7 s wall for the whole script, twice, of which about 0.5 s is node startup plus verifying the 42403-record log (measured with an empty range). So roughly 3.2 s to judge five commits, three of them with a protected change. Honest comparison: APRV-357 recorded 173 ms for the union, but that number is the guard GIVING UP after its byte limit, not a verdict. The byte limit is not reached per commit in any case observed.

REPRODUCTION FIRST, as the task asked. Before any code changed, the current guard on that fixture produced exactly what PR 452 recorded: uncovered-hunk, 14 lines tracing to no authorized material, 29 records naming SPEC.md, 27 covering part of it, and the sentence about the exact BASE-to-HEAD replay reaching its byte limit. Per commit, run by hand against the same log: 5ac1023 policy-authorized-file, 39717cc and 2c2f124 granted-file at seq 32598, all three PASS.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The CI protected-path guard judges a pull request one commit at a time (base is each commit first parent), merge commits are judged on their dense combined diff against the first parent, and the combined base-to-head replay is retired. src/core/commit-guard.ts is the shared per-commit input builder for both the CI script and approval doctor dark-session arm A. Verified: the PR 427 fixture (base 6d1b2bbe1dde, head e66ba9e689a2, log pinned to head at 42403) fails on the old path exactly as PR 452 recorded and passes per commit with no sign-off record, in 3.7 s; seven new tests in tests/protected-path-guard-script.test.ts cover absorbed commits, an uncovered commit, an altered after-state, an evil merge, a clean merge and the changed-byte coverage invariant; tests/dark-session.test.ts now runs the real guard script over the APRV-369 fixture and asserts the same unit and the same verdict as the doctor row. build, typecheck and lint clean; conformance 374/374; npm test 4673 tests, 4650 pass, 22 pre-existing Node v26 SMTP failures untouched.
<!-- SECTION:FINAL_SUMMARY:END -->
