---
id: APRV-428
title: wait on an unregistered task answers granted with no actions; it must refuse
status: To Do
assignee: []
created_date: '2026-09-22 01:27'
labels:
  - wait
  - gate
  - refusal
dependencies: []
priority: medium
ordinal: 328000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-22 through approval serve on a hosted tenant: POST /verb/wait with positionals [req-does-not-exist] and --json returned {ok:true, task: req-does-not-exist, status: granted, actions: []} in under a second. A wait for a task the log has never seen reads as a grant. Nothing downstream can consume it (there is no token and no action), so it mints no authority, but a caller that branches on status sees granted for a typo, and a harness shim that polls wait until granted would proceed on a request it never opened. SPEC section 11.1: ambiguity resolves to the stricter path; refusals are machine-readable and distinct. wait should refuse an unregistered task with the existing task-not-registered code (or a distinct wait-specific one), and a registered task with zero pending actions should say so as a distinct state rather than granted.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval wait <unknown-task> exits non-zero with a machine-readable refusal naming the task; through approval serve the body carries the same code
- [ ] #2 approval wait on a registered task whose actions are all already executed or none declared answers a distinct status, never granted
- [ ] #3 Existing wait tests for a genuinely granted request are unchanged; conformance refusal-union vectors regenerated if a code is added
<!-- AC:END -->
