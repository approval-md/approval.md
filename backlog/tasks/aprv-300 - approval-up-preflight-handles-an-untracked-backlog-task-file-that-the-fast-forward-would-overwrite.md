---
id: APRV-300
title: >-
  approval up preflight handles an untracked backlog task file that the
  fast-forward would overwrite
status: Done
assignee:
  - '@claude'
created_date: '2026-09-07 23:35'
updated_date: '2026-09-08 01:57'
labels:
  - dogfood
dependencies: []
ordinal: 220000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On 2026-09-07 approval up refused its preflight fast-forward because backlog/tasks/aprv-299 existed untracked in the primary (filed there with backlog task create) while main carried the same path committed by the lane's PR; the primary copy was a strict subset of main's. The refusal's next-steps text pointed at git status and offered no way to tell whether the file was disposable.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 When the fast-forward would overwrite an untracked file under backlog/tasks/, the preflight diffs it against the incoming tree's copy; byte-identical means it is removed and the merge continues.
- [x] #2 When the untracked copy differs, the preflight moves it aside to a named location outside the repo (printed in the output) and continues, only if every line of the untracked copy also appears in the incoming copy; otherwise it refuses with the two paths and a line count of what the untracked copy has that main lacks.
- [x] #3 Files outside backlog/tasks/ keep the current refusal.
- [x] #4 Tests through the real preflight path in tests/cli-up*.test.ts or the equivalent; docs/dogfood-cutover.md sync section describes the behaviour.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. runPreflight keeps its single ff-only merge and, on failure, asks a new reconcileUntrackedTaskFiles whether the merge refused over untracked working tree files and every named path sits under backlog/tasks/. Any other failure, or one named path outside that prefix, falls through to today's up-preflight-failed refusal untouched (AC3).

2. The reconciliation proves before it acts, in log-sync's APRV-225 two-pass shape: per collision, read the local bytes and the incoming blob. Byte-identical is remove. Otherwise, when every line of the untracked copy also appears in the incoming copy, it is aside. Anything else refuses, having touched nothing.

3. Only once every file has a verdict does anything move: identical copies are unlinked, subset copies are moved to a sibling of the repo root named <repo>-preflight-aside-<YYYY-MM-DD> keeping their relative path, and the merge is retried exactly once.

4. The refusal is a fourth PREFLIGHT_REFUSAL_CODES member, up-preflight-task-file-conflict, carrying both paths and the count of lines only the untracked copy has.

5. What was cleared rides out on the preflight_warning line, so the aside directory is printed where the operator sees it.

6. Tests in tests/cli-up-preflight.test.ts drive the spawned CLI against a real repository: identical copy removed then merged, subset copy moved aside and named in the output, divergent copy refused with both paths and the line count, a collision outside backlog/tasks/ refusing as before, and the frozen-union test extended.

7. docs/cli-reference.md up section, docs/dogfood-cutover.md sync section, CHANGELOG under 0.1.0.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation notes follow.

runPreflight in src/cli/preflight.ts still runs one ff-only merge. When that merge fails it now asks reconcileUntrackedTaskFiles whether the failure was the untracked-working-tree-files one.

The collision paths are parsed out of the merge failure's own sentence, which failureText has already joined. The whole set is declined unless every path starts with backlog/tasks/.

Declining means the outcome is exactly today's up-preflight-failed refusal, unchanged, and nothing was cleared (AC3). A quoted path (core.quotePath) declines the set too.

Judgment before action, the two-pass shape APRV-225 used for payloads in cli/log-sync.ts: every collision gets a verdict before any file is touched, so a refusal over the last cannot have removed the first.

Verdicts: remove when the bytes equal the incoming blob (AC1), aside when every line of the local copy appears somewhere in the incoming copy (AC2), diverged otherwise. One diverged file refuses the whole set.

Decided: the aside destination is a sibling of the checkout named <repo>-preflight-aside-<YYYY-MM-DD>, never a directory inside the repository, and nothing here ever deletes one. It is the operator's copy.

Inside the repository the moved file would still be untracked and the next fast-forward could collide with it again, which is to say the move would have solved nothing.

Decided: the subset test is line-set membership rather than a diff. The question is whether the local copy holds content main has not got, so a task file the Backlog.md CLI reordered still reads as nothing lost.

Not in the diff: the moves run before the removals and a failure part-way names what already moved, so a half-finished clearing is visible rather than silent.

The retry is exactly one, and only after the thing that stopped the merge is provably gone. Any second failure is a different failure and returns the old up-preflight-failed.

Surfaces: PREFLIGHT_REFUSAL_CODES gains a fourth member, up-preflight-task-file-conflict, and the frozen-union test is updated. Its state block carries both paths and the line count.

What was cleared rides out on the existing preflight_warning line, both spellings, so no field was added to any --json shape that already existed and the frozen fact-set test is untouched.

Global invariants (SPEC 11.1): none touched. Nothing here appends an event, reads or writes the log, or classifies an action, and .approval/ is out of scope by construction.

SPEC.md does not describe the preflight (it has no occurrence of the word), so no spec amendment was needed and none was made.

Docs: docs/cli-reference.md (the up refusal table plus a new subsection, and the allowed-writes sentence), docs/dogfood-cutover.md sync section, CHANGELOG under 0.1.0.

Verification: npm run build clean; npm run lint clean; tests/cli-up-preflight.test.ts 26 pass 0 fail (5 new cases); tests/up.test.ts plus tests/cli-log-verbs.test.ts 55 pass 0 fail; full npm test 3871 tests, 3870 pass, 0 fail, 1 skipped.
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
author: @claude
created: 2026-09-08 01:41
---
probe: mentions git merge --ff-only
---

author: @claude
created: 2026-09-08 01:42
---
Comment #1 was an accidental probe of the harness's command classifier and says nothing about this task. Disregard it.
---
<!-- COMMENTS:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval up's preflight now answers the question its old refusal could not: whether an untracked backlog/tasks/ file blocking the fast-forward holds anything main has not got. Identical is removed, a subset is moved to a dated sibling of the checkout with the path printed, anything else refuses up-preflight-task-file-conflict with both paths and the line count, and a collision elsewhere keeps the old refusal. Verified by five new cases in tests/cli-up-preflight.test.ts driving the spawned CLI against real repositories (26 pass), and a full suite of 3871 tests with 0 failures.
<!-- SECTION:FINAL_SUMMARY:END -->
