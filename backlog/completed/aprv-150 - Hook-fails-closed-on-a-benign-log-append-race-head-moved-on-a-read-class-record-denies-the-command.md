---
id: APRV-150
title: >-
  Hook fails closed on a benign log-append race: head-moved on a read-class
  record denies the command
status: Done
assignee:
  - '@claude'
created_date: '2026-08-29 14:31'
updated_date: '2026-09-01 00:58'
labels:
  - gate
  - hook
  - concurrency
  - bug
dependencies: []
priority: high
ordinal: 135000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-08-29 with parallel agent sessions running under the hook: a session was denied its very first command (git status, class read.shell) with hook-gate-refused:append-failed — the hook read the log head at seq 1089, another writer (a parallel session hook or the daemon) appended seq 1090 between the read and the append, and the compare-and-append correctly refused the stale write. The compare-and-append behaved exactly as SPEC 11.1 invariant 5 requires; the defect is the hook layer above it treating one lost race as a terminal refusal. The record being appended was the hook own execution.started for an autonomous read-class command: no verdict depended on the moved head, and re-reading would have produced the identical decision. Consequence: any two concurrent hook-gated sessions (or one session racing the daemon) deny each other probabilistically, which turns the gate into a lottery under exactly the parallel-fleet load the daily_actions budget was just raised (seq 1056) to accommodate. Fix direction to evaluate at planning time: a bounded re-read-and-retry inside the hook (and possibly other gate writers whose pre-append checks are provably insensitive to the interleaved record) on append-failed/head-moved, with the retry re-running the checks against the fresh head rather than replaying the stale ones — never a blind re-append. The invariant stays intact: every check-then-append still passes through compare-and-append; the retry is a new read plus new checks plus new append attempt. Discovered by an agent lane report (wave 1b, APRV-145 lane); the raw refusal text is preserved in that lane result.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A hook-gated command that loses the append race retries with a fresh read and fresh checks, bounded (small fixed attempt count), and succeeds when the re-derived verdict is unchanged
- [x] #2 A retry whose re-derived verdict DIFFERS from the original (policy changed, budget newly exhausted, attestation stale) enforces the new verdict, proven by a test that flips state between read and append
- [x] #3 The retry lives at the writer layer; compare-and-append itself is unchanged and still refuses stale writes (existing tests untouched)
- [x] #4 A test reproduces the race deterministically (two writers through the real append path) and pins both the pre-fix denial and the post-fix recovery
- [x] #5 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a bounded head-moved retry helper to src/core/gate.ts (the writer layer): HEAD_MOVED_ATTEMPTS = 3, isHeadMoved(refusal) = code append-failed AND append.code head-moved, and withHeadMovedRetry(options, attempt) that re-invokes the WHOLE attempt (fresh readGateRecords, fresh readPolicyOnce/attestation, fresh resolve, fresh escalation and loop-floor checks, fresh single-use scan, fresh budget evaluation, fresh append with the fresh head). Never a blind re-append: the retry is a new read plus new checks plus a new compare-and-append.
2. Add GateOptions.retryOnHeadMoved (clamped to 1..3, default 3) so a test can pin the pre-fix denial shape (1 attempt) against the post-fix recovery (default) with one harness. Fewer attempts is always the stricter path.
3. Split startHarnessExecution into attemptHarnessStart (the existing body, byte-for-byte in its checks) plus an exported wrapper that runs it under withHeadMovedRetry. Same for consumeHarnessGrant, the hook's other execution.started writer (hook.ts consumeGrants). core/log.ts appendEvent and its expectedHead precondition are NOT touched.
4. Tests in tests/concurrency.test.ts, in the file's existing two-real-processes-plus-parent-held-lock style (never fabricated records): (a) distinct keys, loser retries and both starts land, with a retryOnHeadMoved:1 control round pinning the pre-fix append-failed/head-moved denial; (b) same key, loser re-derives already-executed and exactly one execution.started exists; (c) daily_actions:1, loser re-derives budget-exceeded. (b) and (c) are the differing-verdict proofs.
5. npm test, npm run lint; record implementation notes including the SPEC 11.1 invariant-5 statement and the survey of the other gate writers.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What changed

`src/core/gate.ts` grew a bounded head-moved retry at the WRITER layer and both harness writers now run under it. `core/log.ts` is untouched: compare-and-append is byte-for-byte what it was and still refuses a stale write under the lock.

