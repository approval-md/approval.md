---
id: APRV-409
title: >-
  Classifier: a quoted prose argument that begins with a protected directory
  path classifies as that path, so a backlog task description sat nine minutes
  on the gate
status: Done
assignee:
  - '@lane-a'
created_date: '2026-09-20 19:06'
updated_date: '2026-09-22 01:55'
labels:
  - classifier
  - hook
  - bug
dependencies: []
documentation:
  - src/core/command-class.ts
priority: high
ordinal: 316000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-20 (log seq 64337, 64338). A backlog task create whose third --ac argument began with the literal text of a workflow path followed by prose (the argument, after shell parsing, was one word: the path, a space, and a sentence) classified policy.edit.ci by rule protected-path, sat the full nine-minute wait on the gate, and was denied on timeout. The command writes one task file. Reproduction: approval hook classify -- "backlog task create x --ac WORKFLOW_PATH_THEN_A_SENTENCE" answers policy.edit.ci / protected-path when the argument starts with the .github workflows directory path, while the same argument starting with CLAUDE.md or APPROVAL.md answers files.write.workspace, and the same path inside a sentence rather than at its head also answers files.write.workspace. Cause: strictestProtected in src/core/command-class.ts (called from the protected-path pass after refinement, the block commented "A protected path anywhere in an effectful segment takes that path class") tests every positional word with protectedPathClass. pathSegments splits the word on slashes, so a word whose first segments are a protected DIRECTORY entry prefix-matches whatever follows, including a sentence with spaces; an exact-file entry does not, which is why CLAUDE.md prose passes. The word was never a path the command would touch. This is a strictness bug rather than a widening, and the fix must stay on that side: a word containing whitespace or a newline is prose, not a path, and is skipped by the positional scan only; write-redirection targets and the apply-patch and hook file paths, which are real paths by construction, keep their behaviour. Care: an argument with an embedded space CAN be a real path (a file named with a space); the safe rule is narrow, skip only words containing whitespace whose protected match came from a directory-prefix entry and whose remainder after the matched prefix contains whitespace, or require that the matched word, taken as a path, ends at a segment boundary. Decide in the plan and pin it with vectors. Related: the journal entry of 2026-09-20 from the APRV-406 session, and APRV-407 whose description carried the sentence.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval hook classify answers files.write.workspace for a backlog task create whose quoted argument starts with a protected directory path followed by a sentence, and for the same shape under cp, tee and any other effectful row
- [x] #2 A bare path argument, a path with a real embedded space when quoted as one word, a path inside a sentence, and a protected file (CLAUDE.md) at the head of a sentence each keep their current answer; vectors in tests/command-class-quoting.test.ts or a sibling file pin all five shapes
- [x] #3 The conformance vector suite gains the shapes above and command-class bumps its version
- [x] #4 Implementation notes state that the change narrows nothing on the strict side: every word that classified as a protected path before and IS a path still does
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Decision (the rule, chosen from the two the description offers). Take the FIRST: a positional word is prose, not a path, when (a) it contains whitespace, (b) the first of its slash-separated segments that carries whitespace is not the first segment, and (c) the whitespace-FREE head before that segment already classifies as the same protected surface the whole word did. Then the protected match came entirely from a directory-prefix run and everything after it is text. Rejected the 'ends at a segment boundary' reading: a directory entry matches a contiguous run by construction, so every match already ends at one and the test would be inert. Rejected a whitespace-run threshold on the remainder (which would have rescued 'cp x ".approval/my file.txt"'): a number in a conformance rule is folklore a second implementation has to guess at, and 'my file.txt' and 'ci.yml should not gate this' are the same string shape.
2. Implement in src/core/command-class.ts: a new pure helper proseNamingProtectedPath(word, surface, protectedPaths) beside strictestProtected, and a third parameter on strictestProtected that turns the skip on. Pass it ONLY at the positional-scan call site (the block commented 'A protected path anywhere in an effectful segment takes that path class'). The redirect-target call site, core/apply-patch.ts, core/protected-path-guard.ts, core/wysiwys.ts and the hook's file-tool pass all keep protectedPathClass unchanged: their paths are paths by construction.
3. Conservative direction: when the head classifies as a DIFFERENT surface from the whole word, or classifies as nothing, the word is kept. Whitespace before the protected prefix ('my notes dir/.github/workflows/x.yml') therefore keeps its class, and so does every exact-file match at any depth ('my notes dir/CLAUDE.md'), because those match on the final segment and the head is empty.
4. Tests: extend tests/command-class-quoting.test.ts with the five shapes AC2 names plus the AC1 shape under backlog, cp and tee, plus the redirect control, plus a routed-policy case (.github/workflows/ under a {path,class} entry answering policy.edit.ci) and a log.mutate case, and a negative control that a bare protected path is unmoved.
5. Conformance: add the same shapes to commandClassVectors in scripts/regen-conformance-vectors.mjs, bump command-class vectors_version 1.4.0 -> 1.5.0 with a MINOR rationale in the existing comment block (new vectors; no committed expectation moves, because the suite carries no prose-naming-a-path vector today), run npm run build then node scripts/regen-conformance-vectors.mjs, and commit the regenerated conformance/vectors/command-class.v1.json and conformance/conformance-manifest.json.
6. Verify: npm run build, npm run typecheck, npm run lint; node scripts/run-tests.mjs --only command-class command-class-quoting command-class-routing cli-hook cli-hook-read-scope conformance conformance-regen hook-module-graph; node conformance/run.mjs.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The rule, decided from the two the description offered. A positional word is prose rather than a path when its protected match came entirely from a whitespace-FREE head: the word carries whitespace, the first of its slash-separated segments that carries whitespace is not the first segment, and the head in front of that segment already classifies as the SAME surface the whole word did. New pure helper proseNamingProtectedPath in src/core/command-class.ts, turned on by a third parameter skipProse on strictestProtected that ONLY the positional scan passes. Rejected the second reading (require the matched word to end at a segment boundary): a directory entry matches a contiguous run of segments by construction, so every match already ends at one and the test would be inert. Rejected a whitespace-run threshold on the remainder, which would have rescued the one shape named below: a number in a rule the conformance suite pins is folklore a second implementation has to guess at.

