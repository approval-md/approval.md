---
id: APRV-87
title: 'MCP server: agent-facing verbs as tools over the CLI code paths'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-18 11:17'
updated_date: '2026-08-19 01:52'
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
- [x] #1 approval mcp serve speaks MCP over stdio; the tool list equals the registry filtered by human_only false, and every input schema equals the registry input schema (asserted)
- [x] #2 Each tool call runs the same core path as its CLI verb against a real temp log; refusals surface as structured tool errors with the CLI machine-readable code; log verify clean after every scenario; a human-only verb name sent as a tool call is rejected as unknown
- [x] #3 Server identity is agent-only and cannot be escalated by a tool call; appends serialize with a concurrent CLI process (test both writing)
- [x] #4 Tests drive a real server process over stdio with an in-test MCP client (the SDK client, or a minimal JSON-RPC harness); no network
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from main (SDK + registry present). 2. src/mcp/server.ts: McpServer over StdioServerTransport; tools = VERB_REGISTRY filtered human_only false, mapped to the same core/CLI functions; input schemas from the registry (zod-to-json or the SDK raw JSON-schema tool API); refusals as isError structured tool results carrying the CLI code. 3. approval mcp serve --as agent:<id> (agent-only, unescalatable); appends serialize via the lockfile. 4. Tests with the SDK Client over an in-process stdio pair against a real temp log. PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR #72. Low-level SDK Server + setRequestHandler(ListTools/CallTool) rather than McpServer.registerTool (Zod-only): the registry JSON Schemas publish VERBATIM with one transform (delete --as), asserted per tool; buildArgv enforces additionalProperties:false itself since the low-level path does not validate. 22 tools = registry filtered human_only false minus EXCLUDED_VERBS (consume internal; hook claude-code reads stdin which is the wire); a test asserts exclusions are non-human_only so the two mechanisms do not overlap. instructions IS a tool. Identity --as agent:<id> or APPROVAL_AGENT validated before the transport; human:/system: exit 2; --as refused as tool input (mcp-identity-fixed / mcp-unknown-property) AND the server actor appended last to argv. Serial executor; lockfile still serializes with concurrent CLI. Same functions main.ts dispatches to; refusals isError with the CLI code; exit in _meta; isError = payload.error present (wait timeout / status 1 / torn tail 3 are answers). commandRun gained an optional child-stdio param (inherit would hand the child the JSON-RPC wire; default unchanged). stdin (-) refused. No outputSchema (registry outputs additionalProperties:false vs additive live outputs). mcp serve itself human_only true (operator picks the identity). SDK APIs: Server, StdioServerTransport, ListTools/CallToolRequestSchema, McpError; tests: Client, InMemoryTransport pair, StdioClientTransport for one real child. Reviewer-weigh: wait blocks the loop for its timeout (serial; documented; post-v1 tasks/elicitation mapping is the fix). +21 tests, 1722.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Agent-only MCP server over stdio: 22 tools derived verbatim from the verb registry, human-only verbs absent by construction, unescalatable agent identity, same core paths, refusals as structured tool errors. PR #72.
<!-- SECTION:FINAL_SUMMARY:END -->
