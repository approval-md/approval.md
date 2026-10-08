---
id: APRV-417
title: >-
  Test suite: scrub FORCE_COLOR that node --test injects when run from a
  terminal
status: Done
assignee:
  - '@claude-lane-d'
created_date: '2026-09-20 21:43'
updated_date: '2026-09-22 01:29'
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
- [x] #1 npm test passes from an interactive terminal and when piped, with the same failures either way
- [x] #2 Tests that set FORCE_COLOR on purpose (style, long-help) still pass
- [x] #3 The scrub lives in one place (run-tests.mjs or the shared spawn helper), not per test file
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Locate the injection: node --test sets FORCE_COLOR in the env of each test-FILE process when the runner's own stdout is a terminal, so deleting it from the env scripts/run-tests.mjs hands to node --test cannot reach it.
2. Confirm there is no shared spawn helper in tests/ (there is not; ~119 files spawn directly), so the one place has to be something every file process loads.
3. Add scripts/test-env-scrub.mjs deleting FORCE_COLOR and NO_COLOR from process.env, and pass it as --import ahead of --test in the runner's single spawnSync. node --test copies its own execArgv onto every file process, so one flag covers every file, present and future.
4. Confirm the deliberate cases keep working: style.test.ts passes env objects to a pure function and cli-long-help.test.ts sets process.env and the child env explicitly, so neither reads the ambient variable.
5. Reproduce and verify with FORCE_COLOR=1 in front of the runner, which is the same propagation a TTY causes, over the named failing suites; then the same run piped.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
WHERE THE VARIABLE ACTUALLY COMES FROM, which decides the whole shape of the fix. node --test does not merely pass FORCE_COLOR through; it SETS it in the environment of each test-file process when the runner's own stdout is a terminal, so that those processes colour their output. Deleting it from the environment run-tests.mjs hands to node --test therefore fixes nothing: the runner puts it back one level down. It has to be deleted INSIDE the file process, before the first test body.

THE ONE PLACE IS AN --import MODULE. There is no shared spawn helper to put it in: about 119 test files call spawn directly. scripts/test-env-scrub.mjs deletes FORCE_COLOR and NO_COLOR from process.env, and the runner's single spawnSync passes it as --import ahead of --test. node --test copies its own execArgv onto every file process it spawns, so one flag on one spawn covers every test file that exists or ever will, and nothing is scrubbed per file (AC3).

execArgv IS NOT INHERITED BY THE CLI CHILDREN, which is why this does not overreach. A process a test spawns with its own argument list does not get the --import. What changes for those children is only that the environment they are BUILT from no longer carries the variable, so a test that wants colour still sets it explicitly and still wins (AC2): style.test.ts passes env objects to a pure function and never reads the ambient one, cli-long-help.test.ts sets process.env around one case and passes FORCE_COLOR: '1' in the child env of another. Both untouched and both green.

NO_COLOR IS DELETED TOO, which the task allowed for and which is worth stating as its own reason. A developer who exports NO_COLOR would otherwise silently turn colour off inside the cases that assert colour, and those cases would then fail for a reason that is nowhere in the diff. Both variables belong to the terminal and no test may read either.

REPRODUCTION WITHOUT A TTY. FORCE_COLOR=1 in front of the runner reproduces the failure exactly, because the propagation path into the file processes is the same one a terminal triggers. Before the fix: FORCE_COLOR=1 node scripts/run-tests.mjs --only cli-style-render gave 21 tests, 17 pass, 4 fail. After: 21 pass, 0 fail. Over the whole named set (cli-status, cli-style-render, cli-token, cli, envelope-loss, style, cli-long-help, e2e-demo, e2e-email-demo): 195 tests, 195 pass, 0 fail forced, and 195 tests, 195 pass, 0 fail piped, exit 0 both ways. Same failures either way is AC1, and the set is empty in both.

THE GUARD IS IN tests/ci-guard.test.ts, next to the runner's other properties, and it has two halves because the mechanism has two ways to break silently. One reads the runner and asserts the flag is on the spawn ahead of --test and that the scrub still deletes both names. The other spawns node --import <scrub> --test over a generated test file with FORCE_COLOR=1 and NO_COLOR=1 in its environment and asserts that file sees neither: that half is about the RUNTIME assumption, that node --test carries execArgv onto file processes, which a Node upgrade could retire without any diff here.

GLOBAL INVARIANTS. None touched. Test-harness plumbing: no runtime module changed, no verdict, no log write.

SCOPE NOTE. The scrub reaches runs through scripts/run-tests.mjs, which is npm test and CI. A bare node --test dist/tests/x.test.js during development still inherits the developer's terminal, which is the same documented gap the harness-binary stub in the same runner already states in its header.

FULL-SUITE NUMBER for the record: npm test on Node 26.8.2 from this worktree is 5140 tests, 5134 pass, 5 fail, 1 skipped, exit 1, in 435 s. The five are tests/package-adapters (4) and tests/codex-package (1), all of them one environmental cause recorded in APRV-416's notes: both suites read <REPO_ROOT>/node_modules by path and this agent worktree has none of its own. None of the roughly twenty-five colour failures this task was filed on appears, and the forced run is identical to the piped one.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
node --test injects FORCE_COLOR into every test-file process when the runner's stdout is a terminal, and the tests handed it to the CLI children they spawn. scripts/test-env-scrub.mjs now deletes FORCE_COLOR and NO_COLOR, and scripts/run-tests.mjs passes it as --import ahead of --test, which node --test copies onto every file process: one place, every file. Verified by reproducing the injection with FORCE_COLOR=1 in front of the runner: cli-style-render went from 17/21 pass to 21/21, and the whole named set (cli-status, cli-style-render, cli-token, cli, envelope-loss, style, cli-long-help, e2e-demo, e2e-email-demo) is 195 tests, 195 pass, 0 fail both forced and piped, exit 0. tests/ci-guard.test.ts gained two guards: the flag is on the spawn, and a real node --test spawn proves a file process sees neither variable. ci-guard 33/33, build, typecheck and lint each exit 0.
<!-- SECTION:FINAL_SUMMARY:END -->
