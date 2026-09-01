---
id: APRV-177
title: Demo agent child must not inherit the operator's personal Claude config
status: To Do
assignee: []
created_date: '2026-08-31 01:53'
labels:
  - demo
dependencies: []
ordinal: 156000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed during 2026-08-31 rehearsal (transcript demo-260831014516-002.jsonl): the claude -p child spawned by examples/web-agent-demo/server.mjs loaded the operator's full user-level configuration because HOME passes through the env filter — personal plugins (vercel, frontend-design), connected MCP servers (airtable, perplexity), user memory paths, and slash commands all appeared in the demo agent's session init. --allowedTools mcp__approval__* prevents silent use, but attendee-driven prompts should run in a session wired to nothing personal. Fix direction: spawn with CLAUDE_CONFIG_DIR pointed at a demo-owned config directory under the demo instance (so only the generated approval MCP config exists), and document the auth handoff for that isolated config dir (CLAUDE_CODE_OAUTH_TOKEN via claude setup-token passes the CLAUDE_* filter and needs no keychain). Also observed and fixed operationally the same night: keychain-based login does not reach the scrubbed child at all — 'Not logged in' authentication_failed — so setup-token is the documented path regardless; add it to the runbook preflight.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Agent child session init shows no operator plugins, no personal MCP servers, and no user memory paths (verified from the stream-json init line)
- [ ] #2 Runbook preflight documents claude setup-token + CLAUDE_CODE_OAUTH_TOKEN as the auth path for the demo server shell
- [ ] #3 read_the_gate template runs green under the isolated config
<!-- AC:END -->
