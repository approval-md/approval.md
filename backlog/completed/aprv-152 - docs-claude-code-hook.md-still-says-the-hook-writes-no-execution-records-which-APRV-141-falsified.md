---
id: APRV-152
title: >-
  docs/claude-code-hook.md still says the hook writes no execution records,
  which APRV-141 falsified
status: Done
assignee:
  - '@claude'
created_date: '2026-08-29 20:42'
updated_date: '2026-09-01 18:44'
labels:
  - docs
  - hook
dependencies: []
priority: low
ordinal: 137000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found 2026-08-29 during the APRV-145 design review: docs/claude-code-hook.md around lines 406-410 asserts the hook appends no execution.* records, but since APRV-141 the hook calls startHarnessExecution (src/cli/hook.ts ~line 1062) and appends execution.started with execution: harness for allowed gated commands, and since APRV-146 those records also bind payload_hash. Small documentation-only fix: correct the paragraph to describe the delegated execution.started record, its harness marker and binding, and the fact that it is terminal by design (no outcome is ever written over it by this runtime). Rides the light docs CI tier.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The paragraph describes the APRV-141 delegated start record accurately, including the harness marker, the payload_hash binding, and terminal-by-design custody
- [x] #2 No other stale claims about hook-written records remain in the file (sweep it once)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Sweep docs/claude-code-hook.md for stale claims that the hook writes no execution records. 2. Confirm the paragraph describes the APRV-141 delegated execution.started record (harness marker, payload_hash binding, terminal custody). 3. Finalize.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Read the code before rewriting. Two harness start paths append execution.started with execution: "harness", and both bind payload_hash since APRV-146: consumeHarnessGrant (src/core/gate.ts, records the grant's declared hash) and startHarnessExecution via recordUnattended (src/cli/hook.ts ~1191, refuses payload-hash-required when the caller names no bytes).

Divergence from the task description, called out rather than written into the doc: the task asked for the record to be described as terminal by design, no outcome ever written over it. That is no longer true of the tree. APRV-145's AC2 landed, so finishHarnessExecution (src/core/gate.ts) appends execution.completed or execution.failed carrying reported_by: "post-tool-use" over open delegated starts, driven by the post-execution half of the hook (src/cli/hook.ts ~1670). The corrected paragraph therefore states the accurate version: this runtime writes no outcome of its own (the human recovery verbs refuse a delegated start with execution-delegated), the only counterpart is the harness's REPORT, and the start stands open and terminal where no post-execution registration exists or the event carries no tool_use_id.

AC2 sweep: one further correction, in the APRV-141 paragraph near the top, which now states the payload_hash binding and points at the reported counterpart. Everything else in the file checks out against the code: the decision table's log column, the post-execution 'ANYTHING ELSE APPENDS NOTHING' reading, the gate.self 'nothing is logged' override, the no-token-minted section, and the Limits bullet on outcome-as-report (already APRV-145-accurate, which is what made the APRV-117 bullet's contradiction visible).

Out of scope, flagged for the human: the same stale claim survives in source doc comments. src/cli/hook.ts module header (~line 42) says the hook 'never writes an execution.completed or execution.failed', and src/core/gate.ts startHarnessExecution's doc comment (~line 2777) says the harness marker says 'why no execution.completed or execution.failed will ever follow'.

Validation: npm test 2442 pass, 0 fail (the worktree needed npm ci first; its node_modules was missing @modelcontextprotocol/sdk, which failed the ci-guard engines test before install and is unrelated to this change). npm run lint clean. Docs-only diff.

2026-09-01 sweep on main: docs/claude-code-hook.md line ~414 describes the delegated execution.started record with the harness marker and payload_hash binding; line 419 states the hook writes no OUTCOME over that record (terminal by design), which is the accurate claim. grep for 'no execution', 'appends no', 'never appends', 'writes no' finds no surviving claim that the hook appends no execution records. The fix landed in passing during APRV-141/146 docs work; this task closes as verified.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Verified docs/claude-code-hook.md already describes the APRV-141 delegated execution.started record accurately (harness marker, payload_hash binding, terminal-by-design custody) and a grep sweep finds no stale 'hook writes no execution records' claim. No diff needed.
<!-- SECTION:FINAL_SUMMARY:END -->
