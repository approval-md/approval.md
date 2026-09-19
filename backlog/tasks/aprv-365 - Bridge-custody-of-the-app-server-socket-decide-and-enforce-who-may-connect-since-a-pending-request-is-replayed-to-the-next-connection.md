---
id: APRV-365
title: >-
  Bridge custody of the app-server socket: decide and enforce who may connect,
  since a pending request is replayed to the next connection
status: Done
assignee:
  - '@claude'
created_date: '2026-09-18 01:30'
updated_date: '2026-09-19 16:38'
labels:
  - codex
  - bridge
dependencies:
  - APRV-361
priority: medium
ordinal: 282000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From docs/codex-app-server-bridge.md follow-up 5 (APRV-349). Source read at b0659c5: a disconnected client leaves the question pending and a reconnect replays it to whatever connects next. Observed 2026-09-18 on 0.155.0: a client crash ended the server process (exit 0), so the replay path was not exercised live; it stays a source claim. Until custody is settled the bridge claim is this client decided every question it was asked, which is narrower than every question was decided here. Decide the transport (stdio child owned by the bridge versus a socket others could reach), enforce it, and state the resulting claim in the design note and SPEC if it becomes a stated property.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The bridge starts the server as its own child over stdio, or documents and enforces the socket custody rule when it does not
- [x] #2 The design note states which claim the bridge makes and why
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
RULED AND IMPLEMENTED 2026-09-19 (orchestrator): option (a) plus the narrow half of (c). AC1 is satisfied by its first arm rather than its second: the bridge already starts the server as its own child over stdio, and what this task adds is the STATEMENT of that as the custody model, plus a claim scoped to what it makes true.

WHAT CHANGED. A custody section in the src/cli/codex-bridge.ts module header; follow-up 5 in docs/codex-app-server-bridge.md marked landed with the answer; a custody paragraph in the bridge section of docs/cli-reference.md; three lines in the verb help. The CLAIM moved everywhere it appears, from this client decided every question it was asked to this client decided every question this app-server child asked in this session.

WHY THE CLAIM IS SCOPED THAT WAY. Custody is the operating system: there is no socket, nothing binds a path, and no other process holds a descriptor to speak on, so within one run a pending question cannot reach another client because there is no other client. What that does NOT license is anything about a Codex started outside this arrangement, which is a different process with a different connection, the same limit docs/codex-activation.md states for the confined session. So the claim names the child and the session.

WHAT WAS DELIBERATELY NOT BUILT, on the ruling: no refusal of a server command that would attach to something already running. That needs a guess at another program command line, which this repository has no record of, and a check written against a guessed shape finds nothing while reporting that it looked. The doc and the header say the property is true and say where it stops holding, which is the honest form of an unenforced property.

The 2026-09-18 observation (a client crash ended the server process, exit 0) is consistent with stdio custody and is not evidence about a socket path, which was never exercised. It stays a source claim.

VALIDATION. build, typecheck and lint exit 0. codex-bridge, cli-help and docs-guard suites: 68 tests, 68 pass, exit 0. No schema change, no conformance change, no protected-path edit.

---

THE OPTIONS THIS RULING CHOSE FROM, recorded on main at 3a6d1ea before the ruling and kept here because the ruling is only legible next to them.

NOT STARTED as code by lane 6 (2026-09-19), and the reason is a design question the lane declines to settle on its own. What follows is the state of the facts and the options, so whoever rules can do it from here.

WHAT IS ALREADY TRUE IN THE CODE, and it is most of AC1. src/cli/codex-bridge.ts spawns the app-server itself, as its own child, with stdio pipes: driveSession calls spawn(plan.serverCommand, plan.serverArgs, {cwd, stdio: ["pipe","pipe","pipe"]}) and speaks JSON-RPC over that child stdin and stdout. There is no socket anywhere in the verb, nothing binds a path, and the default command is codex app-server. Nothing here retries or reconnects, and the module header says so: a bridge that reconnected would be answering questions a previous connection was asked.

SO THE OPEN QUESTION IS NOT WHICH TRANSPORT. It is WHAT THE VERB MAY CLAIM because of it, and whether that claim is enforced or merely true today.

OPTION (a) DOCUMENT THE PROPERTY AND STOP. Say in docs/codex-app-server-bridge.md that this verb owns the server process over stdio, that no other client can reach the connection while it runs, and that the replay hazard therefore cannot arise within one bridge run. Cheapest, and honest about what the code does. The cost: the property lives in prose, and a later patch that accepted a socket flag would silently break it.

OPTION (b) ENFORCE IT. Refuse a server command that would attach to a socket rather than start a child, and refuse the flag shape that could. That needs a rule for what an attaching invocation looks like, which is a guess about another program command line, and this repository has no record of one. It is the shape of guess APRV-379 and the item-shape reader in APRV-364 both warn about.

OPTION (c) WIDEN THE CLAIM, which is what the task title is really asking. Today the report and the doc say this client decided every question it was asked. With stdio custody established, the stronger claim every question this SESSION raised was decided here becomes available, but only if the preflight and the approval-policy pin hold too, and only for the session this process started. Whether to state the wider claim is a judgment about what the project is willing to assert, not a coding decision.

WHAT LANE 6 WOULD RECOMMEND IF ASKED: (a) plus the narrow half of (c). The code already has the property; write it down, state the claim as scoped to the session this process started and to the questions it was asked, and leave (b) unbuilt until somebody records what an attaching invocation looks like.

The 2026-09-18 observation that a client crash ended the server process (exit 0) is consistent with stdio custody and is NOT evidence about the socket path, which was never exercised. That stays a source claim, as the description says.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The custody question was already answered by the code and is now stated: the bridge starts the app-server as its own child over stdio, so there is no socket, nothing bound and no second client for a pending question to be replayed to. The report claim moved with it, from this client decided every question it was asked to this client decided every question this app-server child asked in this session, in the module header, both docs and the verb help. Enforcement against an attaching invocation was deliberately not built: it would be a guess at another program command line, and a check written against a guessed shape finds nothing while reporting that it looked. Verified by build, typecheck and lint at exit 0 and by the codex-bridge, cli-help and docs-guard suites at 68/68.
<!-- SECTION:FINAL_SUMMARY:END -->

