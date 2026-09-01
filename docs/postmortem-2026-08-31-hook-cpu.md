# Postmortem: hook processes pinning cores (2026-08-31)

Task APRV-186, fixed by PR #166, merged 2026-09-01 02:47 UTC. One-line
version: every gated `approval hook claude-code` process was spending
90 to 117 seconds of pure CPU verifying the log before it ever started
waiting, because the chain walk rebuilt the Ajv schema validator for
every record. The fix compiles the validator once per walk.

## Headline numbers

| Measurement (live log: 4,443 records, 2.9 MB) | Before | After |
|---|---|---|
| Cold verified read (one full chain walk) | 90.9–116.7 **s** | 68–118 **ms** |
| Per record | ~23 ms | ~0.02 ms |
| Cached re-read, file unchanged | ~9 ms | ~5 ms |
| Hook process CPU over its whole wait (e2e repro) | one core pinned for minutes | 5.6% |

Roughly a 1,300x improvement on the cold walk. Test suite unchanged:
2,442/2,442 pass.

## Impact

Observed from an unrelated session on the same machine, ~17:00 local:
five concurrent hook processes (`node /opt/homebrew/bin/approval hook
claude-code ... --timeout 9m`) each pinned at ~100% CPU. Together with
one pytest run they drove the 8-core machine to a load average of ~68,
badly enough that Chrome extensions took seconds to inject and their
service-worker messages timed out. Separately, every gated action in
every approval.md session had been stalling for minutes without anyone
attributing the sluggishness to the hook.

## Root cause

Three facts compounded, none of them wrong alone:

1. **The walk validated per record through the one-shot API.** `walk()`
   in `src/core/verify.ts` called `validate("event", record)` for every
   log line. `validate()` was written for the write boundary, where it
   runs once per append.
2. **`validate()` rebuilt the world per call, by design.** The module
   header in `src/core/validate.ts` promised "no cross-call caching" so
   a run could never depend on the order or history of previous calls.
   Each call re-read the schema directory, parsed all four schema
   files, constructed a fresh `Ajv2020`, registered formats, and
   compiled. About 23 ms per call.
3. **Every hook invocation is a fresh process.** The verified-read
   cache (`VerifiedReadCache`) is memory-only and process-lifetime, so
   it cannot help a process that lives for one tool call. Each gated
   hook paid the full cold walk from genesis.

Cost per gated tool call: 23 ms x 4,443 records ≈ 100 s of CPU. The
Claude Code settings spawn one hook per Bash/Edit/Write call with a
9-minute wait, so a burst of tool calls (or several sessions at once)
stacked one pinned core per pending call. That is the five-spinner
picture exactly.

The log had grown to 4.4k records gradually; the cost is linear in log
length with a large constant, so it hid until the log was big enough
and enough sessions ran at once.

## What was ruled out

- **The wait loop.** The initial theory (and an independent LLM
  diagnosis) was a busy-poll: a loop re-reading a state file with no
  sleep. The actual loop in `src/cli/hook.ts` sleeps 1 s between polls
  via `Atomics.wait` and was healthy all along; on a small log the
  whole hook runs at ~7% CPU. The suggested one-line
  `setTimeout` fix targeted a loop that does not exist in this
  codebase. Lesson: sustained 100% CPU has two shapes, a tight loop
  and one enormous computation, and a profile full of file open/close
  activity fit both (here it was the schema re-reads, thousands per
  walk).
- **The verified-read cache.** It is sound and was working: appends
  reuse the proved prefix (hash re-proof), and a warm process re-reads
  an unchanged log in single-digit milliseconds. It misses only for
  fresh processes and same-size rewrites, both as designed. The
  benchmark's "rewrite same bytes" case cold-walked every time, which
  is the mtime guard doing its job.

## The fix

`src/core/validate.ts` gained `prepareValidator()`: load and compile a
schema once, get back a reusable `check()` with identical fail-closed
error shapes. `validate()` is now expressed through it, so per-call
semantics at the write boundary are unchanged. `walk()` prepares the
event validator lazily on the first record and reuses it for the rest
of the walk; lazily, so a walk over zero lines still never touches the
schema directory. Every record is still schema-validated and every
verdict, message, and line number is unchanged.

Determinism stance preserved: preparing is still uncached call to
call; a prepared validator is an explicit snapshot the caller holds
for one pass.

## Learnings

1. **Per-call purity plus a per-item loop is a quadratic-feeling trap.**
   Each decision was locally sound: deterministic validation (re-read
   schemas every call), thorough verification (validate every record),
   simple deployment (one process per hook). The product of the three
   was minutes of CPU per tool call. When a pure-function-of-disk
   guarantee is bought by re-reading and recompiling, every new caller
   in a loop needs to be priced.
2. **Process-lifetime caches are invisible to one-shot processes.** The
   cache made the daemon fast and did nothing for the hook, the most
   frequently spawned reader. Cache design must name its beneficiaries.
3. **Measure before patching the pattern-matched loop.** The
   plausible fix (add a sleep) would have changed nothing. The
   10-minute benchmark (cold vs cached read on a copy of the live log)
   located the real cost immediately.
4. **The gate shaped its own debugging, mostly well.** The classifier
   denied `ps`, `pgrep`, `sleep`, and inline `node -e` (all
   unclassified, fail closed), so CPU was measured with a `--require`
   preload printing `process.cpuUsage()` from inside the child. A
   benchmark command that named `.approval/` paths classified as
   `policy.edit` and sat in the 9-minute wait, which was a live
   demonstration of the bug's blast radius mid-investigation.
5. **Slowness reports deserve attribution early.** Gated actions had
   been stalling for days; the cost was attributed to the machine being
   busy rather than to the hook, until an outside session saw the five
   spinners. A pinned-CPU hook is worth a `top` the first time a
   session feels slow.

## Remaining risk and follow-up

The cold walk is still O(log length) per hook process; the fix shrank
the constant ~1,300x. At 4.4k records the walk costs ~80 ms. If the
log grows 100x this becomes seconds again. The durable fix is to stop
paying a cold walk per process: let hooks read via the running daemon
(which holds the warm cache) over a local socket, falling back to the
cold walk when the daemon is down. Filed as APRV-188.

## Verification trail

- Benchmarks: `readVerifiedRecords` on a copy of the live log, five
  iterations each of cold / cached-unchanged / same-size-rewrite,
  before and after (numbers in the table above and on APRV-186).
- End-to-end: real CLI fed a `PreToolUse` event on stdin with a
  manual-class command against a scratch policy, 8 s timeout, CPU read
  from a `process.cpuUsage()` preload: 5.6% of one core, total.
- `npm test` 2,442 pass / 0 fail; `oxlint` clean.
- Deploy: PR #166 squash-merged; primary checkout rebuilt (the global
  `approval` bin is npm-linked to it); daemon restarted by Carter.
