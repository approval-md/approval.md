---
id: APRV-427
title: >-
  approval serve: one waiting hook must not block the tenant's facade; scope the
  serialize lock to mutations
status: In Progress
assignee:
  - '@opus-427'
created_date: '2026-09-22 01:27'
updated_date: '2026-09-25 04:23'
labels:
  - hosting
  - serve
  - concurrency
dependencies: []
priority: high
ordinal: 327000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-22 on the first hosted tenant (Bountify dogfood on Maritime, docs in bountify-ai/approval-md-hosted HOSTED-1): while a POST /hook/hermes call was held open waiting for a human decision, the tenant's POST /verb/queue and GET /status through the same approval serve did not answer until the hook's wait ended. src/serve/server.ts runs every verb invocation, hook call, follow page and export through a single serialize() lock. A waiting hook is a read-mostly poll; holding the tenant's whole facade for it means one pending question hides the queue from the very person who has to answer it, and N concurrent gated calls from a sandbox queue behind each other. Decide the lock's true scope: appends and projections need it (the CLI's own append lock already guards the log), waits and reads do not, or the lock becomes per-store and per-kind. Keep the invariant that the server appends nothing on its own account and that two verbs never interleave an append.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 With a fake decider that holds one /hook call open for 60 s, GET /status, POST /verb/queue and GET /log/follow with the tenant credential answer within 2 s
- [x] #2 Two concurrent /hook calls for different tasks both open their requests and both wait; neither is refused or delayed by the other beyond the append
- [x] #3 A test proves no interleaving of two appends through the facade (the existing single-appender property still holds)
- [x] #4 docs/cli-reference.md states what serve serialises and what it does not
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Finding from reading the code: the facade does not stall because of the serialize() queue alone. handleHook calls commandHook SYNCHRONOUSLY on the main thread, and the hook's poll loop sleeps with sleepSync (Atomics.wait). A hook in its wait therefore freezes the whole event loop: no socket is read, so no lock scoping on the main thread can let /status through. The wait has to leave the main thread, and the lock has to be released by the thread that waits.

1. src/cli/hook.ts (smallest seam): an optional HookWaitSeam {enterWait(), leaveWait()} threaded commandHook -> commandHarnessHook -> runHarnessHook -> DecideInput -> HookRun. gateHarnessCall calls enterWait() immediately before its poll loop (the only place the hook sleeps) and leaveWait() before every append reachable from inside the loop (consumeGrants on grant, withdrawPending on a failed read / thrown path / signal, withdrawAbandoned at the deadline) and in the loop's finally. Absent seam = no-op, so the CLI, codex-bridge and every existing caller are byte-identical. No verb body, verdict or record changes.
2. src/serve/hook-worker.ts: worker_threads entry. Runs commandHook(argv, collector, cwd, () => body, seam) where the seam hands the store lock back to the main thread: enterWait posts "wait" and returns; leaveWait posts "resume" and blocks on a SharedArrayBuffer flag (Atomics.wait) until the main thread has re-acquired the lock on its behalf. Posts "done" with {code, stdout, stderr}.
3. src/serve/server.ts: one store lock per served store (a Map keyed by the resolved log path; one serve serves one store today, so it has one entry, and the map is the per-store seam). Verbs, /status, /log/follow and /export keep taking it exactly as now (export still under withAppendLock too). A hook call runs in a pooled worker (bounded idle pool, env: SHARE_ENV so the launch environment is the one the verb sees, terminated on close). The main thread takes the store lock on the worker's behalf for each mutation section: start -> enterWait, leaveWait -> next enterWait or done. While the worker polls, the lock is free and the main thread is free. A worker crash answers a hook-dialect refusal (new code serve-hook-failed) rather than an allow.
4. Tests (tests/serve-concurrency.test.ts): AC1 hook held open (60s timeout, nobody decides): GET /status, POST /verb/queue, GET /log/follow with the tenant credential each answer < 2s; then a human rejects through the real CLI path and the hook answers hook-rejected. AC2 two concurrent hooks, different tool_use_ids: both approval.requested records land while both calls are still pending; both answer after decisions. AC3 N concurrent waiting hooks + N concurrent autonomous hooks: chain verifies (log verify exit 0), seqs contiguous, and each waiting hook's task.registered and approval.requested are ADJACENT seqs (a mutation section is never interleaved by another), every autonomous call allowed with exactly one execution.started each.
5. docs/cli-reference.md serve section: what serve serialises (per-store mutation sections: every verb call, every hook call outside its wait, follow pages, the export snapshot) and what it does not (a hook's wait, the catalog, requests on other connections while a hook waits); header comments in server.ts updated.
6. Build, typecheck, lint, targeted suites, full npm test once, notes (§11.1 invariants touched: 5 compare-and-append, 1 verified reads), push, PR, leave In Progress.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
What was wrong. The facade did not stall only because of serialize(): handleHook ran commandHook synchronously on the listener's one thread, and the hook's poll loop sleeps with sleepSync (Atomics.wait). A hook in its wait therefore froze the whole event loop, so no socket was read at all and no main-thread lock scoping could have let /status through. Confirmed empirically: the new tests run against origin/main's server.ts fail all three ACs at the 60 s hold.

What was done.
- src/cli/hook.ts: the smallest seam that exposes the phases. An exported HookWaitSeam {enterWait, leaveWait}, threaded commandHook -> commandHarnessHook -> runHarnessHook -> DecideInput.waitSeam -> HookRun.waitSeam. gateHarnessCall calls enterWait() once, right before its poll loop, and leaveWait() before every append reachable from the loop (consumeGrants on a grant, withdrawPending on a failed read, withdrawAbandoned at the deadline, withdrawPending on the thrown path and the signal path) and in the loop's finally. Absent seam = no-op, so every CLI route and codex-bridge is unchanged; no verb body, verdict, record or printed line depends on it.
- src/serve/hook-worker.ts (new): worker_threads entry that runs commandHook with the body as stdin and a seam that holds the store lock by proxy through a SharedArrayBuffer flag (enterWait clears the flag then posts "wait"; leaveWait posts "resume" then Atomics.waits until the main thread has re-acquired the lock and set the flag).
- src/serve/hook-thread.ts (new): the listener's half. A pool of warm worker threads (idle kept up to HOOK_THREADS_IDLE = 4; busy uncapped, since a cap would reintroduce the queueing), env: SHARE_ENV so a warm thread sees the live launch environment, unref'd. run() takes the store lock for the thread's first section and for each resume, releases it on "wait" and on "done". close() terminates idle threads at once and busy ones only from INSIDE the store lock, so no thread is killed between taking the log's append lockfile and releasing it (a killed thread there would leave the lockfile and every later append would time out; acquireLock has no stale detection).
- src/serve/server.ts: storeLock(logPath, root), one serializer per store in a module-level Map keyed by the resolved log path. One serve serves one store today, so each listener finds one entry; two listeners over one store in one process share it, and a multi-store host gets one lock per store. Verbs (incl. /status), /log/follow and /export take it as before (export still also under withAppendLock). The hook route is no longer wrapped: it runs on a hook thread that takes the lock for its mutation sections only. Catalog takes no lock. New serve-authored refusal code serve-hook-failed (thread terminated or died), answered in the harness's dialect via refuseHook with exit_code 2, never an allow. storeLock is exported so the suite can hold the listener's own lock.
- docs/cli-reference.md serve: new subsection "What it serialises, and what it does not" with a table per route.

Decisions beyond the brief.
- Worker threads (node builtin, no new dependency). Required because the wait is synchronous; an async rewrite of decideHarnessCall would have been a far larger change to hook.ts and would have forked it from the codex-bridge caller.
- Poll READS happen outside the store lock, as the brief says. They are readVerifiedRecords on the thread's own read cache, which re-proves the prefix by hash on every read, the same exposure a CLI hook already has beside the daemon's appends.
- Known remaining limitation, documented: POST /verb/wait (agent credential) still sleeps on the listener's thread and holds the store lock for its own timeout, exactly as before; commandWait uses the same Atomics.wait. The hook route is what a harness waits on, so the ACs are met, but a sandbox that calls the wait verb directly would still stall the facade. Suggested follow-up: run the wait verb through the same thread mechanism (execute.ts would need the same seam around its poll, since --withdraw-on-timeout appends).

SPEC.md §11.1 invariants touched (none weakened):
- 5 (every check-then-append through compare-and-append): the appends inside the hook's loop now follow a read made outside the serve lock. They already re-read and compare-and-append under the log lockfile (consumeHarnessGrant, withdraw), which is what makes them safe beside the daemon today; under the serve lock they are also exclusive with every other in-process writer.
- 1 (enforcement paths read only verified records): the hook's reads are unchanged readVerifiedRecords calls, on a worker thread with its own process-memory cache.
- 6 (refusals machine-readable and distinct): adds serve-hook-failed to SERVE_REFUSAL_CODES.
- 7 (no configuration loaded implicitly): the hook thread shares the launch environment (SHARE_ENV) and reads no .approval/env.
The server still appends nothing on its own account (existing test passes).

Tests: tests/serve-concurrency.test.ts (new, 5 tests): AC1 held-hook status/queue/follow < 2 s; AC2 two concurrent hooks both request and are answered independently (granted in reverse order); AC3 burst of 5 waiting + 5 autonomous hook calls: seqs contiguous, each call's records one contiguous run, one execution.started per autonomous call, log verify exit 0; AC3 direct: while the test holds the listener's storeLock a hook call appends nothing, and during its wait the lock is taken at once; close-while-waiting leaves no .lock and the question decidable. Mutation checks run locally: with a no-op store lock the direct AC3 test fails deterministically (the burst test only probabilistically, which is why the direct one exists); with a seam that never releases, all four AC tests fail.

Validation: tsc build and typecheck clean; oxlint src tests clean; targeted suites (serve, serve-hook, serve-concurrency, mcp-server, mcp-http, mcp-guest, every cli-hook-*, log, log-subscribe, codex-bridge) 512/512 pass; full suite with --baseline on Node v26.8.2: 5363 tests, 5362 pass, 0 fail, 1 skipped, 'new failures: none'. The 22 APRV-416 SMTP failures did NOT occur in this run (baseline lists them as not seen), so they appear fixed on this main.
<!-- SECTION:NOTES:END -->
