---
id: APRV-209
title: >-
  A dedicated hook entry point: the harness hook stops paying the whole CLI
  module graph on every call
status: To Do
assignee: []
created_date: '2026-09-02 08:06'
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
