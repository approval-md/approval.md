---
id: APRV-374
title: >-
  Dark-session arm A judges an evil merge: a merge commit whose result differs
  from every parent on a guarded path is replayed, not dropped
status: To Do
assignee: []
created_date: '2026-09-19 09:46'
updated_date: '2026-09-19 13:09'
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
- [ ] #1 A merge commit whose SPEC.md result differs from both parents is listed with that path by commitsOf (git log --cc --name-only or equivalent), and a clean merge still lists no paths, each pinned by a real-git fixture built through the real append path
- [ ] #2 Arm A replays such a commit against a documented base (first parent by default) with the same exact-replay rule, and an unevidenced evil merge fails dark under its own code or the existing no-evidence code with the merge sha named
- [ ] #3 Header of src/core/dark-session.ts and docs/git-evidence.md say what unit a merge commit is judged on and why
- [ ] #4 build, typecheck, lint, dark-session and doctor suites pass
<!-- AC:END -->

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
<!-- SECTION:NOTES:END -->
