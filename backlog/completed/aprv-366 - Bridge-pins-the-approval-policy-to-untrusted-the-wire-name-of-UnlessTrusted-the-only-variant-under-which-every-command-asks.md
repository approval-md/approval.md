---
id: APRV-366
title: >-
  Bridge pins the approval policy to untrusted (the wire name of UnlessTrusted),
  the only variant under which every command asks
status: Done
assignee:
  - '@claude'
created_date: '2026-09-18 01:30'
updated_date: '2026-09-19 13:48'
labels:
  - codex
  - bridge
dependencies:
  - APRV-361
priority: high
ordinal: 283000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From docs/codex-app-server-bridge.md follow-up 6 (APRV-349). Observed 2026-09-18: thread/start with approvalPolicy unless-trusted is refused (enum untrusted, on-request, granular, never); with untrusted and a read-only sandbox every command and every patch in the run produced a question. An adoption that does not pin it gates an unknown fraction of the session. The bridge sends untrusted on thread/start, refuses to proceed if the server answers with a different effective policy, and records the accepted value in the session record.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 thread/start is sent with approvalPolicy untrusted and the accepted params are recorded
- [x] #2 A server refusing the value, or reporting another effective policy, stops the bridge with a distinct code
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/cli/codex-bridge.ts already SENDS approvalPolicy untrusted and sandbox read-only on thread/start (APRV-361 pinned the constant). What is missing is the proving half: nothing reads what the server answered, and a thread/start error is reported as prose with no machine-readable code.
2. Add BRIDGE_STOP_CODES, a second frozen array beside BRIDGE_REFUSAL_CODES and deliberately NOT a member of it: a stop ends the session before or instead of a turn, where every entry in the declines union is an answer to one approval request. The conformance union bridge_refusal_codes is documented as the second thing, so a stop code inside it would describe a different boundary (the reasoning the 14.0.0 note already gives for keeping these out of hook_deny_codes). Two codes: bridge-thread-start-refused (the server refused the request that carries the pin, error verbatim) and bridge-approval-policy-mismatch (it accepted and reported another effective policy).
3. Read the effective policy from a small documented set of locations on the thread/start RESULT and on the thread/started notification, through one helper. A server that names none is not stopped: AC2 says refusing or reporting ANOTHER policy, and the observed 0.155.0 server echoes nothing, so a client that demanded an echo could not run at all. The report says confirmed false in that case, which is the honest claim (requested and unconfirmed) rather than a silent pass.
4. Record the accepted thread params in the verb own report, under a thread key in --json and a line in the human output: cwd, approvalPolicy, sandbox, threadId, effective policy, confirmed. No new event and no schema change; the log records are the per-call ones the hook flow already appends, and minting a session event for this would be a schema task of its own.
5. Exit code stays EXIT_IO, as every other protocol stop in this verb, because the exit codes are frozen public API; the DISTINCT part AC2 asks for is the code in the report, which is what a caller branches on.
6. Stub (tests/fixtures/codex-app-server-stub.mjs) gains three additive env knobs: APPROVAL_STUB_THREAD_ERROR, APPROVAL_STUB_THREAD_RESULT and APPROVAL_STUB_THREAD_STARTED. Additive so every existing case behaves exactly as before.
7. Tests in tests/codex-bridge.test.ts: the wire carries untrusted and read-only and the report records them; a refused thread/start stops with its code, answers nothing and exits non-zero; a result reporting on-request stops with the mismatch code; the same reported on a thread/started notification stops mid-session; an echo of untrusted proceeds and reports confirmed.
8. Docs: follow-up 6 in docs/codex-app-server-bridge.md marked landed with what the bridge now proves and what it cannot, and the bridge section of docs/cli-reference.md names the pin and the two stop codes.
9. build, typecheck, lint, codex-bridge and hook suites; conformance only if a vector changes, which this task plans not to.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
DONE 2026-09-19 by lane 4, branch lane/bridge-policy-pin-366.

