---
id: APRV-496
title: >-
  docs/dogfood-cutover.md says a review reaction alone records OK; since
  APRV-482 (#614) a grade alone is refused verdict-required and held
status: To Do
assignee: []
created_date: '2026-10-05 15:40'
labels:
  - docs
  - review
dependencies: []
priority: medium
ordinal: 380000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
docs/dogfood-cutover.md, the review-card bullets near line 497, still says: "**One tap finishes it.** ✅ records 'a person looked and was content'. A reaction alone records OK and that grade." and, in the next bullet, that the grade buttons ❤️ and 👎 ask for a reply first so that nothing is appended until the reviewer answers. Since APRV-482 (PR #614, supervised-retro core) a grade alone is refused verdict-required: the card holds the grade, its heading says GRADE ... HELD, and the note for a loved or disliked grade is asked at the later verdict tap (docs/cli-reference.md, the review-card tap table, is already right). A resident following the cutover guide would tap a grade, see nothing recorded, and not know that a verdict is still owed. Found while closing out the PR #614 doc pass; the file was not in that PR's scope.

What it should say: a verdict (✅ or 🛑 twice) finishes the review; a reaction alone is held on the card and records nothing; ✅ after a reaction records OK with the held grade; a loved or disliked grade asks for words at the verdict tap, and nothing is appended until they arrive. Link to docs/cli-reference.md for the full table.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The One tap finishes it bullet and the following note-prompt bullet in docs/dogfood-cutover.md match the tap table in docs/cli-reference.md (a reaction alone records nothing and is held)
- [ ] #2 No other sentence in docs/dogfood-cutover.md describes a reaction recording a verdict (grep reaction and OK in the file, result in the notes)
- [ ] #3 docs-guard passes
<!-- AC:END -->
