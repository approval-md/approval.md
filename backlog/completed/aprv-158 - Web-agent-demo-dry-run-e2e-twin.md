---
id: APRV-158
title: 'Web-agent demo: dry-run e2e twin'
status: Done
assignee:
  - '@claude'
created_date: '2026-08-30 20:44'
updated_date: '2026-08-30 23:44'
labels: []
dependencies:
  - APRV-155
ordinal: 142000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Every example in this repo has a test twin (pattern: tests/e2e-mcp-demo.test.ts); the web-agent demo gets one so the plumbing can be rehearsed in CI without Claude, a phone, or the network. tests/e2e-web-agent-demo.test.ts drives examples/web-agent-demo/server.mjs with a scripted fake agent binary standing in for claude -p and a mock Telegram Bot API, exercising submit -> request appended -> grant via mock -> sealed wait unblocks -> execution events -> /api/state reflects each hop. Test logs are built through the real append path (never fabricated), per the repo invariant.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Test spawns server.mjs configured with a fake agent binary and a mock Bot API, following the e2e-mcp-demo test pattern
- [x] #2 Asserts the full hop sequence: task submit, request event appended, mock grant, sealed wait unblock, execution events, and /api/state reflecting each stage
- [x] #3 Asserts the demo server itself appends nothing to the log (all appends come from the gate CLI invoked by the fake agent)
- [x] #4 Test passes in CI with no claude binary, no Telegram network access, and no vault secrets
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read tests/e2e-mcp-demo.test.ts pattern, server.mjs (throttle/queue constants), fake-agent approach from the builders.
2. Write tests/e2e-web-agent-demo.test.ts: fake agent binary + scratch instance via real append path; full hop assertions; server-appends-nothing assertion.
3. Add minimal documented env-override test seams to server.mjs only if runtime constants make the test slow (throttle/agent timeout).
4. npm test green.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built by an Opus subagent, reviewed by fable. tests/e2e-web-agent-demo.test.ts only; no server.mjs seams needed (CLAUDE_BIN sufficed; one submission avoids the throttle). One flat test with lettered hops per the sibling's Node-runner rationale. The fake agent is not a gate stub: it shells the real dist CLI as agent:demo and regex-parses the task file/action key/payload out of the server-generated prompt, so envelope or prompt drift breaks the test rather than passing it. Grant arrives via approval channel telegram listen against the shared tests/telegram-mock.ts under the human identity; the raw token is captured only from the listener stdout. Sealed unblock asserted by outcome plus a negative sweep (token appears in nothing served, printed, or logged — while the verbatim tasks/<id>.jsonl tee DOES carry it, pinning the header's local-only warning both ways). --only run: 1 pass in 14.7s; lint clean. Full suite in this worktree: 2401 pass, 1 pre-existing unrelated fail (ci-guard engines check ENOENTs because the worktree lacked node_modules — being fixed by npm ci, not by this change).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
tests/e2e-web-agent-demo.test.ts: the demo rehearsed without a model, phone, or network — server spawned as a real child, fake agent drives the real gate (register/request/wait/run through dist CLI as agent:demo), mock-Telegram grant under the human identity, sealed wait unblocks, and the sweep proves no token crossed the server. Server-appends-nothing pinned directly. Green via --only (14.7s) and inside the full run; lint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