- `HEAD_MOVED_ATTEMPTS = 3`, `isHeadMoved(result)` (code `append-failed` AND `append.code === "head-moved"`, so only the precondition retries and never a lock timeout, a corrupt log or a real verdict), and `withHeadMovedRetry(options, attempt)`.
- `startHarnessExecution` and `consumeHarnessGrant` keep their exported names and signatures; each body moved verbatim into `attemptHarnessStart` / `attemptHarnessConsume` and the exported function is now a wrapper around it. The unit of retry is the WHOLE operation, so an attempt is a new `readGateRecords`, a new `readPolicyOnce`, a fresh attestation, a fresh `resolve`, fresh loop-escalation and loop-floor checks, a fresh single-use scan, a fresh budget evaluation, and an append against the head THAT read observed. Nothing crosses an attempt except the caller's inputs, so no stale conclusion can authorize a write.
- `GateOptions.retryOnHeadMoved` lowers the bound only (clamped to 1..3; a zero, a fraction, a negative or a larger number falls back to the runtime's 3). `1` is the pre-APRV-150 writer, which is how one test harness pins both the old denial and the new recovery.
- Both harness writers were wrapped because both are the hook's own `execution.started` path (`recordUnattended` and `consumeGrants` in `src/cli/hook.ts`); the shared helper was the natural shape, and the hook itself needed no change.

## SPEC §11 invariants (this task touches the check-then-append path)

Invariant 5 — every check-then-append passes through compare-and-append — is preserved PER ATTEMPT, which is where it has to hold. This is a bounded loop over complete check-then-append operations, not a retry of an append: every attempt supplies `expectedHead` from its own read, and an attempt whose head moved writes nothing. The retry cannot launder a denial into an allow, because it never replays the earlier conclusion; if the interleaved record changes the answer, the new answer is enforced. Refusals stay machine-readable and distinct: no new codes, and the code returned is the one the FRESH facts produce (`already-executed`, `budget-exceeded`, `policy-not-attested`, `loop-escalated`, ...), with the last `append-failed`/`head-moved` returned unchanged once the bound is spent, so a caller still fails closed. Enforcement reads stay verified-only (each attempt re-reads through `readVerifiedRecords`), gate events still take the runtime's clock (`tick` per attempt), and nothing self-reported reduces scrutiny.

## Survey of the other gate writers

Same defect shape, NOT changed here:
- `register` and `request` (`src/core/gate.ts`) are on the same hook path (`gateAndWait`) and deny a whole command on a lost race exactly as the start writer did. Their checks are equally re-derivable and they are the strongest candidates for a follow-up.
- `finishHarnessExecution` (the PostToolUse counterpart) loses an OUTCOME record on a lost race, which feeds the §10.2 loop-escalation streaks; worth the same treatment.

Deliberately left alone, and each needs its own task and its own decision rather than a quiet extension of this helper:
- `decide`/`withdraw` — the interleaving is two CONFLICTING human/requester intents, and `tests/concurrency.test.ts` pins the loser's `append-failed`/`head-moved` shape today. A retry would re-derive and refuse safely, but it changes a pinned contract.
- `consumeToken` (`src/core/token.ts`) — same: the double-spend race is pinned, and single-use is the property nobody should soften casually.
- `expire`/`appendExpiry` — daemon-driven materialization; the next tick retries it, so a lost race costs nothing.
- `core/audit.ts` — already documents collecting head-moved refusals per record and reporting them; a sweep is not a verdict.

## Wording point for the human (no SPEC edit made)

`SPEC.md:573` says of `head-moved` that "nothing is retried by the writer". Read as the APPEND writer (`core/log.ts`) that stays literally true after this change: the appender still never retries. If the sentence is meant to bind the gate operations above it, it now needs an amendment sentence saying the harness writers re-derive and re-attempt, bounded. Flagged rather than edited, per CLAUDE.md.

## Validation

`npm test`: 2446 pass, 0 fail (the four new rounds included). `npm run lint`: clean. Note for the next session in this worktree: the first full run failed `ci-guard`'s engines.node check with ENOENT because the worktree had no `node_modules`; `npm ci` (lockfile-pinned) fixed it and the suite is green.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The Claude Code hook no longer denies a command for losing a benign append race. src/core/gate.ts gained a bounded (3-attempt) head-moved retry at the writer layer, and the hook's two execution.started writers — startHarnessExecution and consumeHarnessGrant — now run under it: each attempt is a complete operation (fresh verified read, fresh policy read and attestation, fresh resolution, escalation, loop-floor, single-use and budget checks, fresh compare-and-append against the head it just read), so a re-derived verdict that differs is the verdict enforced. core/log.ts's compare-and-append is unchanged and still refuses stale writes; SPEC §11.1 invariant 5 holds per attempt. GateOptions.retryOnHeadMoved lowers the bound only (1 = the pre-fix writer), which is the seam the tests use. Verified by four new deterministic two-process races in tests/concurrency.test.ts (parent holds the append lock across both children's reads; every record written through the real gate): the pre-fix append-failed/head-moved denial is pinned at retryOnHeadMoved:1; with the default both distinct-key starts land; a shared key gives the loser already-executed with exactly one execution.started; a daily_actions:1 ceiling gives the loser budget-exceeded with a budget.exceeded record. npm test 2446 pass / 0 fail; npm run lint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
