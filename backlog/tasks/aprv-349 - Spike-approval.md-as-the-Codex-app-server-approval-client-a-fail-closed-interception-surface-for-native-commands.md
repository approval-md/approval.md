---
id: APRV-349
title: >-
  Spike: approval.md as the Codex app-server approval client, a fail-closed
  interception surface for native commands
status: To Do
assignee: []
created_date: '2026-09-17 01:25'
labels:
  - codex
  - spike
  - hook
dependencies: []
priority: high
ordinal: 266000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Codex can run under an approval policy where, before executing a command or applying a patch, it stops and asks its client for a decision over the app-server protocol (https://learn.chatgpt.com/docs/app-server); the harness waits for the answer and runs nothing until it arrives. If approval.md answers as that client, the interception is fail-closed by construction (no answer means no execution), which is exactly what the native hook lacks (APRV-311: no per-call cwd, no outcome, fails open). APRV-325 named this bridge as a candidate beside the constrained-session-plus-executor route and chose the executor without probing the bridge live; the broker (APRV-325.2, PR #406) and confinement (APRV-325.3) remain the mandatory-boundary answer, and this spike asks whether the app-server route can give native shell and patch the same class-and-policy gate Claude Code gets from its hook, so everyday Codex use is gated rather than confined. Bounded, isolated, read-only probes against the installed Codex CLI in scratch directories only: never the host ~/.codex, never the primary checkout, never a real credential. Questions to settle with evidence: (1) what the exec and patch approval requests carry (command bytes, cwd, patch content, call id) and whether they bind enough for the classifier and the guard; (2) what happens on client crash, disconnect, timeout and malformed reply (observed file effects and exit codes, reported as observed); (3) whether the model can answer its own approval or route around the client (native approval impersonation, APRV-325 AC3); (4) how a decision reaches the phone and the log from the client (register, request, wait, then answer), and what the per-call latency is; (5) whether the bridge composes with the read-only sandbox and the broker or replaces them for everyday sessions. Output is a design note under docs/ with the probe scripts under scripts/probes/, and a recommendation: adopt (with the follow-up tasks it needs), or decline with the failing evidence. Related: APRV-311, APRV-325, APRV-325.2, APRV-325.3, APRV-348.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Probe scripts under scripts/probes/ drive the installed Codex CLI in app-server mode against a scratch workspace and record, verbatim, the approval request payloads for one shell command and one patch, including whether cwd and a call id are present
- [ ] #2 Crash, disconnect, timeout and malformed-reply behaviour of the client side is observed and recorded with exit codes and file effects; a failure to block is reported as a failure, never as enforcement
- [ ] #3 A design note under docs/ answers the five questions in the description with the evidence, states what the bridge can and cannot bind, and ends in adopt or decline; adopt names the tasks that would follow
- [ ] #4 No host Codex configuration, credential, primary checkout or production policy is touched; every command the probe runs is one the classifier reads or one routed through approval run
<!-- AC:END -->
