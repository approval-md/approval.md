---
id: APRV-322
title: Verified resumable event subscription for downstream decision listeners
status: To Do
assignee: []
created_date: '2026-09-08 22:51'
labels: []
dependencies: []
references:
  - 'https://github.com/approval-md/approval.md/issues/139'
priority: medium
type: feature
ordinal: 239000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
GitHub issue #139 requests a channel-independent decision stream for downstream refunds and queue updates. Research a runtime-owned log subscription with resume-from-sequence semantics and the same verified-chain guarantees as existing reads; never treat a filesystem notification or partial tail as an authorized event.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A documented subscription interface emits only verified events after the requested sequence and resumes without silently losing or duplicating the contractually defined stream.
- [ ] #2 Tests cover concurrent appends, torn or corrupt tails, restart/resume, cancellation and bounded resource use.
- [ ] #3 No event types, enforcement or credential semantics change without explicit design review; documentation names delivery guarantees and limitations.
<!-- AC:END -->
