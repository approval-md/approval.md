---
id: APRV-209
title: >-
  A dedicated hook entry point: the harness hook stops paying the whole CLI
  module graph on every call
status: Done
assignee:
  - 'agent:opus-lane-x'
created_date: '2026-09-02 08:06'
updated_date: '2026-09-02 20:30'
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
- [x] #1 A cold pass-through hook invocation (read.shell on a 10k fixture log) loads at most the modules the hook needs, measured by a test that asserts the MCP SDK, better-sqlite3 and the channel modules are not in the loaded module list
- [x] #2 Before and after timings for cold pass-through and cold gated invocations on 1k and 10k fixture logs are recorded in the notes; the pass-through case improves by at least 50 ms on a quiet machine
- [x] #3 Every hook test and both hook docs guards pass unchanged; the verdict JSON and exit codes are byte-identical for every fixture
- [x] #4 If the settings.json command string must change, the exact new entry is drafted in the notes and docs/claude-code-hook.md describes both forms
- [x] #5 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Merge origin/main into aprv-209-hook-entry; confirm build.
2. Measure the BEFORE graph and latency: a loader-hook probe over a cold `hook claude-code` pass-through, and cold pass-through/gated medians on 1k and 10k fixture logs built through the real append path.
3. Implement the lazily-importing main: every case in src/cli/main.ts's switch reaches its verb through `await import()`, and core/verify.ts and core/reindex.ts are reached the same way from the log verbs. main() becomes async; cli.js, the direct-execution footer, src/mcp/server.ts's default arm and the seven in-process test helpers follow. No new bin, so the .claude/settings.json command string is unchanged.
4. Add tests/hook-module-graph.test.ts: a cold pass-through against a 10k fixture log loads neither the MCP SDK, better-sqlite3, nor src/channels/.
5. Re-measure INTERLEAVED against a rebuilt pre-change CLI, because the box is not quiet and two runs minutes apart differ by more than the effect.
6. Run every hook suite and both hook docs guards, then the full matrix and oxlint.
<!-- SECTION:PLAN:END -->

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

## Session 2: implemented

### What was done

`src/cli/main.ts` no longer statically imports a single verb. Every `case` in
the dispatch reaches its command function through `await import()`, and the two
core modules the log verbs need (`core/verify.ts`, `core/reindex.ts`) are
reached the same way from `commandVerify`, `readForOutput` and
`commandReindex`. What is still imported at the top of the file is the preamble
every verb needs before dispatch: argument parsing, path resolution, the help
text, styling, the exit-code table.

ESM has no synchronous dynamic import, so `main()` returns a promise. The ten
call sites APRV-188 predicted all followed: `cli.js`, the direct-execution
footer at the bottom of main.ts, `src/mcp/server.ts`'s default invoke arm, and
the seven in-process test helpers (anomalies, audit, autonomy-split, cli-help,
cli-long-help, retro-rate, sealed-delivery). Their `runCli`/`capture` helpers
became async and their callers await; `cli-long-help.ts`'s `withColour` also
became async, awaiting inside the `try` so its `finally` cannot put FORCE_COLOR
back while the verb is still deciding its palette.

### Decisions

