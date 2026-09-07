---
id: APRV-292
title: log sync moves the working log aside for the pull but not the queue projection
status: To Do
assignee: []
created_date: '2026-09-07 02:16'
updated_date: '2026-09-07 06:47'
labels:
  - daemon
  - log
dependencies: []
priority: medium
ordinal: 217000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
2026-09-07: after the records PR #309 merged (it carries .approval/QUEUE.md as well as the log), approval log sync refused twice with git's 'local changes to .approval/QUEUE.md would be overwritten' even right after git checkout -- .approval/QUEUE.md, because the running daemon rewrites the projection between the checkout and the fast-forward. The working log itself was handled (sync snapshots and restores it), so the refusal is purely the projection: a file that is rebuilt from the log on every sync and carries no truth of its own. Workaround used: stop the daemon, checkout QUEUE.md, sync, restart. APRV-215 says a dirty working log plus an upstream change is sync's job, always; the same has to hold for the projection sync itself rebuilds.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval log sync treats .approval/QUEUE.md (and the index projection when present) as disposable: it discards the working copy before the fast-forward and rebuilds it after, so an upstream records commit that touches the queue never refuses the sync
- [x] #2 A test drives the real append path with an upstream commit that changes both the log and QUEUE.md, with a concurrent projection rewrite between snapshot and merge, and asserts the sync succeeds and the rebuilt queue matches the merged log
- [x] #3 SPEC log sync paragraph names the projection rule; docs/dogfood-cutover.md and docs/cli-reference.md log sync sections updated; CHANGELOG entry
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Keep the working LOG path exactly as APRV-215 left it: snapshot, baseline to HEAD bytes, restore on every failure. Nothing in this task changes it.
2. Treat the projections as disposable. QUEUE.md keeps its snapshot (a refusal still leaves the tree as found) but leaves the baseline loop; the index is not snapshotted at all.
3. Discard immediately before the merge rather than at the baseline. The append lock covers appends, so the log cannot be dirtied mid-sync; writeQueue takes no lock, so the projection can be, and the baseline-to-merge window is where the records PR refused twice. Right before git merge --ff-only, each disposable projection that HEAD or FETCH_HEAD carries is set to its HEAD bytes (removed when only the incoming tree has it). A projection git does not carry (the gitignored index.sqlite) is left alone: it blocks no merge and it is a cache.
4. Bounded retry inside the merge step: when the merge fails and git status still reports a disposable path dirty, discard again and merge once more. A second failure refuses log-sync-git-failed as it does today.
5. Step names unchanged. LOG_SYNC_STEPS is public and the injected-failure table pins it, so the discard rides inside the merge step, after the failBefore check.
6. New test seam hooks.interfere: run this callback just before a named step, as a concurrent writer would. A parameter of the function, never a CLI flag, same discipline as failBefore.
7. Test: a peer appends two records through the real append path and rewrites QUEUE.md, and pushes both in one commit; interfere at merge rewrites QUEUE.md in the primary between the snapshot and the merge; assert the sync succeeds, adopts the longer chain, and the rebuilt QUEUE.md equals a fresh renderQueue over the merged log modulo the evaluated-at line.
8. Docs: the cli-reference log sync steps, the dogfood-cutover sync section, a CHANGELOG entry under 0.1.0. The SPEC amendment sentence goes into the implementation notes for the human to apply by hand.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
What was done

log sync now treats the projections as disposable. QUEUE.md leaves the step-4 baseline loop and is instead DISCARDED as the last statement before the fast-forward merge, then rebuilt from the reconciled log at the projections step as it always was. The index projection joins it whenever the repository tracks the path. Discard means writing the bytes HEAD holds over the file, or removing it when only the incoming tree carries it: no proof, no comparison, no reconciliation, which is the opposite of the payload step two lines above it. A projection is a rendering of the log and, unlike a payload, it is not evidence.

New helpers in src/cli/log-sync.ts: disposableProjections (which of the queue and index paths are held at HEAD or carried by FETCH_HEAD; anything else can stop no merge and is left alone, so the ignored .approval/index.sqlite is never cleared), discardProjections, and dirtyProjections (a porcelain status over just those paths). The merge is attempted, and when it fails with a disposable path dirty again the discard and the merge are retried exactly once; a second failure refuses log-sync-git-failed as before, and the message then names the file and says something is rewriting it faster than the fast-forward can run.

What was decided

1. The working LOG path is byte-for-byte what APRV-215 left: snapshot, baseline to the committed bytes, restore on every failure. The asymmetry is the whole argument. Sync holds the append lock for the ceremony and appending is the only writer of the log, so the log cannot be dirtied between the baseline and the merge; writeQueue holds no lock and the daemon re-renders QUEUE.md every tick (its TTL countdowns move even when the log does not), so the projection can be, and was.
2. Discard LATE rather than at the baseline. A discard early enough for the next tick to undo is the same as no discard, which is what the hand-run checkout proved twice on 2026-09-07.
3. QUEUE.md keeps its snapshot, for the refusal path alone. Disposability is a claim about the merge and the success path; a refusal still leaves the whole working tree as it was found, log and projection together. No success path copies the snapshot back.
4. LOG_SYNC_STEPS is unchanged. It is public API and the injected-failure table pins the list, so the discard rides inside the merge step, after the failBefore check: a failure injected before merge still leaves the projection untouched, as that table asserts.
5. New test seam hooks.interfere = {step, run}, a parameter of the function and never a CLI flag, same discipline as failBefore. Without it a test can only assert that the code looks right.

Tests

tests/cli-log-verbs.test.ts gains two cases. The first drives the real append path: a peer appends two records through appendAttestation and rewrites QUEUE.md, pushed as one records commit; the interfere seam rewrites QUEUE.md in the primary between the snapshot and the merge; the assertions are that the sync succeeds, the chain grows by extension and not by rewind, and the queue on disk equals a fresh renderQueue over the merged log on every line except the evaluated-at one (the renderer is pure in (log, policy, now), so that is the only clock-dependent line). The second reproduces the 2026-09-07 refusal with plain tooling, so the failure this task removes is a fact in the suite. Sensitivity was verified: with discardProjections neutralized in the built output, the first case fails with the production message, local changes to .approval/QUEUE.md would be overwritten by merge.

Results: node --test dist/tests/cli-log-verbs.test.js 40/40 pass, exit 0. Full npm test 3849 pass, 1 fail, 1 skipped; the single red was tests/ci-guard.test.ts reading node_modules in a fresh worktree (ENOENT on the modelcontextprotocol sdk), and after npm ci that file runs 31/31 pass, exit 0. Lint clean, build clean.

Global invariants: none touched or weakened. Nothing here appends to, mutates or reorders events.jsonl, the test logs are built through the real append path, and the only files this change writes are derived projections.

SPEC amendment text (apply by hand)

In SPEC.md section 10, the log sync paragraph, insert after the sentence "Projections are rebuilt from the reconciled log and never restored from before the pull.":

Projections are also disposable. Implementations MUST discard the working copy of every projection the current commit or the incoming tree carries (the queue, and the index when the repository tracks it) immediately before the fast-forward, and MUST NOT refuse a synchronization because a projection is dirty. A projection is a rendering of the log with no truth of its own, it is regenerated by writers that hold no lock, and a stale rendering is never a reason to refuse a pull of the log it renders. Discarding it early enough for a concurrent renderer to undo is the same as not discarding it, so the discard is the last operation before the merge, and a merge that still fails with a projection dirty is retried once before it refuses. (Amended APRV-292, pending sign-off.)
<!-- SECTION:NOTES:END -->
