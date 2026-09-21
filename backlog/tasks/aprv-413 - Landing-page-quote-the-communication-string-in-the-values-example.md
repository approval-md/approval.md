---
id: APRV-413
title: 'Landing page: quote the communication string in the values example'
status: Done
assignee:
  - '@claude'
created_date: '2026-09-20 20:35'
updated_date: '2026-09-20 20:36'
labels: []
dependencies: []
ordinal: 319000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The landing page terminal shows the yaml approval-values example with an unquoted communication scalar while APPROVAL.md quotes it. Both parse, but the quoted form is the safe habit for a sentence scalar (colons and hashes) and the page should model it. llms-full.txt no longer carries the block, so it is one line in index.html.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The communication line in the index.html values example is a quoted YAML string
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Quote the communication value in the term-ghost pre in index.html. 2. Validate the sample block with the values loader against a scratch file.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Validated: the page sample block, extracted to a scratch file, prints cleanly through approval values --policy with the quoted communication scalar. llms-full.txt no longer carries the block, so index.html is the only edit.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Quoted the communication string in the landing page values example so it matches APPROVAL.md; verified with the values loader.
<!-- SECTION:FINAL_SUMMARY:END -->
