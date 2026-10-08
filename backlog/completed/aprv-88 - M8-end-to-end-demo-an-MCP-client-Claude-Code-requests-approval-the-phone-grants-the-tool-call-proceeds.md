---
id: APRV-88
title: >-
  M8 end-to-end demo: an MCP client (Claude Code) requests approval, the phone
  grants, the tool call proceeds
status: Done
assignee:
  - '@fable'
created_date: '2026-08-18 11:17'
updated_date: '2026-08-20 12:17'
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
- [x] #1 Scripted client walk passes in CI against the mock Bot API; every hop asserted against the log; log verify clean
- [x] #2 examples/mcp-demo.md exists; the human has run it once against a real MCP client and phone; seq range recorded here
- [x] #3 SPEC 10.5 amendment and README paragraph drafted (flagged)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from aprv-87 branch. 2. tests/e2e-mcp-demo.test.ts: SDK client walks register -> request -> (mock Telegram approve) -> wait granted -> run echo through the token path, hop by hop against the log. 3. examples/mcp-demo.md: register the server in a Claude Code MCP config with --as agent:<id>, ask the agent to request approval, tap Approve, watch the tool call unblock; human runs once, records seq range. 4. SPEC 10.5 amendment (stdio, agent-only surface, registry-derived, human verbs absent) + README paragraph, flagged. PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Agent half merged (PR by branch aprv-88-mcp-e2e-demo, 1723 tests): scripted twin drives a real mcp serve child over stdio through register/request/listen/approve/wait/run/verify/replay/unknown-tool with a full secret sweep; examples/mcp-demo.md runbook; SPEC 10.5 amended to what shipped (flagged for sign-off); README harness section. FRICTION FOR THE HUMAN RUN: restarted listener invalidates prior buttons (nonce process-local; tap the newest message); --dir effectively mandatory under MCP clients (absolute paths); the token handover is manual and unavoidable on the MCP surface (nothing on it can fetch the token; POST-V1 CANDIDATE: a wait-that-returns-the-token-to-the-granted-agent design question); exec.local is autonomous by default so the demo policy tightens it; log tail -n is a string flag. AC 2 (human runs once against a real MCP client; seq range recorded here) remains.

AC 2 human run recorded (2026-08-20, human:carter): real Claude Code client against the primary checkout's live log, seq 84-90. 84 task.registered / 85 approval.requested (agent:claude-code, via MCP tools), 86 approval.granted (human:carter, Telegram tap; APRV-113 decided-prompt rewrite observed live), 89 execution.started / 90 execution.completed (echo hello, exit 0, payload hash matched the envelope). Seq 87-88 are an interleaved PreToolUse hook request (network.call) the demo session itself filed mid-run: the dogfood hook gating the very session running the demo. Policy path differed from the runbook usefully: exec.local is absent from the repo policy, so it fail-closed to defaults.autonomy manual with no policy edit and no re-attest. Tool surface eyeballed in /mcp: 23 tools, agent verbs present, grant/reject/revoke/policy_attest/vault_set absent. Chain verifies clean at head seq 90.

Correction: the interleaved hook records (seq 87-88) came from a separate competitor-research Claude Code session running in the repo concurrently, not from the demo session. The demo's own records are exactly 84-86 and 89-90.
<!-- SECTION:NOTES:END -->
