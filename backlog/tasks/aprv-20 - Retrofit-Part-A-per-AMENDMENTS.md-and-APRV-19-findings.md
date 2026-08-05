---
id: APRV-20
title: Retrofit Part A per AMENDMENTS.md and APRV-19 findings
status: To Do
assignee: []
created_date: '2026-08-05 02:21'
labels: []
milestone: m-3.1
dependencies:
  - APRV-19
priority: high
type: feature
ordinal: 20000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Code retrofit per the human's AMENDMENTS.md Part A (NOTE: AMENDMENTS.md is not yet present in the repo as of task creation, 2026-08-07 — this task is additionally blocked on that file landing on main; the human's message also references the dangling-execution recovery verb "as specced" therein). Scope adjusted by APRV-19's blocker/should-fix findings. Includes: the approval execution resolve verb (the human-specced recovery verb for dangling executions), the dedicated refusal code for grant-on-classless-request, and the dedicated append-error code for attestation's actor refusal. Spec amendments accompany their implementing code same-commit per the standing rule.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 AMENDMENTS.md Part A items implemented per the file's text, scope adjusted by APRV-19 findings adopted into this task
- [ ] #2 The dangling-execution recovery verb lands as specced in AMENDMENTS.md, human-only, with frozen exit codes and --json shape
- [ ] #3 Dedicated refusal code for grant on a classless request replaces the fail-closed empty-string path, with tests
- [ ] #4 Dedicated append-error code for attestation's human-actor refusal replaces the reused validation code, with tests
- [ ] #5 All spec amendments tied to Part A land in the same commits as their implementing code
<!-- AC:END -->
