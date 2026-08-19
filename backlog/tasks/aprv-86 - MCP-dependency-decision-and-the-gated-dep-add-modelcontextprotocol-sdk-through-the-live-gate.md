---
id: APRV-86
title: >-
  MCP dependency decision and the gated dep-add: @modelcontextprotocol/sdk
  through the live gate
status: Done
assignee:
  - '@fable'
created_date: '2026-08-18 11:17'
updated_date: '2026-08-19 00:47'
labels: []
milestone: m-11
dependencies:
  - APRV-85
priority: high
type: chore
ordinal: 81000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The MCP wrapper (SPEC 10.5) needs a JSON-RPC/MCP transport. Two options: hand-roll stdio JSON-RPC + capability negotiation + tool listing (zero deps, but a protocol surface a thin wrapper should not own and one MCP clients do not test against), or take @modelcontextprotocol/sdk, the reference SDK every client is tested against. Recommendation: the SDK, justified per CLAUDE.md minimal-dependencies (each dependency justified in the task notes: this one is the protocol itself, not a convenience). This is a deps.add, MANUAL under this repo APPROVAL.md, and therefore the second real dogfood of the gate: the session writes the envelope on this task, registers, requests, waits; the human grants from the phone; approval run executes npm install @modelcontextprotocol/sdk (exact pin); the log advance is committed to main by the human. The task also records the license, the transitive dependency count and any native modules (there should be none), and the engines range against the Node 20 floor (the ci-guard engines test enforces it). Own task so the decision, the approval, and the install are one reviewable, logged unit before any wrapper code exists.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Decision recorded with the justification and the alternative considered; license, transitive count, native modules, and engines range against the Node 20 floor recorded
- [x] #2 The dep-add flows session -> gate -> phone -> grant -> approval run npm install (exact pin), recorded on the committed public log; log verify clean; ci-guard engines test green
- [x] #3 package.json/lock diff is the sole code change; no wrapper code in this task
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
HUMAN DECISION (2026-08-18): option (a), take @modelcontextprotocol/sdk. Facts gathered for the decision before asking: version 1.30.0, MIT, engines >=18 (floor 20 satisfied), 17 direct deps / 91 packages / 24 MB transitive (express, hono, cors, jose, zod, eventsource for HTTP transports a stdio server does not use), ZERO native modules. Fable recommended (b) hand-rolled stdio JSON-RPC given the footprint (M4/M7 precedent: SMTP and Telegram clients were zero-dep); the human chose (a) for protocol conformance and client compatibility. Recorded so the trade is auditable. Install rides through the gate: this task file carries the envelope; the session registers/requests against the primary log; the human grants from the phone; approval run executes npm install @modelcontextprotocol/sdk@1.30.0 (exact pin).

EXECUTED 2026-08-18, the third real dogfood of the gate. seq 18 task.registered, 19 approval.requested (deps.add -> manual; payload argv+cwd hash 839892a1...), 21 approval.granted by human:carter (via CLI, no channel field), 23 execution.started, 24 execution.completed exit 0 (npm install @modelcontextprotocol/sdk@1.30.0 --save-exact; package.json now pins 1.30.0), 25 the daemon drift record; log verify clean at 25; token-consumed afterwards. FIRST LIVE WRITE-BACK: the daemon (APRV-62) repaired this task file state: to executed on its own; the drift records at 20/22/25 are the documented drift-then-repair pair. ci-guard engines test green with the SDK engines >=18. Facts recorded: MIT, 91 packages / 24 MB transitive, zero native modules; the human chose the SDK over a hand-rolled stdio server for protocol conformance and client compatibility, with the footprint on record. Human commits package.json + lock + the log advance via a branch and PR (APRV-92 flow).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
@modelcontextprotocol/sdk 1.30.0 added through the live gate (seq 18-25), granted by the human, executed via approval run, log clean, engines guard green, write-back repaired the task file live. Decision and footprint recorded.
<!-- SECTION:FINAL_SUMMARY:END -->
