---
id: APRV-361
title: >-
  Codex app-server bridge: approval codex bridge starts codex app-server,
  answers each approval request through classify, register, request, wait and
  answer
status: Done
assignee:
  - '@claude'
created_date: '2026-09-18 01:29'
updated_date: '2026-09-19 12:57'
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
- [x] #1 approval codex bridge runs a turn against a scratch workspace with a stub server in tests and answers accept or decline only, never acceptForSession, cancel or abort
- [x] #2 Each exec approval request produces a classified, registered, requested action in the log and the reply is sent only after the verified view shows every key granted, or a decline after a policy refusal or deadline
- [x] #3 A request whose policy resolves human-only or whose classification is refused is answered decline with the refusal code recorded, never left pending
- [x] #4 The protocol vocabulary is taken from availableDecisions on each request; a request advertising none gets accept or decline and the choice is recorded
- [x] #5 docs/codex-app-server-bridge.md gains a usage section and docs/cli-reference.md a verb entry; conformance vectors pin the refusal union
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reuse, not fork: src/cli/hook.ts gateAndWait is split. Its body becomes gateHarnessCall, which returns a verdict object (allow with a reason, or deny with a code and a detail) instead of printing one, and gateAndWait becomes the printer around it. The bridge calls the same function with the same HookRun shape, so classify, register, request and wait have exactly one implementation.
2. New src/cli/codex-bridge.ts: the verb. Spawns the app-server (codex app-server by default, --server-command for the stub the tests drive), speaks the newline-delimited frames the probe recorded (no jsonrpc member, a reply is {id, result}), runs initialize, thread/start with approvalPolicy untrusted and a read-only sandbox, then turn/start.
3. Each item/commandExecution/requestApproval: classify {command, cwd} through classifyForHook with the request cwd, then gateHarnessCall with execution harness and the policy TTL as the deadline (the protocol has no timeout, so no harness ceiling applies). Reply {id, result: {decision}} in the vocabulary availableDecisions advertised, accept or decline only, never acceptForSession, cancel or abort. A request advertising nothing gets accept or decline and the choice is recorded.
4. A refused classification or a human-only class is answered decline at once with the refusal code recorded, never left pending. AC3.
5. item/fileChange/requestApproval is answered decline with its own code: the item-based request carries no content, and approving an identifier is not approving a change. The correlation is APRV-363.
6. docs/codex-app-server-bridge.md gains a usage section, docs/cli-reference.md a verb entry, and conformance vectors pin the refusal union. No SPEC edit: the SPEC 6.3 row is APRV-368.
7. Tests: a stub server in tests/ drives the five shapes (grant, deny, human-only class, no availableDecisions, file change). build, typecheck, lint, npm test, conformance.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Landed 2026-09-19 as two commits on lane/codex-bridge-361.

COMMIT 1, the reuse boundary. The task says the bridge reuses the hook flow and does not fork it, and the reusable unit turned out to be larger than gateAndWait: the human-only refusal, the unruled harness.launch refusal, the sandbox requirement, the loop floor, the unattended guard and the autonomous charge all sit between the classifier and the wait, and a bridge that skipped them would be a second gate. So src/cli/hook.ts now has decideHarnessCall, everything from the policy load to a verdict, returning HarnessVerdict instead of printing one; gateHarnessCall is the former gateAndWait, also returning a verdict; renderVerdict is the one place a verdict becomes bytes, which keeps the Codex guard inside allow (an allow that lost its exact bound tool_input.command is an I/O failure, not a permission) standing over every path. Mechanical and behaviour-preserving: no verdict text, no exit code and no appended record changed, and it is a separate commit at the orchestrator request so the enforcement-path refactor is reviewable apart from the new surface. Eleven hook suites, 271 tests, exit 0; conformance 379/379 on that commit alone.

