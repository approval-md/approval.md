---
id: APRV-361
title: >-
  Codex app-server bridge: approval codex bridge starts codex app-server,
  answers each approval request through classify, register, request, wait and
  answer
status: To Do
assignee: []
created_date: '2026-09-18 01:29'
labels:
  - codex
  - bridge
  - feature
dependencies: []
priority: high
ordinal: 278000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Adopt decision from APRV-349, confirmed by the 2026-09-18 probe (docs/codex-app-server-bridge.md, recommendation section): narrow adopt as the everyday gate for Codex sessions this runtime starts, never a boundary. The verb starts codex app-server, speaks the protocol as the approval client (initialize, thread/start with approvalPolicy untrusted and a read-only sandbox, turn/start), and puts every item/commandExecution/requestApproval through the same flow src/cli/hook.ts runs (classify the command against the policy with the request cwd, register with Codex provenance as a call option, one request per class with execution harness, wait on the verified view with the policy TTL as the deadline since the protocol has no timeout, then reply {id, result: {decision}} in the vocabulary the request advertised). It reuses the hook flow; it does not fork it. Observed facts to build on: exec requests carry command (shell-joined rendering), cwd, itemId, threadId, turnId and availableDecisions; the server announces resolution with serverRequest/resolved; a client crash ends the server on 0.155.0; a malformed reply is a denial. The other follow-ups from the note are separate tasks that depend on this one.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval codex bridge runs a turn against a scratch workspace with a stub server in tests and answers accept or decline only, never acceptForSession, cancel or abort
- [ ] #2 Each exec approval request produces a classified, registered, requested action in the log and the reply is sent only after the verified view shows every key granted, or a decline after a policy refusal or deadline
- [ ] #3 A request whose policy resolves human-only or whose classification is refused is answered decline with the refusal code recorded, never left pending
- [ ] #4 The protocol vocabulary is taken from availableDecisions on each request; a request advertising none gets accept or decline and the choice is recorded
- [ ] #5 docs/codex-app-server-bridge.md gains a usage section and docs/cli-reference.md a verb entry; conformance vectors pin the refusal union
<!-- AC:END -->
