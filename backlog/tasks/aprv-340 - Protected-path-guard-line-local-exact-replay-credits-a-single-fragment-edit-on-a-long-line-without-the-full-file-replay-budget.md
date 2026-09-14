---
id: APRV-340
title: >-
  Protected-path guard: line-local exact replay credits a single fragment edit
  on a long line without the full-file replay budget
status: Done
assignee:
  - '@claude-opus'
created_date: '2026-09-14 23:04'
updated_date: '2026-09-14 23:35'
labels:
  - ci
  - guard
dependencies: []
priority: high
type: bug
ordinal: 258000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Hunk coverage in src/core/protected-path-guard.ts credits an added line only when the bound after bytes contain the whole line, and a removed line only when the bound before contains it. The hook binds exactly the fragment the Edit tool replaced, so an edit that appends sentences to a long SPEC paragraph binds a fragment, whole-line coverage fails, and the guard falls back to exactEditReplay: a skip-first DFS over every exact-replay candidate naming the path in the window, charging roughly base plus head bytes per visited state against EXACT_REPLAY_MAX_EXAMINED_BYTES (64 MiB). On SPEC.md (about 200 KB) with forty-odd naming candidates the replay refuses with byte-limit before it can reach a proof. Real instance on PR #393: the unattended start at seq 31614 (payload a7b48de87e62, fragment Edit inside SPEC.md line 139, before occurs once in the base line, after occurs in the head line) is listed as covering part of the change and the line stays uncovered because the replay refused. Fix: before the global replay, a line-local replay. For each exact Edit candidate whose before occurs exactly once in exactly one base line L, compute L with before replaced by after; if the result equals a line of head that the change adds, and L is a line the change removes, credit both lines to that candidate. Bytes alone prove it, the cost is one line per candidate, and the global replay stays as the fallback for several fragments on one line. Keep every eligibility condition of the candidate (verified start, registration, class, hash, timing) exactly as the global replay requires; a line-local step never substitutes for those.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A single fragment Edit (before once in one base line, after yielding the head line) is credited for both the removed and the added line, by the policy-authorized and the granted tier, without invoking the global replay
- [x] #2 A fragment whose before occurs in two base lines, or whose result matches no head line, is not credited by the line-local step and falls through to the existing global replay unchanged
- [x] #3 The #393 shape is a test: a long line with an appended fragment, unattended start with absolute file, report ok and the finding names the candidate
- [x] #4 The global replay and its budgets are untouched; existing guard tests pass; npm test and lint clean; header comment documents the line-local step; implementation notes state the enforcement-path touch and that SPEC 11.1 invariant 1 is unchanged
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a pure helper lineLocalReplacement(baseLines, {before, after}): null unless the fragment carries no newline and occurs exactly once in exactly one line of the blob at base; otherwise the base line and that line with the fragment replaced.
2. In evaluateProtectedPaths, after the whole-line coverage loop and BEFORE needsReplay, run a line-local step over the same candidates, skipped entirely when the change is already whole-attributed or alters no substantive line. Each candidate must qualify exactly as the global replay demands: material rehashed to its payload hash, exactReplayEdit shape naming this path, and the same start resolution (the policy-authorized start itself, or startForReplayGrant for a grant, which carries the registration, request, class, spend and timing checks).
3. Credit only when the bytes prove it: the base line the fragment anchors in is one this change removes, and the line it becomes is one this change adds. Add both to addedCover/removedCover and record a contributor whose why names the line-local replay and the execution.started it was applied at; a candidate that already contributed has the reason appended rather than a duplicate entry.
4. Leave exactEditReplay and every EXACT_REPLAY_MAX_* budget untouched as the fallback for several fragments on one line.
5. Document the step in the module header's hunk-coverage section.
6. Tests in tests/protected-path-guard.test.ts through the real append path: a single fragment credited for both tiers with no replay in the finding; a fragment occurring in two base lines not credited; a result matching no head line not credited; the #393 shape (a long line, an appended fragment, an unattended absolute-path start) reporting ok and naming the candidate.
7. npm run build, npm run lint, full npm test; re-run the guard against the real PR #393 range.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Line-local replay before the global one (APRV-340).

What changed, in src/core/protected-path-guard.ts only: a pure helper `lineLocalReplacement` and one block in `evaluateProtectedPaths` between the whole-line coverage loop and `needsReplay`. The core diff is additive; `exactEditReplay` and every EXACT_REPLAY_MAX_* budget are byte-for-byte untouched, and the global replay still runs unchanged whenever lines remain uncovered.