1. **A lazily-importing main, not a second bin.** The `.claude/settings.json`
   command string is unchanged (see AC #4 below), and `tests/cli-hook.test.ts`
   spawns `dist/src/cli/main.js` directly, so a fast path in the `cli.js` shim
   would not have been exercised by the hook suite at all.
2. **Every verb, not only `hook`.** A hook-only fast path would have been a
   second dispatch to keep in step with the first. One dispatch, thirty lazy
   arms, and the gain reaches `log verify` and `queue` as well.
3. **An internal throw stays uncaught.** The footer sets `process.exitCode` from
   the resolved code and deliberately does not catch the rejection: a throw out
   of the dispatch was an uncaught exception (stack, exit 1) before this task,
   and reporting it as one of the frozen exit codes would make a CLI bug
   indistinguishable from a filesystem problem.

### AC #2 — before/after timings

The box was NOT quiet (a shared fleet machine; two identical runs twenty minutes
apart differed by more than the effect being measured, 540 ms then 1350 ms for
the same pass-through). The numbers below are therefore INTERLEAVED A/B: each
repetition spawns the pre-change CLI and the post-change CLI back to back
against the same fixture, 21 pairs, medians reported. The pre-change CLI is the
same source tree with only `src/cli/main.ts` and `src/mcp/server.ts` rolled back
to afde0af and rebuilt to a separate outDir. Both arms produced identical
verdicts on every case, which is what makes the pair comparable.

Fixture logs are built through the real append path (policy attested through
`approval policy attest`, filler through `core/log.ts`'s `appendEvent`).
Pass-through = `cat README.md` (read.shell, autonomous). Gated = `git push
origin main` (vcs.push.main, supervised: the full gate path, register through
the execution records, with no decision wait to measure instead of it).

| case | log | before | after | delta |
| --- | --- | --- | --- | --- |
| pass-through | 1k | 903.0 ms | 798.5 ms | **-104.4 ms** |
| pass-through | 10k | 1619.3 ms | 1487.3 ms | **-132.0 ms** |
| gated | 1k | 1462.7 ms | 1387.7 ms | -74.9 ms |
| gated | 10k | 1976.0 ms | 1954.1 ms | -21.8 ms |

The pass-through case improves by more than the 50 ms the criterion asks for at
both log sizes. The absolute values are inflated by roughly 2-3x against
APRV-188's quiet-machine numbers (371 ms cold gated at 10k); the DELTA is the
claim, and the delta is what interleaving protects. The gated cases move less
because the gate's own work (verified read, budget arithmetic, two appends under
the lock) grows with the log and swamps a fixed 100 ms of module loading.

Module count on a cold pass-through, measured with an ESM loader hook: 133
modules before, and the three named families gone after (see AC #1).

### AC #4 — the settings.json entry does NOT change

No new bin and no new verb: the hook is still `approval hook claude-code`, and
`docs/claude-code-hook.md` needs no edit. The entry the human committed stands
as it is:

    "command": "approval hook claude-code --dir <primary checkout> --as agent:claude-code --timeout 9m"

Since there is only one form, the criterion's "describes both forms" has nothing
to describe.

### Global invariants touched

None weakened. This is a module-loading change: no policy resolution, gate
check, timestamp source, append path or refusal shape moved. `core/gate.ts`,
`core/policy-match.ts` and `src/cli/hook.ts` are untouched, and the hook
suites (88 + 31 cases) pass with the same verdicts and exit codes.

## Validation

- `npm test`: 2988 tests, 2987 pass, 0 fail (one skipped), exit 0.
- `npx oxlint`: clean.
- Hook suites specifically: cli-hook (88), cli-hook-cursor + cli-hook-rewrite +
  cli-hook-scope (31), plus the two docs guards (the rule/deny-code table in
  cli-hook.test.ts and the classifier table in command-class.test.ts). All pass
  with unchanged verdicts and exit codes, and the interleaved A/B produced
  identical verdict objects from the pre- and post-change CLIs on every case.
- New: tests/hook-module-graph.test.ts (AC #1).

### Two regressions the async main() introduced, both caught and fixed

1. **Dropped exit codes.** The arms that unwrapped a verb's promise set
   `process.exitCode` and returned EXIT_OK. With an async main the entry
   point's own assignment could land AFTER the verb's, overwriting a usage
   error with a zero: `approval setup adapter agentmail` and the mcp http flag
   refusals exited 0 instead of 2. Fixed by a `settle` helper that awaits the
   outcome and returns the code, keeping every rejection message and EXIT_IO
   verbatim. The long-lived verbs (channel listen, daemon run, up, mcp serve)
   now keep main()'s promise pending while they run.
2. **A guard that read the signature.** tests/cli-instructions.test.ts locates
   main() in the source by a literal string to read the switch labels; the
   literal said `export function main(`, so the guard failed on its own
   precondition. It matches the signature with or without `async` now.

Both are worth knowing for review: neither is visible in the hook suites, and
the first is exactly the class of bug a mechanical async conversion produces.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Every CLI verb loads on demand through await import(); main() is async and a settle helper returns each verb's exit code (fixing a race that let a usage error exit 0). Cold pass-through hook 903 to 799 ms at 1k records and 1619 to 1487 ms at 10k (interleaved A/B, 21 pairs, loaded box); better-sqlite3 and the channel modules no longer load; verdict JSON and exit codes byte-identical on every hook fixture; settings.json entry unchanged. Verified by tests/hook-module-graph.test.ts, full suite 2987 pass, lint clean; merged in PR #239.
<!-- SECTION:FINAL_SUMMARY:END -->
