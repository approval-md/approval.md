---
id: APRV-417
title: >-
  Test suite: scrub FORCE_COLOR that node --test injects when run from a
  terminal
status: To Do
assignee: []
created_date: '2026-09-20 21:43'
labels: []
dependencies: []
references:
  - src/cli/style.ts
  - scripts/run-tests.mjs
ordinal: 321000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Running npm test in an interactive terminal fails roughly 25 tests (cli-status, cli-style-render, cli-token, cli.test log tail and verify, envelope-loss, and every e2e demo with "no execution token on the listener stdout") because the CLI output carries ANSI escapes where the tests expect plain text. Cause: when the parent stdout is a TTY, Node test runner sets FORCE_COLOR in the environment of each test-file process so reporters render colour; the CLI children the tests spawn inherit it, and src/cli/style.ts ranks FORCE_COLOR above NO_COLOR and above a piped stdout by design (APRV-102). CI and piped runs never see it, which is why the suite is green there and red on a developer laptop. Nothing in tests/ or scripts/run-tests.mjs scrubs the variable today. Fix in the runner or the shared spawn helper: delete FORCE_COLOR (and NO_COLOR where a test sets colour expectations itself) from the env handed to spawned CLI processes, so a test pins the CLI behaviour and not the terminal it was launched from. tests/style.test.ts and tests/cli-long-help.test.ts set FORCE_COLOR deliberately and must keep working.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 npm test passes from an interactive terminal and when piped, with the same failures either way
- [ ] #2 Tests that set FORCE_COLOR on purpose (style, long-help) still pass
- [ ] #3 The scrub lives in one place (run-tests.mjs or the shared spawn helper), not per test file
<!-- AC:END -->
