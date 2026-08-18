---
id: APRV-88
title: >-
  M8 end-to-end demo: an MCP client (Claude Code) requests approval, the phone
  grants, the tool call proceeds
status: To Do
assignee: []
created_date: '2026-08-18 11:17'
labels: []
milestone: m-11
dependencies:
  - APRV-87
priority: medium
type: feature
ordinal: 83000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The M8 exit criterion, mirroring APRV-27/70: prove the wrapper against a real MCP client. Scripted half: an in-test client walks register_task -> request_approval -> (Telegram mock approve) -> wait_decision returns granted -> run_gated executes echo through the same token path, asserted hop by hop against the log; plus a manual runbook (examples/mcp-demo.md): register the server in a Claude Code (or any MCP client) config with --as agent:<id>, ask the agent to request an approval, tap Approve on the phone, watch the tool call unblock. The human runs it once and records the seq range. Docs: SPEC 10.5 amendment stating what shipped (stdio, agent-only tool surface, derived from the registry, human-only verbs absent by design) drafted for sign-off; README gains the one-paragraph MCP mention with the agent-only rationale.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Scripted client walk passes in CI against the mock Bot API; every hop asserted against the log; log verify clean
- [ ] #2 examples/mcp-demo.md exists; the human has run it once against a real MCP client and phone; seq range recorded here
- [ ] #3 SPEC 10.5 amendment and README paragraph drafted (flagged)
<!-- AC:END -->
