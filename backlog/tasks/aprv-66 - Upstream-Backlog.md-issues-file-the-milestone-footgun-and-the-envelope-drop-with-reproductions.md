---
id: APRV-66
title: >-
  Upstream Backlog.md issues: file the milestone footgun and the envelope-drop
  with reproductions
status: In Progress
assignee:
  - '@fable'
created_date: '2026-08-17 16:17'
updated_date: '2026-08-17 19:06'
labels: []
milestone: m-8
dependencies:
  - APRV-65
priority: medium
type: chore
ordinal: 65000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
docs/upstream-backlog-issue.md drafts the --milestone silent-creation issue (MILESTONES.md footgun). APRV-60 adds a second: backlog task edit rewrites task files and drops frontmatter keys it does not own (our approval: envelope), which contradicts the plain-markdown convention SPEC principle 6 relies on. This task readies both for the human to file: exact reproduction commands against the pinned CLI version, expected vs observed, and a suggested direction (preserve unknown keys on rewrite; error on unknown --milestone). The human files them; agents never post to upstream (network.call is manual). Record the issue URLs back in this task when filed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 docs/upstream-backlog-issue.md carries both issues with pinned-version reproductions
- [ ] #2 Human has filed them and the URLs are recorded in this task
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Draft issue 2 (unknown-key drop) beside the existing milestone footgun draft, with an exact reproduction against 1.49.3 pointing at the committed fixture pair. 2. PR the docs. 3. HUMAN: file both issues upstream (github.com/MrLesk/Backlog.md), record the URLs here. Filing is a network.call, manual class; agents never post upstream.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Both drafts ready in docs/upstream-backlog-issue.md (PR #27). AC 1 satisfied on merge; AC 2 (filed, URLs recorded) is the human step and the reason this task stays open past M6 code completion.
<!-- SECTION:NOTES:END -->
