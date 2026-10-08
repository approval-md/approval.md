---
id: APRV-172
title: 'Demo server: CORS for the approval.md/rsi page'
status: Done
assignee:
  - '@claude'
created_date: '2026-08-31 01:13'
updated_date: '2026-08-31 02:28'
labels:
  - demo
dependencies: []
ordinal: 151000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Approved plan: server.mjs answers Access-Control-Allow-Origin: https://approval.md (exact origin, never *) on GET /api/state, /api/task/:id, /api/tasks, /api/templates and POST /api/task, plus OPTIONS preflight for the POST. Header comment updated: CORS grants the site page read/submit reach; decision authority unchanged (there is none to grant). Other origins get no ACAO header.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Preflight and simple-request behavior verified by test or scripted probe; approval.md origin allowed on exactly the listed routes
- [x] #2 A non-approval.md origin receives no ACAO header; 404/405 behavior unchanged
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add exact-origin ACAO + OPTIONS preflight to server.mjs routes. 2. Probe allowed and disallowed origins. 3. Twin green.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built by the same subagent, commit 4ef3f43, reviewed by fable. server.mjs +87: exact-origin ACAO for https://approval.md on the four reads and POST /api/task, OPTIONS preflight (204, methods POST, headers content-type, max-age 600), Vary: Origin stamped on CORS-eligible routes regardless of origin for cache correctness (the one header non-site requests gain), Allow-Credentials deliberately absent and the header contract explains why CORS grants reach and nothing else. Probe script: 48/48 assertions incl. ACAO on the 429 throttle refusal, absent for evil.example and no-Origin, unchanged 404/405 semantics. Startup banner names the allowed origin; twin's banner assertions still match.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Exact-origin CORS so the approval.md/rsi page can read and submit; 48-assertion probe green, e2e twin green unedited, no decision authority exists to be granted and the header comment says so.
<!-- SECTION:FINAL_SUMMARY:END -->
