---
id: APRV-395
title: >-
  Site version guard binds every version string on the site, and the
  published-on-npm claim follows the tag
status: Done
assignee:
  - '@claude-lane-d'
created_date: '2026-09-20 02:46'
updated_date: '2026-09-22 00:33'
labels:
  - site
  - release
  - guard
dependencies: []
priority: medium
ordinal: 304000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found on 2026-09-20 during the 0.3.0 bump (APRV-371 AC1). tests/site-version-guard.test.ts (APRV-332) binds four strings to package.json version: the #pkg-version note and the JSON-LD softwareVersion in index.html, the JSON-LD softwareVersion in features/index.html, and two lines in llms.txt. Four sibling strings state the same fact and are bound to nothing: the features footer (Feature index for approval-md X), the #feature-index JSON version key in features/index.html, and llms-full.txt's bare vX line and its Feature index: approval-md X line. The 0.3.0 bump moved all eight, the four guarded ones because the suite fails otherwise and the four unguarded ones by hand on the release orchestrator's ruling, which is exactly the hand step the guard exists to remove.

Second defect in the same test, and it is the sharper one. The guard requires llms.txt to say 'Version X is published on npm' the moment package.json reads X, which is false for the whole window between the bump merging and the Trusted Publishing run finishing: the tag and the publish are separate gated acts (APRV-307, APRV-329). The bump PR therefore publishes a claim the project cannot yet support, on the site that documents a project about not making claims you cannot support. The release orchestrator ruled on 2026-09-20 that the gap is acceptable for the hour it lasts and that the guard must not change mid-release, so this is the follow-up; the operator has not weighed in on it.

Two shapes for the fix, and the task should pick one after reading the test: either the sentence is keyed to the latest published tag (the guard reads the tag, not package.json, and the bump no longer touches that line), or the sentence is reworded to something true at bump time and the guard keeps reading package.json. The second is cheaper and has no new input; the first is the one that cannot go stale.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 tests/site-version-guard.test.ts binds all eight version strings, including the features footer, the #feature-index JSON version key, and llms-full.txt's two lines
- [x] #2 The published-on-npm sentence in llms.txt is either keyed to the latest published tag or reworded to a claim that holds at bump time; the test asserts whichever was chosen, and the decision is recorded in the notes
- [x] #3 A version bump that touches package.json alone fails the suite with a message naming every file still to move
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read tests/site-version-guard.test.ts and find every version string on the site: index.html (#pkg-version, JSON-LD softwareVersion), features/index.html (JSON-LD softwareVersion, footer line, #feature-index JSON version key), llms.txt (two sentences), llms-full.txt (bare vX line, Feature index line).
2. Turn the guard into a table of rows (file, what, pattern, exact occurrence count) walked by one test that collects EVERY miss, so a bump that touches package.json alone is told the whole list rather than the first file.
3. Decide AC2 between keying the npm sentence to the latest published tag and rewording it. Pick rewording, on the ground that a tag is not a publication either and the registry is the only thing that knows the registry; record the reasoning in the notes and in the file header.
4. Reword both llms.txt sentences to 'The current version is X', a fact package.json proves about this tree, and keep the npm link without answering for what is on it.
5. Add a third test banning the published-on-npm sentence shape across all four pages, so the claim cannot be written back.
6. Evidence for AC3: bump package.json to a version no page carries, run the suite, capture the report, revert.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
AC2 DECISION, AND WHY THE CHEAPER SHAPE IS ALSO THE HONEST ONE. The task offered two: key the sentence to the latest published tag, or reword it so it holds at bump time. Rewording was chosen, and not only because it is cheaper.

A tag is not a publication. Tagging and the Trusted Publishing run are separate gated acts (APRV-307, APRV-329), so a guard reading the tag would assert 'published on npm' from evidence that the release was TAGGED. That is a narrower window than the one the task found, and it is the same kind of false claim, with the added cost that it now looks authoritative because a machine checked it. The registry is the only thing that knows what is on the registry, and this suite reaches no network by policy and should not start.

There is a second cost the task did not name: the guard runs on every PR, and a tag-reading guard depends on the checkout having tags, which is a property of the CI checkout step rather than of the repository. A test whose verdict depends on fetch depth is a test that will one day be green for the wrong reason.

So the pages now state what the repository can prove about itself. llms.txt says 'The current version is 0.3.0' in both places, the npm link stays and no longer answers for what is behind it. package.json reading X means this tree is at X, which is true from the moment of the bump.

THE CLAIM IS BANNED, not merely replaced. A third test sweeps all four pages for the sentence SHAPE ('<version> is published on npm', 'published version <version>'), so the next edit that reaches for it fails instead of quietly reintroducing the window. Rewording alone would have lasted until somebody wrote it back.

THE EIGHT STRINGS ARE NOW DATA. One table, one walk, exact occurrence counts rather than 'contains', so a duplicate left behind by a half-finished bump is caught as well as a missing one. Adding a version string to a page now means adding a row, which is the convention the four unguarded siblings were missing. The llms.txt row carries times: 2 deliberately: both of its sentences use one phrase, so there is one sentence shape to keep true rather than two, and the count is what binds them separately.

AC3 EVIDENCE, executed rather than reasoned about. package.json was bumped to 0.3.1, the suite run, and the report named all eight strings across all four files in one message ('package.json reads 0.3.1 and the site does not. Still to move:' followed by the eight lines). package.json was then reverted and the working tree confirms it unmodified. The guard's own failure is also asserted in the suite itself, against version 99.99.99, so the report shape is pinned and does not depend on anyone repeating that manual step.

GLOBAL INVARIANTS. None touched. This is a documentation guard over checked-in site files: no runtime module, no verdict, no log write.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
tests/site-version-guard.test.ts now holds all eight site version strings as a table (index.html #pkg-version and JSON-LD, features/index.html JSON-LD, footer and #feature-index version key, the two llms.txt sentences, and llms-full.txt's bare vX and Feature index lines), walked by one test that reports every miss at once. The published-on-npm claim was reworded rather than keyed to a tag, because a tag records a tagging and not a publication; llms.txt now says 'The current version is 0.3.0' in both places and a third test bans the old sentence shape across all four pages so it cannot be written back. Verified: site-version-guard 3/3 pass, and a real bump of package.json to 0.3.1 failed the suite with a message naming all eight strings across all four files before being reverted. docs-guard and release-notes also green (47 tests, 47 pass, 0 fail together); build, typecheck and lint each exit 0.
<!-- SECTION:FINAL_SUMMARY:END -->