Where the fix does NOT reach, by construction. The redirect-target call of strictestProtected, core/apply-patch.ts, core/protected-path-guard.ts, core/wysiwys.ts and the hook's file-tool pass all call protectedPathClass unchanged. Their paths are paths because something is about to create or has created them, so no skip is offered. A read never reaches the positional scan at all, which is pinned by a vector.

AC4, stated precisely rather than as a slogan. The change narrows nothing for: every word with no whitespace, which is the whole ordinary universe of paths and is decided before the test runs; every exact-file match at any depth, because that match needs the word's FINAL segment and leaves no whitespace-free head, so 'cp a.md "my notes dir/APPROVAL.md"' is still policy.core and a real file named with a space stays protected; whitespace occurring BEFORE the protected run, where the head classifies as nothing; a match DEEPER than the head answers, where the head answers a different surface and the word is kept (the vector for this is the policy file under a directory named with a space, which stays policy.core while its head answers policy.edit.ci); and every path-by-construction surface above.

One shape does move and it is named rather than hidden: a directory-prefix match whose remainder carries whitespace, in a positional of an effectful command. 'cp x ".approval/my file.txt"' now takes the command's own class instead of policy.core. That is a deliberate trade, not an oversight: 'my file.txt' and 'ci.yml should not gate this task' are the same string shape, and no pure, disk-free rule tells a one-component filename with a space apart from a four-word sentence. AC1 requires the second to stop gating, so the first goes with it. The write itself is not unguarded: core/protected-path-guard.ts judges what a commit actually changed, from the log rather than from a session, and a .approval/ file with no authorization record still fails the pull request.

