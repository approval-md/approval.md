---
id: APRV-87
title: 'MCP server: agent-facing verbs as tools over the CLI code paths'
status: To Do
assignee: []
created_date: '2026-08-18 11:17'
labels: []
milestone: m-11
dependencies:
  - APRV-86
priority: high
type: feature
ordinal: 82000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC 10.5: a thin MCP server exposing the same verbs as tools (request_approval, wait_decision, get_queue, ...) for clients where MCP is more ergonomic than shelling out; it shares the CLI code paths. approval mcp serve (stdio transport; the reference runtime is local-first). SCOPING DECISION, the most important one, follows from SPEC 11: the server is AGENT-FACING ONLY. Human-only verbs (grant/reject/revoke, policy attest/amend, vault, setup, audit review, expire, execution resolve) are NOT exposed as tools: an MCP client is an agent harness, and offering grant to it hands the untrusted policy the overseer pen. Tools = the agent surface: register_task, request_approval, wait_decision, get_queue, get_status, run_gated (approval run semantics), payload_hash, policy_test (explain), log_verify, plus read-only doctor if useful. Every tool description and input schema is DERIVED from the APRV-85 registry (one source; a test asserts the tool list equals the registry filtered by human_only false, and each input schema equals the registry input schema). Every tool call executes the same core function the CLI verb calls (no second implementation): map the CLI verb function or, where the CLI verb is only a thin wrapper, call core directly and reuse the CLI JSON shaping. Identity: the server runs AS an agent identity supplied at start (--as agent:<id> or APPROVAL_AGENT env, decide and document; never human:); a tool call cannot escalate it. Concurrency: tool calls serialize appends through the existing lockfile like any CLI process. Errors: refusals return as structured tool errors carrying the same machine-readable code the CLI would print (isError with the JSON refusal), never thrown. Elicitation/tasks extension mapping onto awaiting is OUT of scope (SPEC says MAY when client support stabilizes): document as post-v1.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval mcp serve speaks MCP over stdio; the tool list equals the registry filtered by human_only false, and every input schema equals the registry input schema (asserted)
- [ ] #2 Each tool call runs the same core path as its CLI verb against a real temp log; refusals surface as structured tool errors with the CLI machine-readable code; log verify clean after every scenario; a human-only verb name sent as a tool call is rejected as unknown
- [ ] #3 Server identity is agent-only and cannot be escalated by a tool call; appends serialize with a concurrent CLI process (test both writing)
- [ ] #4 Tests drive a real server process over stdio with an in-test MCP client (the SDK client, or a minimal JSON-RPC harness); no network
<!-- AC:END -->
