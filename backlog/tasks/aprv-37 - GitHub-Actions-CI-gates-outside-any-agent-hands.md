---
id: APRV-37
title: 'GitHub Actions CI: gates outside any agent hands'
status: To Do
assignee: []
created_date: '2026-08-05 14:01'
labels: []
milestone: m-6
dependencies:
  - APRV-36
priority: high
type: chore
ordinal: 37000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Human addendum (2026-08-10), landing before M5 implementation. Rationale verbatim: today the gates run only in the sessions of the agents whose work they check, so verification is executed by the examined party; an executor outside any agent's hands closes that. Scope: a workflow running install, build, full test suite, lint, and typecheck on every push and pull request to any branch, from a clean checkout, Node 20 and 22 matrix; the APRV-36 tiering applies as a separate fast doc-guard job, with the full job always running on main and on any non-light diff; no secrets in any workflow file (the suite needs no credentials by design; a check asserts workflow files reference none); README badge once green. The human flips branch protection on main to require the full job once confirmed green (repository settings are theirs).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A workflow runs install, build, full tests, lint, typecheck from a clean checkout on every push and PR to any branch, Node 20 and 22 matrix
- [ ] #2 The tier classifier gates a separate fast doc-guard job; the full job runs unconditionally on main and on any non-light diff, with classification computed in CI, never asserted by the author
- [ ] #3 No workflow file references any secret; a repo test asserts workflow files contain no secrets references
- [ ] #4 README carries the CI badge once the workflow is green on main; the human is flagged to flip branch protection
<!-- AC:END -->