Live observation from this session, and it is evidence for the rule rather than for the bug. The orchestrator predicted that writing this task's own implementation plan would misclassify, because the plan text spells protected directory paths. It did not: the plan edit classified files.write.workspace and was allowed. The reason is exactly condition (b) above. The plan is one double-quoted word beginning '1. Decision (the rule...', so its FIRST segment carries whitespace, no whitespace-free head exists, and the protected paths sitting mid-word were never matched, before this change or after it. The bug needs the path at the HEAD of the word, which is what the incident argument had and what the new vectors carry.

Verification, all from this worktree at the commit this note rides.
npm run build: exit 0, no output. npm run typecheck: exit 0, no output. npx oxlint src tests: exit 0, no warnings.
node scripts/run-tests.mjs --only command-class command-class-quoting command-class-routing command-class-ref-delete command-class-harness-launch cli-hook cli-hook-read-scope conformance conformance-regen hook-module-graph: tests 898, pass 898, fail 0, cancelled 0, skipped 0, todo 0, exit 0.
tests/command-class-quoting.test.ts alone: tests 41, pass 41, fail 0 (28 pre-existing, 13 new).
node conformance/run.mjs: totals vectors 471, passed 471, failed 0, controls 176, manifest ok true. command-class.v1.json 86 vectors (10 negative controls), up from 73 (10), vectors_version 1.4.0 -> 1.5.0.
The regeneration moved no committed expectation: the only removed lines in conformance/vectors/command-class.v1.json are the vectors_version and count lines, which is the evidence for the MINOR bump the regen script's comment block argues for.

Re-verified after rebasing onto main at 534ea8e, which had moved 17 commits and touched src/core/command-class.ts, tests/command-class-quoting.test.ts, scripts/regen-conformance-vectors.mjs and conformance/vectors/command-class.v1.json. The rebase was clean and the regeneration reproduces the committed vectors byte for byte on the new base, so nothing upstream moved an expectation of this task's or vice versa.
npm run build, npm run typecheck, npx oxlint src tests: each exit 0, no warnings.
node scripts/run-tests.mjs --only gate command-class command-class-quoting command-class-routing cli-hook cli-hook-read-scope cli-hook-hermes conformance conformance-regen hook-module-graph: tests 916, pass 916, fail 0, exit 0.
node conformance/run.mjs: 474 vectors, 474 passed, 0 failed, 176 controls, manifest ok. command-class stands at 86 vectors (10 negative controls), vectors_version 1.5.0; upstream's hook-read-scope took 2.0.0 in the same window and no other open branch claims 1.5.0 for this suite.

CI verdict on PR #538 (run 35676814830): completed / success, gh pr checks 538 --watch exited 0. classify tier pass 14s; protected paths (grant cross-check) pass 47s; full gate node 22 shard 1/3 pass 5m49s, shard 2/3 pass 10m51s, shard 3/3 pass 8m24s; ci pass 3s. The three skipping jobs (docs guard light tier, node 20 floor, records guards) are tier gates this change does not trigger, not failures. No shard was red, so no failing test names to name.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A positional word whose protected match came entirely from a whitespace-free head is prose, not a path, and the positional scan skips it: a task acceptance criterion opening with a workflow path now classifies files.write.workspace instead of policy.edit.ci. New helper proseNamingProtectedPath in src/core/command-class.ts, opted into by strictestProtected's skipProse at the one call site; redirection targets, apply-patch, the protected-path guard and the hook's file-tool pass are untouched. Verified with 13 new tests in tests/command-class-quoting.test.ts (41 pass, 0 fail), 13 new conformance vectors (command-class 1.4.0 -> 1.5.0, 86 vectors, no committed expectation moved), the 10-suite run at 898 pass / 0 fail exit 0, and node conformance/run.mjs at 471/471. The one real path shape the rule gives up (a directory-prefix match whose remainder carries whitespace) is named in the notes with the reason and with the guard that still covers it. The merge is NOT armed: the gate daemon is down today, so gh pr merge was not run.
<!-- SECTION:FINAL_SUMMARY:END -->
