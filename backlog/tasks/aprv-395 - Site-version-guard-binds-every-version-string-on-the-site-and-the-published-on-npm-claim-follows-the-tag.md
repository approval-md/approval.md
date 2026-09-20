---
id: APRV-395
title: >-
  Site version guard binds every version string on the site, and the
  published-on-npm claim follows the tag
status: To Do
assignee: []
created_date: '2026-09-20 02:46'
updated_date: '2026-09-20 02:46'
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
- [ ] #1 tests/site-version-guard.test.ts binds all eight version strings, including the features footer, the #feature-index JSON version key, and llms-full.txt's two lines
- [ ] #2 The published-on-npm sentence in llms.txt is either keyed to the latest published tag or reworded to a claim that holds at bump time; the test asserts whichever was chosen, and the decision is recorded in the notes
- [ ] #3 A version bump that touches package.json alone fails the suite with a message naming every file still to move
<!-- AC:END -->
