---
id: APRV-86
title: >-
  MCP dependency decision and the gated dep-add: @modelcontextprotocol/sdk
  through the live gate
status: To Do
assignee: []
created_date: '2026-08-18 11:17'
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
- [ ] #1 Decision recorded with the justification and the alternative considered; license, transitive count, native modules, and engines range against the Node 20 floor recorded
- [ ] #2 The dep-add flows session -> gate -> phone -> grant -> approval run npm install (exact pin), recorded on the committed public log; log verify clean; ci-guard engines test green
- [ ] #3 package.json/lock diff is the sole code change; no wrapper code in this task
<!-- AC:END -->
