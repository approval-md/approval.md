---
id: APRV-315
title: Codex hook morning trust activation and Telegram verification
status: To Do
assignee: []
created_date: '2026-09-08 07:25'
labels: []
dependencies:
  - APRV-314
priority: high
type: task
ordinal: 233000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User-authorized overnight Codex integration. SPEC 6.3,7,9,10,11.1 bind. Isolated code/tests/delivery now; everyday activation and human decisions only in morning. No deployment, credentials, dependencies or production policy/log mutation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Carter reviews/trusts intended Codex hooks with rollback available.
- [ ] #2 Closed-gate Telegram rejection prevents harmless effect, approval permits it once.
- [ ] #3 Outcome log verifies and desktop coverage is observed; configuration alone is not completion.
<!-- AC:END -->
