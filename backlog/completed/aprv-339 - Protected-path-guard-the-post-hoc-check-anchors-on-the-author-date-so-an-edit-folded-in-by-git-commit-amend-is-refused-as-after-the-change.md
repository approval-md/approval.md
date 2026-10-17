---
id: APRV-339
title: >-
  Protected-path guard: the post-hoc check anchors on the author date, so an
  edit folded in by git commit --amend is refused as after the change
status: Done
assignee:
  - '@claude-opus'
created_date: '2026-09-14 23:04'
updated_date: '2026-09-14 23:21'
labels:
  - ci
  - guard
dependencies: []
priority: high
type: bug
ordinal: 257000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
scripts/protected-path-guard.mjs derives one anchor per protected path with git log -1 --format=%aI (author date), chosen so a rebase does not move it, and the core (policyAuthorizedEvidence and startForReplayGrant in src/core/protected-path-guard.ts) uses that single anchorMs for two different questions: was the start BEFORE the change landed (post-hoc refusal) and is the start within lookbackMs of the change (staleness). An amended commit keeps its first author date while its committer date moves, so a genuine edit made between the two is refused as having happened after the change. Real instance on PR #393: commit c03cbb8 has author date 2026-09-13T23:06:44-07:00 and committer date 2026-09-13T23:08:22-07:00; the unattended start at seq 31684 (payload 8b75c80ddb78, a whole-line Edit of SPEC.md line 160 whose before is in base and after is in head) is at 2026-09-14T06:07:58Z, after the author date and before the committer date, and the guard credits it with nothing. Fix: carry both dates; measure the post-hoc check against the committer date (the moment those bytes were committed; a rebase or amend only moves it later, which never turns a genuine earlier start into a post-hoc one) and the staleness check against the author date (so a rebase still does not expire evidence). Enforcement path: SPEC 11.1 invariant 1 unchanged; the implementation notes must say so.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The guard script passes both the author and committer timestamps of the last commit touching each protected path in the range, and the core exposes the pair in its input type
- [x] #2 A start after the author date and before the committer date of an amended commit is credited (policy-authorized and granted tiers, and the replay); a start after the committer date is still refused as post-hoc; a start older than the lookback measured from the author date is still refused as stale; tests through the real append path for all three
- [x] #3 The #393 shape is a test: whole-line unattended Edit with absolute file, start between the two dates, report ok
- [x] #4 Header comment of the guard and the script explain the two anchors; npm test and lint clean; implementation notes state the enforcement-path touch
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Core: add an exported ChangeTimestamps pair ({author, committer}) and widen GuardInput.changeTsFor to (path) => string | ChangeTimestamps | null; a bare string (or a pair with one side missing/unparseable) means the same date answers both questions, so every existing caller is unchanged.
2. Core: derive ONE ChangeAnchor per path ({authorTs, committerTs, authorMs, committerMs}, both ms null together) and thread it where anchorMs went — policyAuthorizedEvidence, startForReplayGrant, exactEditReplay, attributeRun, inWindow, distance.
3. Core: split the two questions. Ordering/post-hoc (a start or run cannot precede-fail against a date the amend moved) measures against the COMMITTER date; staleness and the attribution distance measure against the AUTHOR date, so a rebase still does not expire evidence. boundText names both dates when they differ and is byte-identical when they do not.
4. Script: gather --format=%aI%n%cI and hand the core the pair; rewrite the 'Author date, so a rebase does not move it' comment and add the two-anchor paragraph to the script header and the core module header.
5. Tests: core cases through the real append path — start between author and committer credited (policy-authorized and granted tiers plus the replay), start after the committer date still refused post-hoc, start older than the lookback measured from the author date still refused stale. Script test: the #393 shape end to end, a real git commit whose GIT_AUTHOR_DATE precedes its GIT_COMMITTER_DATE (what git commit --amend leaves), an unattended whole-line Edit start with an absolute file between them, report ok.
6. npm run build, npm run lint, full npm test; verify against the real #393 branch with scripts/protected-path-guard.mjs --base 2c859cf --head origin/claude/supervised-classifier-config-061c47 (expect line 160 covered).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Two anchors, one per question (APRV-339).

