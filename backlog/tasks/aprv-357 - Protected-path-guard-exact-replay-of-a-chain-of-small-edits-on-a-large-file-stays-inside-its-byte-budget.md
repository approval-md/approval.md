---
id: APRV-357
title: >-
  Protected-path guard: exact replay of a chain of small edits on a large file
  stays inside its byte budget
status: To Do
assignee:
  - '@claude'
created_date: '2026-09-17 20:09'
updated_date: '2026-09-19 09:42'
labels:
  - guard
  - ci
  - spec
dependencies: []
priority: medium
ordinal: 274000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed on PR #427 (APRV-324, 2026-09-17). Every SPEC.md edit on the PR had proceeded under policy.edit.spec and left its execution.started record, and every record was on the records branch the guard read (through seq 42403), yet the guard refused SPEC.md as uncovered-hunk with the reason that exact BASE-to-HEAD replay was refused after reaching its byte limit. The same PR touched design/channel-sender-identity.md over the same three rounds and that file reconstructed byte for byte from five records. The difference is the file: SPEC.md is over 200 KB, the lane made many Edit-tool edits to it across three rounds including edits to its own earlier edits, and 29 records named the path within the window. The guard fell back to per-record matching, which it rightly says is not coverage, and the only way out was a human whole-file sign-off (APRV-338), which is weaker evidence than the grants that actually existed. A contrast case the same day: PR #432 edited SPEC.md in two commits with three records and replayed exactly once the records were present, so the number of commits is not the trigger; the size of the replay is. APRV-340 already gave the guard a line-local exact replay for a single fragment edit on a long line without the full-file budget. Extend that idea to a chain: replay a sequence of line-local edits (each binding lines out and lines in) against the base blob without materializing the whole file per step, or budget by bytes actually changed rather than by file size times records, so an honest chain of small edits on a large file is covered by the evidence it has. The guard must stay exact: no partial coverage, no fuzzy matching, and a chain that does not reconstruct HEAD byte for byte still fails. Carter approved filing on 2026-09-18. Evidence is one case; the task should first reproduce it from the PR #427 history. Related: APRV-316, APRV-337, APRV-339, APRV-340, APRV-338.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The PR #427 case is reproduced as a test fixture built through the real append path: a large file, a chain of small Edit-tool edits including edits to earlier edits, all records present, and the current guard refusing on its byte limit
- [ ] #2 The guard covers that fixture by exact replay within its budget, and its finding names the replayed records in order as it does today; the budget rule is documented in the guard header and docs/git-evidence.md or the guard doc
- [ ] #3 Exactness is unchanged: a chain missing one record, a record whose after-state was later altered outside the log, and a reordered chain each still fail uncovered-hunk, with tests; no fuzzy or partial coverage is introduced
- [ ] #4 Guard runtime on the fixture stays within the CI job budget (measured and recorded); build, typecheck, lint and the guard suites pass
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
REPRODUCED 2026-09-19, read-only, against PR #427 own history. No code changed. The reproduction contradicts part of the task premise, so the fix is not the one the description assumed and this lane stopped rather than choose. Handing back for a design ruling.

The run. base = merge-base(69c5b00^1, 69c5b00^2) = 6d1b2bbe1dde, head = e66ba9e689a2, which is what the CI job computes (git merge-base origin/$BASE_REF HEAD, three-dot semantics). Committed log at head: 42403 records, seq 1..42403, verified clean. evaluateProtectedPaths on SPEC.md reproduces the failure exactly: FAIL uncovered-hunk, 14 lines trace to no authorized material, 29 evidence records name the path, 27 covered part of it, and the sentence the task quotes, exact BASE-to-HEAD replay refused after reaching its byte limit. Runtime 173 ms (AC4 measurement for the CURRENT behaviour: the guard gives up fast, so the byte limit is not a wall-clock problem, it is a coverage problem).

The finding that changes the premise. SPEC.md at base is 217376 bytes over 798 lines; at head 227909 bytes over 821 lines; and 671 of those lines differ. That is not a chain of small edits, it is most of the file. The reason is that lane/sender-identity-324 merged origin/main into itself twice (b905791 and e66ba9e) while four other lanes were editing SPEC.md the same day. Three-dot semantics excludes what MAIN did, but it does not exclude what the branch ABSORBED by merging main; those edits are part of the branch diff and they bring their own grants, made in other worktrees, whose before-states no longer occur at this base. So the amplifier is the merge-in, not the number of Edit calls, and the line count changes by 23, which rules out the line-local chain the description proposes: a chain of line-local edits cannot change the line count.

Two options, and the second may dissolve this task.

OPTION A, the task as filed. Make the exact replay affordable for tens of edits over a 220 KB file: budget by bytes actually changed rather than by file size times states, and represent the replay state as a line array with an incremental mismatch counter and per-step occurrence counts, so a visit costs O(changed) instead of O(file). Insertions and deletions of whole lines have to be handled too, which the APRV-340 line-local form does not do. Exactness is preserved (a chain still has to reconstruct head byte for byte); the cost is a second replay engine beside the global one.

OPTION B, the unit of judgment. Judge the pull request PER COMMIT, base = commit parent, head = commit, which is what APRV-369 just did for the doctor arm A and for the same reason: a grant binds ONE edit. Under B, PR #427 stops being one 671-line replay and becomes each lane commit own small edit against its own grant, and the merged-in commits are judged on the commits that made them, which their own pull requests already passed. It would make CI and the doctor agree by construction rather than by two code paths kept in step, and it would likely close this task without a new replay engine. What it needs from a reviewer is the security argument: every changed byte is still in some commit, so nothing goes unjudged, but the guard would no longer ask a question about the combined diff, and whether that matters is a ruling rather than an implementation detail.

This lane did not choose. APRV-357 stays To Do with the reproduction recorded.
<!-- SECTION:NOTES:END -->