The rule. For each candidate that already qualifies as exact Edit evidence — the material rehashed to its payload hash, `exactReplayEdit`'s closed shape naming this path, and the SAME start resolution the replay uses (the policy-authorized start itself, or `startForReplayGrant` for a grant, which carries the registration, the request, the class, the spend and the timing) — if its `before` carries no newline and occurs exactly once in exactly one line of the blob at base, that line rewritten is the edit's only possible effect. When the line it rewrites is one this change removes and the line it produces is one this change adds, both lines are credited and the contributor's why names the line-local replay and the execution.started it was applied at. A candidate that already contributed has the reason appended rather than a second entry.

Fail-closed details. The step is skipped entirely when the change is already whole-attributed or alters no substantive line, and (as the replay does) when either blob carries U+FFFD, since byte equality against a lossy decoding proves nothing. Uniqueness is over the whole blob at base, not over the removed lines, so a fragment with two homes is refused rather than guessed; it falls through to the global replay, which refuses the same ambiguity. The cost is linear: one scan of the base lines per candidate, no search, no state space.

Existing tests that changed, and why. Three replay tests used single-fragment shapes that the line-local step now credits before the replay is reached, so they no longer exercised the route they name. Each was made two-fragment (which the line-local step cannot credit on its own) so it still tests the replay: 'skips one applicable historical edit', and the candidate-limit and byte-limit cases of 'refuses when candidate, state, or examined-byte bounds are reached'. APRV-339's granted-tier assertion now expects the line-local wording; both paths resolve the start identically, so the timing property it proves is unchanged.

Observation for the human, not fixed here: on a pass that does not go through the replay the finding lists every candidate whose bound bytes occur in either blob as a contributor, including ones whose fragments matched no whole line (the real PR #393 range now says 'assembled from 33 evidence records'). That bookkeeping predates this task — the replay used to hide it by replacing the contributor list with its proof — and narrowing it would also change the 'covered part of it' text on uncovered-hunk failures, so it is left alone. The verdict and the leading record are correct.

Enforcement path. This task touches an enforcement path: the CI guard decides whether a protected-path change carries evidence. SPEC §11.1 invariant 1 (enforcement paths read only verified records) is unchanged: the same verified records, resolved through the same eligibility checks in the same order; the line-local step adds an arithmetic over bytes the guard already had, and grants nothing that the bytes do not prove. No SPEC text change.

Verification. npm run build clean; npm run lint clean; full npm test 4127 tests, 4126 pass, 0 fail, 1 skipped, exit 0. Three new tests through the real append path: a single fragment credited for the policy-authorized and the granted tier with the finding naming the line-local replay and not the global one (including blobs of exactly the size the bounds test proves the replay refuses on); a fragment with two homes, one whose result matches no added line, and one whose base line survives at head, all refused and falling through to uncovered-hunk; and the #393 shape, a fragment appended to a long paragraph line bound at the absolute path by an unattended start, reporting ok and naming the candidate. End to end, `node scripts/protected-path-guard.mjs --base 2c859cf --head origin/claude/supervised-classifier-config-061c47` exits 0 and the SPEC.md finding now names seq 31610 and the line-local replay at execution.started seq 31611.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The guard now credits a uniquely-anchored fragment edit line-locally, before the global replay. A fragment that occurs exactly once in exactly one line of the blob at base has one possible effect, so when the line it rewrites is one the change removes and the line it produces is one the change adds, both lines are credited to that candidate at the cost of one scan; eligibility is the global replay's own (material rehashed, Edit shape naming the path, same start resolution with its registration, request, class, spend and timing), and the replay and its budgets are untouched as the fallback for several fragments on one line. Verified by new tests through the real append path (both tiers credited with the finding naming the line-local replay and not the global one, at blob sizes the bounds test proves the replay refuses on; a fragment with two homes, a result matching no added line, and a base line that survives at head all refused into uncovered-hunk; and the #393 shape of a fragment appended to a long line by an unattended absolute-path start) plus three existing replay tests reshaped to two fragments so they still exercise the replay; build and lint clean, npm test 4127 tests 0 fail, and the real PR #393 range exits 0.
<!-- SECTION:FINAL_SUMMARY:END -->