What changed. `GuardInput.changeTsFor` now returns `string | ChangeTimestamps | null`, where the new exported `ChangeTimestamps` carries git's author date (`%aI`) and committer date (`%cI`). A bare string, or a pair with one side missing or unparseable, still answers both questions, so every caller written before this (`src/core/dark-session.ts`, every existing test) behaves exactly as it did. One private `ChangeAnchor` is derived per path (`changeAnchorOf`), whose `authorMs`/`committerMs` are null together by construction, so no downstream check can enforce half a bound. The anchor replaces the single `anchorMs` in `policyAuthorizedEvidence`, `startForReplayGrant`, `exactEditReplay` and `attributeRun`.

The split. ORDERING (post-hoc: could this record have written these bytes) is measured against the COMMITTER date, which an amend or rebase only ever moves later. STALENESS (is this evidence about this change at all) and the command-attribution distance are measured against the AUTHOR date, which a rebase does not move. `attributeRun` was included because its `from > anchorMs + SKEW_GRACE_MS` is literally the same ordering question and would have been the next instance of the same bug; its distance side still uses the author date. The symmetric staleness pre-filter (`inWindow`) and the grant-ranking distance keep the author date.

Reporting. `boundText` names both dates when they differ (`authored X, committed Y`) and is byte-identical to before when they do not, which is why no existing finding-text assertion moved.

Script. `changeTsFor` in scripts/protected-path-guard.mjs gathers `--format=%aI%n%cI` and hands the core the pair. The old `Author date, so a rebase does not move it` comment is replaced by the two-anchor note; the script header and the core module header each gained a section explaining which question is asked of which date, and `GuardInput.changeTsFor`'s doc comment states it at the field.

Enforcement path. This task touches an enforcement path: the CI guard decides whether a protected-path change carries evidence. SPEC §11.1 invariant 1 (enforcement paths read only verified records) is unchanged: the guard reads the same verified log records through the same verifier, and the same checks run in the same order. What changed is which of git's two dates a temporal comparison is made against. No SPEC text change.

Verification. npm run build clean; npm run lint clean; full npm test 4124 tests, 4123 pass, 0 fail, 1 skipped, exit 0. New tests: two in tests/protected-path-guard.test.ts (start between the dates credited for the policy-authorized tier and, through startForReplayGrant, for the granted tier and the replay; start after the committer date still post-hoc; start older than the lookback from the author date still stale; a one-sided pair falling back) and one in tests/protected-path-guard-script.test.ts driving real git with GIT_AUTHOR_DATE six minutes ago and GIT_COMMITTER_DATE two minutes ago, an unattended absolute-path whole-line Edit start four minutes ago, report ok, with a same-date control that still fails. End to end against the real PR #393 branch: `node scripts/protected-path-guard.mjs --base 2c859cf --head origin/claude/supervised-classifier-config-061c47` now exits 0 and PASSes SPEC.md (seq 31684, the start that was refused as post-hoc, is credited and completes the replay).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The protected-path guard now carries both of git's dates per protected path and asks a different question of each: ordering (post-hoc) against the committer date, which an amend or rebase only moves later, and staleness against the author date, which a rebase does not move. scripts/protected-path-guard.mjs gathers %aI and %cI; GuardInput.changeTsFor accepts a ChangeTimestamps pair and a bare string still answers both, so every existing caller is unchanged. Verified by new tests through the real append path (start between the dates credited in the policy-authorized and granted tiers and in the replay, after the committer date still post-hoc, older than the lookback from the author date still stale) and by a real-git script test whose commit has GIT_AUTHOR_DATE before GIT_COMMITTER_DATE with a same-date control that still fails; build and lint clean, npm test 4124 tests 0 fail; and end to end the real PR #393 range now exits 0 where it reported uncovered-hunk.
<!-- SECTION:FINAL_SUMMARY:END -->
