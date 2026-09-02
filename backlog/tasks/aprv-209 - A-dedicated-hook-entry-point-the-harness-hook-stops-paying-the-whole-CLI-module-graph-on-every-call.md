---
id: APRV-209
title: >-
  A dedicated hook entry point: the harness hook stops paying the whole CLI
  module graph on every call
status: In Progress
assignee:
  - 'agent:opus-lane-x'
created_date: '2026-09-02 08:06'
updated_date: '2026-09-02 09:23'
labels:
  - performance
  - hook
dependencies: []
priority: high
ordinal: 172000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Measured by the APRV-188 lane on a quiet machine: a cold gated hook invocation is about 371 ms on a 10k-record log, and the largest term is 116 ms loading the CLI module graph, because src/cli/main.ts statically imports every verb (the MCP SDK, better-sqlite3, the channels); hook.js alone is 51 ms. That cost is log-size independent and is paid by every pass-through command a session runs, including reads that never touch the log. Outcome: the hook has its own entry point (a separate bin or a lazily-importing main) that loads only the classifier, policy load, log read and the gate path it needs, with the verbs imported on demand; the .claude/settings.json hook entry is unchanged in shape (the human commits that file; if the command string must change, draft it in the notes for the orchestrator). Why: hook latency is the felt cost of living behind the gate; a third of a second per command is what people turn off.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A cold pass-through hook invocation (read.shell on a 10k fixture log) loads at most the modules the hook needs, measured by a test that asserts the MCP SDK, better-sqlite3 and the channel modules are not in the loaded module list
- [ ] #2 Before and after timings for cold pass-through and cold gated invocations on 1k and 10k fixture logs are recorded in the notes; the pass-through case improves by at least 50 ms on a quiet machine
- [ ] #3 Every hook test and both hook docs guards pass unchanged; the verdict JSON and exit codes are byte-identical for every fixture
- [ ] #4 If the settings.json command string must change, the exact new entry is drafted in the notes and docs/claude-code-hook.md describes both forms
- [ ] #5 npm test passes; lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Session status (paused by the operator, fleet CPU pause)

STOPPED BEFORE ANY CODE OR MEASUREMENT RUN. No src/ or tests/ file was
touched; the only change in this commit is this task file (status In
Progress, assignee agent:opus-lane-x) plus this note.

### Done

- Base chosen: APRV-200 is NOT in origin/main (`git log --oneline
  origin/main | grep -c APRV-200` = 0), so this branch is
  `aprv-209-hook-entry` off `origin/aprv-200-grant-order` at 601241e
  ("Merge remote-tracking branch 'origin/main' into aprv-200-grant-order",
  which carries main a4bca2b). Note for the next lane: a first
  `checkout -B` landed on b5a876f, one commit short of the fetched tip,
  and at b5a876f the APRV-209 task file does not exist in the tree at all
  (`backlog task view` still answered, because backlog/config.yml has
  remote_operations: true and reads across remote branches, while
  `task edit` failed with "Task not found"). If a lane sees
  "Task not found" on a task it can view, it is on the wrong base.
- `npm ci` clean at that tip; `npm run build` (tsc) clean.
- Read: CLAUDE.md, backlog overview + task-execution, APRV-209 ACs,
  APRV-188 description and full notes, src/cli/main.ts, src/cli/hook.ts
  imports, cli.js, package.json, tests/layering.test.ts, and the
  invocation shape in tests/cli-hook.test.ts and the fixture builder in
  tests/telegram-tap-latency.test.ts.

### Findings that constrain the shape (carry these forward)

1. `tests/cli-hook.test.ts` line 57 spawns `dist/src/cli/main.js`
   directly (CLI_ENTRY), NOT cli.js. So a fast path implemented only in
   the cli.js bin shim would not be exercised by the existing hook suite
   and would not satisfy AC #1 as those tests are written. The laziness
   has to live in main.ts itself, or the new test must invoke the bin.
2. ESM has no synchronous dynamic import and dist is `"type": "module"`,
   so `createRequire` cannot lazily load the verbs either. Making
   main.js stop paying for the verb graph therefore forces
   `main()` to become async, exactly as APRV-188's out-of-scope note
   predicted.
3. Blast radius of an async main(), enumerated: cli.js line 26
   (`process.exitCode = main(...)` needs an await), the direct-execution
   footer at the bottom of src/cli/main.ts, src/mcp/server.ts:66, and
   seven in-process test importers (tests/anomalies, cli-help,
   autonomy-split, audit, cli-long-help, sealed-delivery, retro-rate).
   Eight call sites plus the two entry points.
4. The MCP SDK may already be lazy: tests/layering.test.ts pins that
   cli/mcp.ts reaches ../mcp/server.js through a DYNAMIC import (APRV-87),
   so the SDK is likely not in main's static graph today. The measurement
   must confirm which of the three named modules (MCP SDK,
   better-sqlite3, channels) are actually loaded, so AC #1's assertion
   list is not written against an assumption.
5. hook.ts imports `type { Streams } from "./main.js"` — type-only, so it
   erases and is not a runtime cycle back into the verb graph.
6. Byte-identical output (AC #3) depends on main()'s preamble, not just
   the verb: style is a MODULE-GLOBAL singleton (`resetStyle()` then
   `style({ json, noColor })`), and `--no-color` is stripped from argv
   before dispatch. Any fast path must replay that preamble exactly, and
   must not shortcut `longHelpRequest` / `--help` / `help hook --long`.

### Next steps, in order

1. MEASURE FIRST (not yet run): cold pass-through (read.shell) and cold
   gated hook invocations on 1k and 10k fixture logs, reusing the fixture
   builder in tests/telegram-tap-latency.test.ts, with the loaded-module
   list captured from process.moduleLoadList. Record before numbers here.
2. Write the plan on the task with `--plan` before coding.
3. Then implement, preferring the lazy async main (settings.json command
   string unchanged) over a dedicated approval-hook bin.

### Tests unrun

Everything. `npm test` has NOT been run in this worktree at any point,
per the operator's pause. `npm run build` is the only build/verify step
that ran, and it passed. Lint not run. No AC is ticked and none should be
until the measurement and the implementation land.
<!-- SECTION:NOTES:END -->
