---
id: APRV-155
title: 'Web-agent demo: agent runner behind the MCP gate'
status: Done
assignee:
  - '@claude'
created_date: '2026-08-30 20:41'
updated_date: '2026-08-30 23:14'
labels: []
dependencies:
  - APRV-154
ordinal: 139000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The demo's subject is a real agent whose only side-effect path is the gate. Extends examples/web-agent-demo/server.mjs: POST /api/task enqueues an attendee task (curated templates plus one free-text slot, input capped ~500 chars, queue capped ~5, per-IP submit throttle); one claude -p child runs at a time with a generated --mcp-config pointing at 'node dist/src/cli/main.js mcp serve --as agent:demo --dir <demo-instance>' (config shape per examples/mcp-demo.md), --allowedTools 'mcp__approval__*', --disallowedTools Bash,Edit,Write, a --max-turns cap, and --output-format stream-json teed to a per-task transcript file served via GET /api/task/:id. The MCP wrapper exposes only agent-side verbs (no grant), so the agent structurally cannot approve itself; with the demo policy's sealed token_delivery (APRV-105), wait unblocks automatically after the phone grant.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 POST /api/task enqueues; at most one claude child runs at a time; queue length and input length caps are enforced with clear client errors
- [x] #2 Generated MCP config pins --as agent:demo and --dir to the demo instance; claude is spawned with Bash, Edit, and Write disallowed and a max-turns cap
- [x] #3 Per-task stream-json transcript is persisted and served via GET /api/task/:id; frontend shows live agent progress
- [x] #4 A task requiring a manual-class action visibly blocks in wait until a Telegram decision, then proceeds on grant (sealed token) or surfaces the rejection note in the transcript view
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read examples/mcp-demo.md and tests/e2e-mcp-demo.test.ts for the exact MCP config shape; read server.mjs's marked attach point and provisioning.md's sealed-token demo policy.
2. Extend server.mjs: in-memory FIFO (cap 5), input cap 500 chars, per-IP throttle; POST /api/task and GET /api/task/:id; curated templates + one free slot served to the page.
3. Spawn one claude -p child at a time with generated MCP config (--as agent:demo --dir instance), allowedTools mcp__approval__* only, disallowed Bash/Edit/Write, --max-turns cap, stream-json teed to tasks/<id>.jsonl under the demo dir.
4. Frontend: enable the task section, transcript polling view showing tool calls, wait-blocking state, grant/reject outcome.
5. Verify with a fake agent binary against a scratch instance (real append path); oxlint the file.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built by an Opus subagent, reviewed by fable (header contract + templates read in full; oxlint clean). Builder verification against a scratch instance with a fake stream-json agent (CLAUDE_BIN test seam): envelope seeding (server writes the task file + payload and hashes via the payload-hash read verb, since the agent runs with Write disallowed — the class is the operator's, never the agent's), env scrubbing proven from inside the child (APPROVAL_HUMAN/vault/telegram absent, CLAUDE_*/HOME/PATH present), transcripts 64-hex-shortened with --token flags rendered <sealed>, throttle 429 + retry-after, input caps 400/202 at the 500-char boundary, FIFO handoff across two client addresses, waiting-for-approval banner while a wait tool_use is unmatched, rejection note rendered then stop. Queue-full closed by fable post-hoc with a live 100s check: 1 running + 5 queued (positions 1-5) + 7th refused 429 'queue is full (5 waiting)' (scratchpad qfull-check.mjs, verdict PASS). AC4's gate semantics ride the mcp-demo e2e proof; the full phone-in-the-loop pass happens at rehearsal per the APRV-157 runbook. Free text is deliberately read-only (no class invented on an attendee's behalf); gated actions come only from curated templates.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
server.mjs gains the submission desk + agent runner: POST /api/task (curated templates + capped free text), FIFO concurrency 1 with queue cap 5 and per-address throttle, claude -p spawned behind the approval MCP wrapper (agent:demo, no Bash/Edit/Write, max 25 turns) with scrubbed env, stream-json teed verbatim to disk and served distilled with 64-hex runs shortened. Frontend renders live transcripts, gate calls in amber, and a waiting-for-approval banner. Verified end to end with a fake agent including a live queue-full pass; oxlint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