COMMIT 2, the verb. The exec request becomes the hook own input: tool Bash, tool_input.command the string the server sent, cwd the directory the server named. Both fields come from the server, which is what makes them usable - a cwd the model reported would be a self-reported field reducing scrutiny (SPEC section 11.1 invariant 4).

DECISIONS THE DIFF DOES NOT SHOW.
(a) The deadline is the policy approval_ttl rather than a harness ceiling. Every hook adapter answers inside a timeout its harness sets, and the retry grace exists so a denial-by-deadline is recoverable; this transport has no timeout at all, so a human who answers in eleven minutes is answering rather than arriving too late. The retry grace is still passed, because a request that did lapse is still adoptable.
(b) The decision word is matched EXACTLY against availableDecisions and never by prefix. A prefix match would have sent acceptWithExecpolicyAmendment for an accept, which carries an amendment nobody approved. There is a unit case for exactly that.
(c) An OPEN GATE WINDOW is not honoured, deliberately. The hook bypass prints a hook verdict and appends a record shaped for the hook; wiring it into this transport is more surface than this task carries, and ignoring a window is the strict direction, since a window widens authority and this verb simply does not widen. Stated in the module header, in docs/codex-app-server-bridge.md and in docs/cli-reference.md rather than left implicit. An operator who opens a window will find this verb still asking.
(d) Questions are answered ONE AT A TIME, because the gate wait is synchronous. Frames queue while a decision is being made. That is the fail-closed direction and it matches the observed protocol, where a turn does not move past an unanswered question.
(e) A server request with no reading is declined (bridge-unknown-request) on the same rule the file change is: a question nobody classified is not one to answer yes to.
(f) The three bridge refusals are their own conformance union rather than members of hook_deny_codes. The hook cannot emit them - it is handed one event on stdin and has no transport to be asked an unreadable question over - and a second implementation reading them there would be told its hook must.

WHAT THIS IS NOT. An advisory checkpoint, never a boundary, exactly as APRV-349 recommendation says. The auto-reviewer can resolve a question before this client sees it (APRV-364), the approval policy and sandbox posture decide how many questions exist (APRV-366 makes the pin something the verb proves rather than requests), and a pending question is replayed to whatever connects next (APRV-365). The command is bound as the string that arrived; recording the re-parse beside it is APRV-362. None of those is done here and the docs say so.

SPEC section 11 invariants touched: none weakened. Enforcement reads only verified records (the wait is the hook own verified read); refusals are machine-readable and distinct (the new union); self-reported fields never reduce scrutiny (cwd and command come from the server, and reason and commandActions are never read into a decision); human-only classes stay inert to agents (a human-only class is declined at once with the gate own code and nothing is appended).

VERIFICATION. tests/codex-bridge.test.ts, 14 cases, against a stub app-server that waits for each reply before asking the next - which is what makes the ordering assertable at all. One case runs the bridge asynchronously, proves the stub received nothing while the question was open, grants from outside, then sees the accept and the spent grant. npm test 4705 tests, 4682 pass, 22 fail, exit 1: all 22 are the pre-existing Node v26 SMTP/email failures on this laptop, untouched. build, typecheck, lint clean; conformance 380/380 with refusal-unions at 14.0.0.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval codex bridge starts codex app-server and answers every approval request it raises through the policy and the log. The exec request carries command and cwd on one frame, which is the pair the native hook lacks and refuses for want of, so the bridge translates it into the hook own input and takes the decision from decideHarnessCall - the same classifier, human-only refusal, loop floor, register, request and wait. The reply is {id, result: {decision}}, accept or decline only, in the vocabulary the request advertised, never acceptForSession, cancel or abort. Verified by tests/codex-bridge.test.ts (14 cases against a stub that waits for each reply, including one that grants from outside mid-wait and proves the accept followed the grant), the eleven hook suites unchanged at 271 tests, and conformance 380/380 with the new bridge_refusal_codes union.
<!-- SECTION:FINAL_SUMMARY:END -->
