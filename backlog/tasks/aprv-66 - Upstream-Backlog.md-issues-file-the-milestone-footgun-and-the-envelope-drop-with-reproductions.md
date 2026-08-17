---
id: APRV-66
title: >-
  Upstream Backlog.md issues: file the milestone footgun and the envelope-drop
  with reproductions
status: To Do
assignee: []
created_date: '2026-08-17 16:17'
updated_date: '2026-08-17 16:17'
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
- [ ] #1 docs/upstream-backlog-issue.md carries both issues with pinned-version reproductions
- [ ] #2 Human has filed them and the URLs are recorded in this task
<!-- AC:END -->
