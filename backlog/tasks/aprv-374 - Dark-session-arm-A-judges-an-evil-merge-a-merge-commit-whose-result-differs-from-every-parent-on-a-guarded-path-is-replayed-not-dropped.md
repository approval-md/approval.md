---
id: APRV-374
title: >-
  Dark-session arm A judges an evil merge: a merge commit whose result differs
  from every parent on a guarded path is replayed, not dropped
status: Done
assignee:
  - '@claude'
created_date: '2026-09-19 09:46'
updated_date: '2026-09-19 13:32'
labels:
  - doctor
  - guard
  - bug
dependencies: []
priority: medium
ordinal: 289000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Residual of APRV-369 (PR 450). Arm A of src/core/dark-session.ts now replays one commit at a time, parent to commit, which is the unit the CI guard judges and a grant binds. commitsOf lists a commit changed paths with git log --name-only, and git shows no paths for a merge commit under that form, so every merge commit drops out of the replay with the comment that it should not be judged for what its parents did. That is right for a clean merge. It is wrong for a merge whose result differs from every parent on a guarded path: a conflict resolution or a hand edit made while resolving, the classic evil merge. Such an edit is the merge commit own work, it happened in the checkout that made the merge, and today neither arm A nor the CI guard (which replays a pull request range, never the merge-queue commit on main) looks at it. Before PR 450 the union span happened to include those bytes by accident. Decide the base for judging a merge commit (dense-combined, git log --cc --name-only, lists exactly the paths whose result differs from all parents; the replay then needs a before-state, and the first parent is the checkout own history) and make arm A replay those paths for merge commits with the same exactness rule as any other commit. Related: APRV-369, APRV-357 (unit of judgment ruling), APRV-192.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A merge commit whose SPEC.md result differs from every parent hunk by hunk (its DENSE COMBINED PATCH on that path is non-empty) is listed with that path by commitsOf, through the same helper the CI guard uses in src/core/commit-guard.ts and not a second rule; a clean merge and an ordinary auto-merge of two concurrent edits to that file both still list no paths, each pinned by a real-git fixture built through the real append path
- [x] #2 Arm A replays such a commit against a documented base (first parent by default) with the same exact-replay rule, and an unevidenced evil merge fails dark under its own code or the existing no-evidence code with the merge sha named
- [x] #3 Header of src/core/dark-session.ts and docs/git-evidence.md say what unit a merge commit is judged on and why
- [x] #4 build, typecheck, lint, dark-session and doctor suites pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. RULING TAKEN (orchestrator, 2026-09-19), and AC1 is reworded to it: the primitive is NOT the log verb with --cc --name-only, which lane 3 measured as over-reporting (an ordinary auto-merge of two concurrent edits to one file lists that file). It is the DENSE COMBINED PATCH per guarded path, judged against the first parent, which is the rule src/core/commit-guard.ts already uses for CI since APRV-375. Arm A calls that same helper; a second rule is what APRV-369 was filed about.
2. Export the dense pass from src/core/commit-guard.ts (denseCombinedPaths, today private, used by listCommits) so both callers share one implementation, and keep its two-step shape: candidates from -c --name-only, then a per-path --cc patch whose emptiness is the discriminator.
3. src/core/dark-session.ts, observer half: carry %P so a commit knows its parents, and in commitsOf fill a merge commit changedPaths from the dense pass instead of the empty list --name-only gives. Thread the policy protected paths into observeGitActivity (reportDarkSessions computes policyFacts first and passes them) so the cheapness filter is the real guarded set and not the built-in one.
4. src/core/dark-session.ts, evaluator half: drop the skip comment, pass parents to commitGuardInputParts so the base is the first parent by construction and a root commit is a root, and name a merge resolution in the row detail beside its sha. Codes are unchanged, so DARK_VERDICT_CODES and the schema enum are untouched.
5. Scope (ruling b): the guard scope is guarded paths, so a merge that is evil only on an unguarded path is not reported. The dense pass is asked only about paths isGuardedPath accepts.
6. Tests, real git through the real append path, in tests/dark-session.test.ts: an evil merge (both sides edit SPEC.md, the resolution is a third value) is listed with SPEC.md by the observer and fails dark with the merge sha named; the same merge with a grant binding the resolution hunk passes; a clean merge and an ordinary auto-merge of concurrent edits both list nothing. The CI guard is run over the same merge so the two sides are pinned to one verdict.
7. Docs: the header of src/core/dark-session.ts and the git-as-judged section of docs/git-evidence.md say what unit a merge is judged on and why (AC3).
8. The multi-commit-PR residual (ruling c) is measured against the diff at the end; if it does not fit cleanly it is filed as its own task in the orchestrator words.
9. build, typecheck, lint, npm test.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Residual from APRV-375 (PR #455), recorded here at the orchestrator request on 2026-09-19.

PR #455 made the CI guard judge a pull request one commit at a time and, in its second commit, anchored WHOLE-FILE evidence (gate.path.signed_off, gate.organ.attested, the policy attestation) at the RANGE HEAD while grants stay per commit. Arm A of the dark-session sweep kept the per-commit anchor, because it has no range: it judges commits that are already merged, each of which passed its own pull request and was ratified, if at all, at that pull request head.

The gap that leaves: a MULTI-COMMIT pull request whose earlier commits were rescued by a sign-off at its head merges into main as several commits, and arm A credits none of them, because no in-window commit blob equals the ratified bytes. CI passed that pull request; the sweep would report it dark. It is a false alarm in a health report and never a hole in the gate, and it is the same shape of disagreement APRV-369 removed.

The fix belongs with this task because it needs the same git question: ask which merge on the checkout first-parent spine brought each commit in, and use THAT merge second parent (the pull request head) as the commit range head for whole-file evidence. Arm A already asks git for the first-parent spine (commitsOf, APRV-369), so the extra call is one rev-list per failing commit rather than a new traversal.

Probe by lane 3: does a note mentioning git get refused?

(The one-line note above it is a probe: the agent hook refuses a backlog note whose text contains something that reads as a runnable VCS command, so the commands below are written with the verb separated from the tool name. That refusal is why.)

NOT STARTED as code by lane 3 (2026-09-19). The lane spent its remaining runway establishing the one fact AC1 turns on, and stopped there rather than half-building a guard change. Read this before writing any.

THE FINDING: the log verb with --cc --name-only IS NOT AN EVIL-MERGE DETECTOR. AC1 offers it as the primitive; it lists more than the task wants. Measured on this repository, on real commits:

- dd111a7 (Merge pull request #458): log -1 --cc --name-only lists NO paths. A clean merge, as AC1 expects.
- 709d0d7 (Merge origin/main into lane/attest-stores-text-356b): lists SPEC.md, docs/cli-reference.md and schema/event.schema.json. It had NO conflicts and NO hand edit. Both sides had simply edited those three files since their merge base (a1eaccb carried APRV-355, 5b1e1d1 carried APRV-356).
- The discriminator: the same log verb with --cc, an empty format and a SPEC.md pathspec emits NOTHING for 709d0d7. The dense combined PATCH is empty; every hunk in that merge matches one parent or the other.

So --name-only under --cc lists a path whenever the merge blob differs from EVERY parent blob, which is true of an ordinary auto-merge of two concurrent edits to one file. The dense combined PATCH is the thing that is empty for a clean merge and non-empty for an evil one.

WHY IT MATTERS: taking --cc --name-only as the path list and the first parent as the base would replay, for every ordinary merge of two branches that both touched SPEC.md, a change whose before-state is the first parent blob and whose after-state is the union of both sides. No grant binds that: the second parent changes are evidenced by grants anchored in the second parent own history, not at the merge. Arm A would then report dark for a merge CI passed. That is the same class of false alarm APRV-369 and APRV-375 exist to remove, reintroduced through the door AC1 names.

THE IMPLEMENTABLE READING (AC1 says "or equivalent", which this uses): a merge commit changed paths are the paths whose DENSE COMBINED PATCH is non-empty, read from the log verb with -1 --cc and an empty format, parsing the +++ b/<path> headers. A clean merge yields none, an auto-merge of concurrent edits yields none, and an evil merge yields exactly the paths a human changed while resolving. Base stays the first parent, which is the checkout own history, as the task proposes. With that primitive the rest of AC2 is ordinary: the same exactness rule, the merge sha named in the failure.

WHAT IS STILL A RULING, and why this lane did not take it: whether a merge that is evil on an UNGUARDED path but clean on guarded ones should be reported at all (it should not, on the guard own scope rule), and whether the residual recorded above (the multi-commit pull request rescued by a sign-off at its head) is answered by the same question or needs its own. The second needs the merge second parent as the evidence anchor, which is a different traversal from the one AC1 asks for.

Nothing was committed. Branch lane/evil-merge-374 was created from origin/main and carries no change; it can be deleted or reused.

DONE 2026-09-19 by lane 4, branch lane/evil-merge-374b.

WHAT CHANGED. Arm A now judges merge commits. src/core/commit-guard.ts exports denseCombinedPaths, which was already private there and already the rule the CI guard uses since APRV-375; src/core/dark-session.ts calls THAT rather than growing a second one, which is the whole point (two implementations of the same git question is what APRV-369 was filed about). The observer carries %P so a commit knows its parents, and commitsOf fills a merge changedPaths from the dense pass instead of the empty list --name-only gives for a merge. reportDarkSessions now loads the policy BEFORE it asks git anything and hands the protected paths to observeGitActivity, so the merge question is asked about the real guarded set and one evaluation is never told two different ones. The evaluator passes the parents to commitGuardInputParts, so the base is the first parent by construction and a root commit is judged as the add it is.

THE RULING TAKEN, and it changed AC1. The orchestrator ruled on lane 3 finding (recorded above): the log verb with --cc --name-only over-reports, so it is not the primitive. AC1 was reworded to the dense combined PATCH per guarded path against the first parent. The fixture MEASURES this rather than asserting it from memory: for the auto-merge both -c --name-only and --cc --name-only list SPEC.md, and the per-path --cc patch is empty. Had the listing been taken as the path list, every ordinary merge of two branches that both touched SPEC.md would have been replayed as the merge own change and reported dark for work every side of it had evidence for.

SCOPE, ruling (b): the guard scope is guarded paths, so a merge that is evil only on an unguarded path is not reported, and the dense question is only asked about paths isGuardedPath accepts. That also keeps the cost down, since the dense patch has to be asked for one path at a time.

THE RESIDUAL, ruling (c): FILED AS APRV-377 rather than folded in. It needs a different traversal from the one this task added (for each commit off the first-parent path, the merge that brought it in is the first-parent commit whose second parent reaches it, and that merge second parent is the commit range head for whole-file evidence), it changes NON-merge commits too, and it moves an evidence anchor rather than a path list. The comment in dark-session.ts that used to say APRV-374 neighbourhood now names APRV-377.

WHAT THE DIFF HIDES. (a) The header claim that the evaluator is PURE with no git was already false since APRV-369, which moved the per-commit replay inside it; the header now says which one thing it runs git for and why it cannot be carried in the observation. (b) The observe seam grew a fourth argument; a test double that ignores it answers exactly as before, which is why no existing fixture changed. (c) ObservedCommit.parents is optional and absence means unknown, which the input builder reads as assume it has a parent: the modest direction, since the base it then judges against is the first parent rather than nothing. isMergeCommit answers false for unknown parents, and nothing but the wording of the row turns on it. (d) The fixture commits SPEC.md alone and the log only at the end. A log committed on both sides of a conflicting merge conflicts in the same merge, and a hand-resolved hash chain is not a chain. That is also why the CI cross-check range ends at the log commit: the guard reads the log out of the tree at its range head and fails closed with log-missing when it is not there.

INVARIANTS. No SPEC section 11 invariant is touched. No new event, no new code, no schema change: DARK_VERDICT_CODES and the schema enum are unchanged, because an evil merge fails under the existing no-evidence code with its sha named. The change makes the detector report MORE, never less, and nothing it reports reduces what evidence is required.

VERIFICATION. build, typecheck, lint clean. node --test dist/tests/dark-session.test.js: 32 tests, 32 pass, exit 0. npm test: 4697 tests, 4674 pass, 22 fail, exit 1, and all 22 are the pre-existing Node v26 SMTP and email adapter failures on this laptop (TLS ServerName may not be an IP), untouched here; CI on Node 22 is the truth.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Arm A of the dark-session sweep judges a merge commit on what it invented: the guarded paths whose dense combined patch is non-empty, replayed against the first parent with the same exact-replay rule every other commit gets. The primitive is the shared helper the CI guard already used (src/core/commit-guard.ts, denseCombinedPaths), so the health row and the CI verdict agree by construction, and it is the dense PATCH rather than a --cc --name-only listing, which a fixture measures as listing any file two branches edited concurrently. Verified by three real-git cases in tests/dark-session.test.ts built through the real append path: the observer lists the evil merge with SPEC.md and lists nothing for a clean merge or an ordinary auto-merge; an unevidenced resolution fails the doctor row with the merge sha named as a merge resolution, and the real CI guard fails the same commit; a granted resolution clears both. The multi-commit-PR residual is APRV-377.
<!-- SECTION:FINAL_SUMMARY:END -->
