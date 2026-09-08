---
id: APRV-323
title: Define explicit multi-approver and concurrent-decision semantics
status: To Do
assignee: []
created_date: '2026-09-08 22:51'
labels: []
dependencies:
  - APRV-249
references:
  - 'https://github.com/approval-md/approval.md/issues/138'
priority: medium
type: feature
ordinal: 240000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
GitHub issue #138 requests a stated first-decision default and optional per-policy multi-approver quorum. This is a security and schema design task before implementation. Establish distinct human identity, concurrent decisions, rejection/expiry/revocation behavior, token-mint timing and compatibility with the existing one-grant contract. Coordinate with APRV249 identity/receipts work.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A reviewed design states the current single-decision behavior and specifies quorum identity, denial, expiry, concurrency, budget and token rules without implying quorum already exists.
- [ ] #2 The design identifies required spec/schema changes and adversarial acceptance tests; current gate behavior remains unchanged until that design is authorized.
- [ ] #3 Issue #138 links to the durable task and remains open until the requested behavior is actually delivered.
<!-- AC:END -->
