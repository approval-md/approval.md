---
id: APRV-174
title: 'mcp serve --http: streamable-HTTP transport with per-session identity'
status: To Do
assignee: []
created_date: '2026-08-31 01:16'
labels:
  - core
  - mcp
dependencies: []
ordinal: 153000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From the approved crowd-MCP design (2026-08-31). approval mcp serve gains --http [--port N, default 4681], binding 127.0.0.1 only (the operator fronts it with a tunnel; no TLS or auth in-process). src/cli/mcp.ts owns one node:http listener; per the SDK 1.30.0 model (already in the lockfile — StreamableHTTPServerTransport ships in it, no dependency change), each mcp-session-id gets its own Server + transport pair: on an initialize POST with no session header, build the pair via serveApprovalMcp and stash in a session map; route subsequent requests by header; delete on transport close. Caps: ~20 concurrent sessions, ~200 lifetime, refuse over-cap initializes with a plain HTTP 503 naming the reason. Under --guest (built here, restricted in the follow-up task) each session mints agent:guest-<6hex> via resolveAgentActor at session open, preserving the identity-settled-before-transport invariant verbatim; plain --http keeps the fixed --as/APPROVAL_AGENT actor for every session. src/mcp/server.ts changes only minimally: ServerOptions gains an optional shared serializer so all sessions share one invoke queue (default constructs a fresh one, keeping stdio behavior byte-identical); everything else already closes over per-instance options. The mcp-identity-fixed refusal stays true: the operator chose the scheme, callers still cannot name an identity.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Two concurrent HTTP sessions get distinct agent:guest-* actors whose appends land under their own actor in the log
- [ ] #2 Session routing by mcp-session-id, close-cleanup, loopback-only bind, and the 503 over-cap path are all tested
- [ ] #3 stdio path byte-identical: existing MCP tests pass unchanged
<!-- AC:END -->
