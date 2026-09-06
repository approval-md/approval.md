---
id: APRV-271
title: >-
  doctor audit-sampling consults the running daemon before saying sampling is
  disabled
status: In Progress
assignee:
  - '@opus-doctor'
created_date: '2026-09-05 17:58'
updated_date: '2026-09-06 08:28'
labels: []
dependencies: []
priority: low
ordinal: 201000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
approval doctor reports audit-sampling as disabled (secret-unset) whenever the shell running doctor lacks APPROVAL_SAMPLING_SECRET, even while the daemon in another window has it exported and is sampling. Seen 2026-09-05: doctor red, daemon banner confirming the secret in use. Since APRV-208 the live draw is answered by the daemon over local IPC, so doctor can ask the daemon whether sampling is enabled and at what rates instead of inferring from its own environment. The row should say which process answered: "sampling enabled per the running daemon (pid, socket)" or, with no daemon reachable, the current wording plus "no daemon answered; the daemon shell decides". Read-only; no verdict changes; the secret value is never printed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 doctor audit-sampling asks the running daemon over the APRV-208 IPC for sampling state and reports it as the source when the daemon answers
- [x] #2 With no daemon reachable the row keeps its current meaning and adds that the daemon shell decides
- [x] #3 The secret value never appears in doctor output or --json; tests cover both branches with a fake daemon socket
- [x] #4 docs/cli-reference.md doctor section documents the row
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read src/core/live-draw.ts, src/daemon/draw.ts, src/daemon/draw-child.ts and doctor's checkSampling to learn the socket protocol and what the daemon already knows. 2. Extend the v1 socket protocol with a STATUS question: a line carrying query: sampling instead of an action, answered with the daemon's own resolveSampler state (enabled, machine-readable reason, the secret variable's NAME, the fallback rate, the live classes) plus its pid and answered_at. The secret value is never in the answer. An older daemon reads the line as a malformed draw and refuses, which the asker treats as no answer, so the change fails closed. 3. Add an async client, askDaemonSampling, beside the synchronous draw client: same socket-usable pre-checks (path length, existence, owner-only mode), one line out, one line in, connection closed, and the same pid-liveness check the draw answer gets. 4. In doctor, consult the daemon ONLY on the secret-unset branch: that is the one sampler reason which is a fact about a process environment rather than about the policy file, so it is the only one another process can legitimately answer for. Enabled per the daemon reports pass naming the pid and the socket; a daemon reporting itself disabled fails naming its reason; no daemon answered keeps the current wording and adds that the daemon shell decides. 5. Document the row in docs/cli-reference.md. 6. Tests in tests/cli-doctor.test.ts with a fake daemon socket on a short temp path: answered-enabled, answered-disabled, and no socket, plus an answer carrying a bogus secret field to prove doctor echoes no unknown field. 7. Build, run the doctor and long-help suites, lint, typecheck.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The v1 socket protocol gained a second question. A line carrying query: sampling instead of an action key is answered with the daemon's own resolveSampler state: enabled, the machine-readable disabled reason, the secret variable's NAME, the global fallback rate, and the live class patterns, plus the daemon's pid and answered_at. The daemon reads that from its OWN process environment, which is the whole point: the operator exported the secret in the terminal they started the daemon from, and core/child-env.ts strips APPROVAL_* from every child, so doctor's shell could not see it on a machine where sampling had been running for a fortnight. That is the state the bug was found in on 2026-09-05.

Server half in src/daemon/draw.ts (isSamplingQuery is checked before parseQuestion, because a status line carries no action_key and would otherwise be reported as a malformed draw); protocol, parser and async client in src/core/live-draw.ts. The client is asynchronous and dials the socket directly rather than paying for the relay child: only the gate's synchronous request path needs spawnSync, and every caller of this one is a diagnostic already inside an async function. An older daemon reads the status line as a malformed draw and answers ok:false, which parseSamplingAnswer refuses, so the asker reports no answer and the change fails closed.

Scope decision, and the one worth reviewing. The answer is NOT MAC'd and cannot be: doctor holds no secret, so it can check nothing. It is therefore consulted on exactly ONE sampler reason, secret-unset, because that is the only disabled reason which is a fact about a PROCESS ENVIRONMENT. rate-absent, rate-invalid, rate-zero, secret-env-unnamed and policy-unreadable are facts about the policy FILE, doctor reads that file itself, and no answer from any socket softens one of them. What bounds who can make the claim is askDaemonSampling's socket checks: path length, existence, owner-only mode, this euid, and a pid that is still alive. What bounds the damage is that a diagnostic authorizes nothing, spends no budget, reaches no gate and writes to no log. SPEC.md §11.1 invariant 4 is about enforcement paths reducing scrutiny on a self-report; there is no scrutiny here to reduce, only a report to get right. Raised in the journal in case the operator wants the row to stay red with the daemon merely named beside it.

Two details worth knowing from the diff. parseSamplingAnswer rebuilds every field rather than passing the object through, so an answerer cannot put text of its choosing on an operator's terminal; a test asserts a planted secret and a planted message are both dropped. And the per-class breakdown is rendered in DECLARED terms on the enabled-per-daemon branch (declaredClassDetail), because the local classSampling reading would otherwise print every class as none (secret-unset) beside a sentence saying sampling is on.

Validation: npm run build; node --test dist/tests/cli-doctor.test.js 61 pass 0 fail exit 0 (57 before this task, 4 new); node --test dist/tests/live-draw.test.js 21 pass 1 fail, the failure being 'the daemon holds the secret, the asker holds none, and the draw crosses between them', which fails identically at HEAD 30e4899 with HEAD's own draw.ts and live-draw.ts rebuilt and run alone: the spawned daemon binds the socket and does not answer within the 500ms DRAW_TIMEOUT_MS. Pre-existing, untouched here, journalled, and worth its own task. npm run lint and npm run typecheck clean. AC3's fake-daemon coverage is the four cli-doctor cases plus six in live-draw; AC's 'npm test passes' is not claimed, since the full suite was not run to completion in this session.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
doctor's audit-sampling row now asks the running daemon over the APRV-208 socket instead of inferring from its own environment, and names the process that answered. A new status question on the v1 protocol (query: sampling) is answered by src/daemon/draw.ts from the daemon's own resolveSampler state, carrying the secret variable's name and the rate and never the value; src/core/live-draw.ts holds the parser and an async client with the same socket checks a draw makes. Consulted on the secret-unset reason alone, because that is the only sampler reason that is a fact about a process rather than about the policy file. Verified with four new cli-doctor cases against a fake daemon socket (enabled, disabled, absent, and an answer carrying a planted secret) and six new live-draw cases against the real DrawServer: cli-doctor 61 pass 0 fail, live-draw 21 pass with one pre-existing HEAD failure unrelated to this change.
<!-- SECTION:FINAL_SUMMARY:END -->
