---
id: APRV-278
title: The ambient-bleed cross-instance finding fires on the documented start ritual
status: To Do
assignee: []
created_date: '2026-09-06 01:47'
labels:
  - doctor
  - env
  - ux
dependencies: []
type: bug
ordinal: 205000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
approval up (and doctor) report "APPROVAL_SAMPLING_SECRET is exported in this environment, so <home>'s own line N was not consulted: the value in use is not the one this instance configured" whenever the variable is set in the shell and .approval/env carries a line for it (src/core/instance.ts findingsFor, kind ambient-bleed). The rule is name-only and reads no values (APRV-178, deliberately), so it cannot distinguish a value bled from another instance from one exported a moment earlier by this instance's own `eval "$(approval env)"`, which is the ritual docs/dogfood-cutover.md and the up preflight text prescribe. Seen 2026-09-06: unset the variable, ran eval then up in the primary, and the finding printed anyway, claiming the value in use is not this instance's. The claim is false on that path and the wording asserts a fact the rule did not check. Options: have `approval env` mark what it exported (a sidecar variable naming the instance id and the file mtime it resolved from), so up can tell its own export from a foreign one; or soften the wording to what is known ("was exported before this process started; the file line was not consulted") and drop the "not the one this instance configured" clause.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After `eval "$(approval env)"` in the primary followed by `approval up`, no cross-instance finding is printed for a variable the eval itself exported from this instance's own file
- [ ] #2 A variable exported from a shell profile or another instance's env still produces the finding, with wording that states only what the rule verified
- [ ] #3 Test coverage for both cases in tests/instance or tests/cli-up, with no value ever read or printed
<!-- AC:END -->
