---
id: APRV-154
title: 'Web-agent demo: read-only status server and frontend'
status: Done
assignee:
  - '@claude'
created_date: '2026-08-30 20:39'
updated_date: '2026-08-30 21:46'
labels: []
dependencies: []
ordinal: 138000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Hackathon deliverable (RSI Harnesses hack): a publicly tunnelable web page giving attendees a live, safe window into the gate. The existing web channel (src/channels/web.ts, port 4680) is loopback-only by design and must never be tunneled; this demo needs a separate read-only surface. Lives under examples/web-agent-demo/ with zero src/ changes and zero new npm deps (node builtins only). server.mjs serves public/index.html and GET /api/state, which shells out to the built CLI against a --dir-scoped demo instance: approval queue --json, status --json, log tail -n 20 --json, log verify --json, with a ~2s cache so many browsers do not become a subprocess storm. The page renders the pending queue, log tail, and a verify badge (clean = green). The server holds no gate authority: no APPROVAL_HUMAN, no vault passphrase, no Telegram token in its environment, and no decision endpoints.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 server.mjs and public/index.html exist under examples/web-agent-demo/, using node builtins only (no new dependencies in package.json)
- [x] #2 GET /api/state aggregates queue/status/log tail/log verify --json output against a demo instance dir passed via flag or env, with a >=1s response cache
- [x] #3 Frontend polls /api/state and renders pending queue, recent log tail, and a log-verify badge that is green only when status is clean
- [x] #4 Server exposes no decision or grant endpoints and its code documents that it must run without APPROVAL_HUMAN, vault, or Telegram env vars
- [x] #5 Loopback web channel (port 4680) is never started by any demo code
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read the JSON output shapes of the four read verbs (src/cli/execute.ts commandQueue/commandStatus, log tail/verify handlers) rather than guessing fields.
2. Build examples/web-agent-demo/server.mjs on node:http: static serving for public/, GET /api/state shelling out to the built CLI (node dist/src/cli/main.js) with --dir from APPROVAL_DEMO_DIR env or --dir flag; aggregate queue/status/log-tail/log-verify JSON behind a ~2s in-memory cache; no decision endpoints; header comment stating the no-gate-authority env contract.
3. Build public/index.html: 2-3s polling of /api/state; render pending queue, log tail, verify badge (green only on clean); no external assets.
4. Smoke-test against a scratch instance built via approval init into the session scratchpad (real append path, never the repo log).
5. npm test + lint to confirm nothing regressed.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built by an Opus subagent, code-reviewed by fable. Verification (agent transcript): scratch instance in session scratchpad (init/attest/register/request through the real CLI; repo .approval/ untouched); curl /api/state showed all four sections with one pending request and clean verify at head seq 4; cache rollover observed at ~2s; route checks 200//404/405/traversal-404; browser render verified including degraded paths (torn-tail and error shapes drive the red badge). oxlint on the new file exits 0 (note: npm run lint covers src+tests only, so examples/ is outside the lint gate by existing convention). Discoveries: log tail/verify accept --log only (no --dir), so every verb is pinned to the instance log path explicitly; init does not create its target dir. Hardening beyond the brief: child processes get a scrubbed env (PATH+NO_COLOR), and the server warns at startup if APPROVAL_HUMAN/vault/Telegram vars are present. TTL renders h:mm:ss above one hour. One classifier data point: mkdir of a second scratch .approval/log dir classified policy.edit and was gated (request left to expire) — the corrupt-log render path was verified by driving the render functions directly instead.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
examples/web-agent-demo/server.mjs + public/index.html: read-only, zero-dependency status server (GET / and GET /api/state only) aggregating queue/status/log-tail/log-verify --json against a --dir-scoped demo instance with a 2s cache, plus a projector-legible page with a verify badge that is green only on clean. No decision endpoints, no gate credentials, loopback web channel never started. Verified against a live scratch instance end-to-end.
<!-- SECTION:FINAL_SUMMARY:END -->
