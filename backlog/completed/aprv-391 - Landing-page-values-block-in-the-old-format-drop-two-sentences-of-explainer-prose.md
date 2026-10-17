---
id: APRV-391
title: >-
  Landing page: values block in the old format; drop two sentences of explainer
  prose
status: Done
assignee:
  - '@claude'
created_date: '2026-09-19 23:28'
updated_date: '2026-09-19 23:29'
labels: []
dependencies: []
type: docs
ordinal: 302000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The APPROVAL.md terminal on the landing page shows a yaml approval-values block in the first revision's shape (integer version 1, a wants list, a responds key). The current schema (SPEC 5.3, amended APRV-336) is version "0.2" quoted, love/like/dislike lists, and a communication string. Carter also asked to drop the caption under the terminal (the policy block is the only thing that changes what an agent may do; the values block widens nothing and narrows nothing) and the sentence Edit the file and it is inert until you attest again. llms-full.txt mirrors the page and follows.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The example values block on the landing page validates against the current schema shape: version "0.2", love, like, dislike, communication
- [x] #2 The caption under the terminal and the inert-until-you-attest sentence are gone from index.html and llms-full.txt
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Rewrite the values block in the terminal ghost to version "0.2", love/like/dislike, communication. 2. Delete the cap-note paragraph and its now-unused CSS rule; trim the attest sentence. 3. Mirror both in llms-full.txt. 4. Validate the sample block by running approval values --policy against a scratch copy.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Validation: the sample block, placed in a scratch policy file, prints cleanly through approval values --policy (loves/likes/dislikes/communication). The scratch file could not be named APPROVAL.md, the hook classes any file of that name policy.core. .cap-note CSS rule removed with its only user; llms-full.txt step 3 and 4 prose trimmed to match.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Landing page values example now matches the 0.2 schema (quoted version, love/like/dislike, communication); the caption under the terminal and the inert-until-attest sentence are gone from the page and its markdown mirror. Verified with the real values loader.
<!-- SECTION:FINAL_SUMMARY:END -->