WHAT CHANGED. APRV-361 already SENT approvalPolicy untrusted and sandbox read-only; what was missing was the proving half. src/cli/codex-bridge.ts now reads what the server answered. A refused thread/start stops the run under bridge-thread-start-refused with the server error carried verbatim, which is where a refusal of the VALUE arrives (the probe saw unknown variant unless-trusted, expected one of untrusted, on-request, granular, never). A server that reports an effective approval policy of its own, on the thread/start result or on thread/started or thread/status/changed, stops the run under bridge-approval-policy-mismatch when it is not untrusted. The thread params the session was accepted under are recorded in the verb report, under a thread key in --json and a line in the human output.

DECISIONS. (a) The two stop codes are a SECOND frozen array, BRIDGE_STOP_CODES, deliberately disjoint from BRIDGE_REFUSAL_CODES and deliberately not in the bridge_refusal_codes conformance union: that union is documented as every way the bridge can DECLINE an approval request, and these end the session instead of answering one. That is the same reasoning the 14.0.0 vectors note gives for keeping the bridge codes out of hook_deny_codes. Conformance is therefore unchanged by this task; whether the stops earn a union of their own is a question for APRV-368, and a note now says so on that task. (b) A server that reports NO effective policy is run against rather than refused. AC2 names two cases, a refusal and a different policy, and the observed 0.155.0 server echoes nothing at all, so a client demanding an echo could not run against the server this verb exists for. The honest claim is recorded instead: confirmed false, with the value the server reported (none) beside the value requested. (c) The effective policy is read from a short list of named locations rather than by a generic walk like advertisedDecisions uses. This value can STOP a session, and a stray approvalPolicy nested in some unrelated structure must not be able to end a run; a unit case pins that a deep one is ignored. (d) The exit stays 4 for both stops, as for every other protocol stop in the verb, because the exit codes are frozen public API; the distinct part AC2 asks for is the code in the report. (e) There is still no flag for the pin: an operator who could pass on-request would have exactly the session the pin exists to prevent.

WHAT THE DIFF HIDES. The stub gained three additive env knobs (APPROVAL_STUB_THREAD_ERROR, _RESULT, _STARTED); unset, every existing case behaves as before, which is why no existing test changed. The human-readable report now always prints a thread line, including on a stop, so a run that never reached a question still says which pin it was refused over. APPROVAL_POLICY and SANDBOX are exported now, so the tests assert against the constants the code sends rather than against a literal typed twice.

INVARIANTS. Refusals are machine-readable and distinct (SPEC section 11.1 invariant 6): two new codes, each with its own repair, neither borrowing an existing one. Fail closed: a session whose policy is contradicted is stopped before any question is answered, and the tests assert nothing was appended to the log in that case. No self-reported field reduces scrutiny: the effective policy can only STOP a run, never widen one, so a server that lies about it can refuse itself service and nothing else. No schema change and no new event.

VERIFICATION. build, typecheck, lint clean. node --test dist/tests/codex-bridge.test.js: 21 tests, 21 pass, exit 0 (six new). cli-instructions 14/14 exit 0. npm test: 4715 tests, 4692 pass, 22 fail, exit 1, the same pre-existing Node v26 SMTP and email adapter failures; CI on Node 22 is the truth.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval codex bridge now proves the approval-policy pin instead of only requesting it. thread/start still carries approvalPolicy untrusted and sandbox read-only with no flag to override them, and the answer is read: a refused thread/start stops the run under bridge-thread-start-refused with the server own error verbatim, and a reported effective policy that is not untrusted stops it under bridge-approval-policy-mismatch, whether it arrives on the result or on a thread notification. The accepted thread params are recorded in the verb report, with confirmed false when the server echoed no policy at all, which is what the observed 0.155.0 server does. Verified by six new cases in tests/codex-bridge.test.ts driving the real CLI against the stub server: the recorded params, the confirmed echo, the refusal, the mismatch on the result, the mismatch on a notification, and the disjointness of the stop codes from the declines union; each stop appends nothing to the log.
<!-- SECTION:FINAL_SUMMARY:END -->
