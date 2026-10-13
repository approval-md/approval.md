---
id: APRV-509
title: >-
  Hermes execute_code inner-call probe: predict from v2026.9.24 source, then
  confirm live whether kernel tool calls fire pre_tool_call
status: In Progress
assignee:
  - '@claude-approval/L1-PROBE'
created_date: '2026-10-12 05:45'
updated_date: '2026-10-12 05:54'
labels:
  - hermes
  - probe
dependencies: []
priority: high
ordinal: 389000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Hermes execute_code runs agent Python in a kernel whose hermes_tools stubs call Hermes tools over an RPC socket. docs/hermes-hook.md "Still UNPROBED" item 1 says whether those inner calls re-fire pre_tool_call is the highest-risk unknown, and the Hermes adapter refuses execute_code (hook-hermes-execute-code-unbound) partly for that reason. This task records a file:line prediction from the fleet build (v2026.9.24 = 0.21.5) and a runbook for one live confirmation on a team test tenant, run by a human. Lane L1-PROBE of the claude-approval seat.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Prediction (hooked / not hooked / mixed) recorded with file:line evidence from v2026.9.24 for both paths (model tool call and execute_code RPC call), covering shell hooks, plugin hooks, envelope fields and fail_closed
- [x] #2 docs/hermes-hook.md Still UNPROBED item 1 carries a dated prediction note marked pending the live run
- [x] #3 A runbook for the live confirmation exists: exact commands, expected output per step, restore steps, a window under 15 minutes, and how to read yes or no from the hook shim log, the daemon log and state.db
- [x] #4 No production command is run by an agent; the live run is a human step
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Trace both dispatch paths in Hermes v2026.9.24 (model call; execute_code kernel -> RPC -> handle_function_call) with file:line. 2. Record the prediction, envelope, fail_closed, allowlist and child-env facts in the lane report (agentvillage private lanes-approval/APPROVAL-PROBE.md). 3. Add a dated prediction note to docs/hermes-hook.md Still UNPROBED item 1. 4. Write the human-run live runbook (backup, edit, restart, control, probe cell, evidence, restore, verify). 5. Live run by Carter on a team test tenant; then flip the doc note from prediction to observed.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done (lane L1-PROBE, 2026-10-12): prediction HOOKED. Kernel RPC calls reach model_tools.handle_function_call with skip_pre_tool_call_hook at its default False (tools/code_kernel.py:266-277, tools/code_execution_rpc.py:28-30), which fires _dispatch_pre_tool_call_hooks (model_tools.py:775-787), the same dispatcher the agent loop uses (agent/tool_executor.py:651-665) and the one shell hooks register into (agent/shell_hooks.py:171). Only 7 tools reachable (tools/code_execution_tool.py:42-44); MCP, plugin and send_message refused by the RPC allowlist before any hook (tools/code_execution_rpc.py:48-50). Inner envelope: session_id and extra.tool_call_id empty (code_kernel.py:277 passes only task_id). Prior evidence: approval-md-hosted failclosed-local case i_exec_rpc on the 0.21.5 image, 2026-10-01, saw the hook fire for an inner terminal. Kernel Python itself (subprocess, sockets, reads of ~/.hermes/.env) is never hooked, so the execute_code refusal stays. Runbook: removing only the execute_code matcher would trip the av-approval plugin backstop (hook-missing:execute_code blocks every gated tool), so the window also runs hermes plugins disable av-approval; both undone by restoring config.yaml from backup. Remaining: Carter's live run (runbook B2-B5 in the lane report) on a team test tenant he names; then update docs/hermes-hook.md item 1 from prediction to observed. Targeted checks: node scripts/run-tests.mjs --only setup-rename (exit 0, 2/2), --only backlog-fixtures (exit 0, 9/9); tsc exit 0.

AC evidence: #1 lane report Part A (A1-A4) with file:line for both paths, shell+plugin hooks, envelope fields, fail_closed; #2 docs/hermes-hook.md item 1 'Probe prediction, 2026-10-12 (APRV-509), pending the live run'; #3 lane report Part B (B2 pre-checks, B3 window with expected output per step, B4 restore, B5 verify, B6 yes/no/mixed reading for shim log, daemon log and state.db; two restarts, about 15 min); #4 the lane ran nothing on any box (no railway command issued). Status stays In Progress until the live run result is recorded.
<!-- SECTION:NOTES:END -->
