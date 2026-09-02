# Postmortem: the daemon tick pinning a core (2026-09-02)

Task APRV-212, postmortem task APRV-213. One-line version: with a 10k-record
log and hooks from several sessions appending every few seconds, every daemon
tick re-read and re-hashed the whole log once per task file (about 210 times),
published a verified-head snapshot into the directory it was itself watching
(so it woke itself after every tick), and, when the sampling secret resolved,
ran a quadratic audit candidate scan. The fix reads once per drift scan,
publishes the snapshot only when the verified prefix changed and filters the
daemon's own writes out of the watcher, and indexes declarations once per
audit sweep.

Prior work that did not cover this path: APRV-186 (per-record Ajv rebuild in
the hook's cold walk, `docs/postmortem-2026-08-31-hook-cpu.md`, APRV-187) and
APRV-188 (hooks resume behind the daemon's published snapshot). APRV-188 made
hook processes cheap by having the daemon publish what it verified; the
per-read publication it added is one of the three costs here.

## Headline numbers

Synthetic 10k-record log with the live log's record mix, built through the
real append path (a copy of the live log is refused to agents: `.approval/log`
classifies `policy.core`, human-only). 483 registered tasks, 9,094
`execution.started`, 270 pending requests, 206 task files, 6.4 MB.

| Measurement | Before | After |
|---|---|---|
| One tick, wall (in-process mean, steady state) | 2,926 ms | 208 ms |
| CPU per tick (user+sys) | 3,345 ms | 207 ms |
| Verified reads per tick | 210 | 5 |
| Time inside verified reads | 2,079 ms | 69 ms |
| Drift scan | 2,089 ms | 38 ms |
| TTL sweep, steady state (nothing lapsed) | n/a | 35 ms |
| Write-back pass | 23 ms | 32 ms |
| Render (QUEUE.md) | 36 ms | 52 ms |
| Audit sweep, secret unresolved (the live daemon's likely state) | 56 ms | 49 ms |
| `supervisedExecutions` alone, secret resolved | 3,313 ms per call | 18 ms |
| Ticks in 45 s, `--interval 10m`, no external appends | 18 | 1 |
| Snapshot writes across the profiled ticks | one per read | 1 |

Before is a 5-tick mean whose first tick also expired the fixture's 270 lapsed
requests (TTL sweep 720 ms in that mean); after is a 10-tick mean on the
already-expired fixture. The 5-tick after-mean that includes that first tick
is 1,060 ms, of which 865 ms is the TTL sweep's 270 one-shot `expire` calls.
Roughly 14x per tick and 16x in CPU at steady state; ~180x on the audit
candidate scan.

CPU profile of one real `daemon run --once` before the fix, self time:
45% SHA-256 `update`, 16% `chainAnomalies`, 7% file read, 2% JCS serialize.

## Impact

Measured 2026-09-02 ~09:10 on the primary checkout, `approval up` with no
flags started from an interactive shell:

- 7m05s CPU in 8m34s wall. Six 1 s samples of %CPU: 0, 47, 96, 84, 91, 14.
  Bursts of several seconds near 100%, main thread in `kevent` between them:
  one enormous computation per tick, never a tight loop.
- Log 6,796,310 bytes, 10,364 records, of which 9,425 `execution.started`,
  501 `task.registered`, 280 `approval.requested`, 25 `audit.sampled`.
- Hooks from concurrent Claude Code sessions appending ~20 records/min
  (per-minute counts over the last 10 min: 19, 12, 17, 17, 25, 25, 26, 21, 6, 7).
- 249 payloads; 206 task files; daemon RSS 340 MB.
- `DEFAULT_DEBOUNCE_MS = 250`, `DEFAULT_INTERVAL_MS = 30_000`: with an append
  every ~3 s the watcher-driven tick is effectively continuous, and with the
  self-wake it is continuous even without appends.

## Root cause

Three costs compounded on one tick, each locally reasonable:

1. **A verified read per task file.** `scanForDrift` in
   `src/daemon/daemon.ts` re-read the log inside `checkOneFile` and
   `reportEnvelopeLoss` so that every append's `expectedHead` was fresh. That
   is the right instinct for the append and the wrong cost for the decision:
   206 task files, of which 202 carry no envelope, each triggered a full
   `readFileSync` of 6.4 MB, a SHA-256 over the whole proved prefix (the
   cache's load-bearing check, by design), a `chainAnomalies` pass over all
   records, and a snapshot publish. About 10 ms each, 2.1 s per tick.
2. **The snapshot published on every read, into the watched directory.**
   `VerifiedReadCache.read` (`src/core/state.ts`) called `publishSnapshot` on
   every clean read; `publishSnapshot` hashed the file a second time and did a
   temp-write plus rename of `verified-head.json` into `dirname(logPath)`,
   which is the directory the daemon watches. Every tick therefore ended by
   waking its own watcher, and 250 ms later the next tick began. Confirmed by
   the probe: 18 ticks in 45 s with a 10-minute interval and no appends.
3. **A quadratic audit candidate scan.** `supervisedExecutions` in
   `src/core/audit.ts` called `declaringTasks`, `hasApprovalCycle` and
   `findDeclaration` (each a full-log scan) once per `execution.started`
   record. With 9k executions that is ~270M iterations, 3.3 s per call. It
   runs only when the sampling secret resolves (a daemon started from a shell
   with `eval "$(approval env)"` has it), and then once per tick plus once per
   sample appended.

The log grew from 4.4k records (APRV-186) to 10.4k in two days because every
hook-gated command appends an `execution.started`; the task-file count grew
with the backlog. Cost 1 is linear in files times log size, cost 3 is
quadratic in log size, and cost 2 turned "per append" into "always".

## What was ruled out

- **`QUEUE.md` as the self-feed.** It is rewritten every tick without a byte
  comparison, but it lives in `.approval/`, which is not watched. Not a wake
  source. Left as is.
- **Payload pruning.** `listStoredPayloadHashes` is one `readdir`, no per-file
  stat or hash; 0.8 ms per tick with 249 entries.
- **Policy reloads.** `loadPolicy` per call (TTL, prune, audit, expire) is
  sub-millisecond with APRV-206's compiled-validator cache.
- **The cadence advance.** Off by default; when on it spawns a few `git`
  subprocesses per tick, which is a separate cost worth its own task if it
  shows up.
- **A tight loop.** As in APRV-186, the wait between ticks is real (`kevent`);
  the CPU was one large computation per tick.

## The fix

- `src/core/execute.ts`: `indexDeclarations(records)`, one pass producing the
  declaring-task set, the last declaration and the requested-key set per
  action key; `supervisedExecutions` consults it. The per-key helpers remain
  the gate's API, and a test proves the index equal to them on every key.
- `src/daemon/daemon.ts`: the drift scan reads once for the decision; a file
  that actually drifts re-reads immediately before its append and re-derives
  against the fresh head, so compare-and-append (SPEC.md §11.1 invariant 5)
  is exactly as strict as before. The log-dir watcher schedules only for the
  log's own file name; the tasks-dir watcher ignores files the daemon's
  write-back placed. The `tick` line gains additive `ms`, `reads` and
  `phases` fields.
- `src/core/verified-snapshot.ts` and `src/core/state.ts`: the snapshot is
  written only when `(byte_length, sha256)` changed, and the digest is the one
  the cache already proved, so a read hashes the file once.

Invariants touched: the enforcement read path (daemon drift decision vs
append reads; the cache's publish path). Unchanged: every append carries the
head it decided from, enforcement reads only verified records, no schema
change, the log is never mutated.

## Learnings

1. **Price the read, then count the readers.** APRV-186 made the read cheap
   (80 ms cold, ~10 ms warm) and stopped there. A 10 ms read called 210 times
   per tick is the same bug with a different multiplier. When a per-item loop
   calls a "cheap" verified read, the number of items is part of the cost.
2. **A cache that publishes is a writer.** The APRV-188 snapshot was reasoned
   about as derived, local, ignorable state, all true, and none of it says
   where the write lands. It landed in the one directory whose every change
   schedules work. Any file a daemon writes must be checked against the set
   of files it watches.
3. **Quadratic scans hide behind small n.** `supervisedExecutions` was written
   when a log had dozens of executions. At 9k it is seconds. Per-record
   helpers that scan the whole log are fine for the gate (one action per
   process) and wrong inside a loop over records.
4. **Fixtures must carry the live mix, not just the live size.** The first
   fixture had the sampling secret set and the sweep drew ~900 samples at 3 s
   each; the live daemon most likely runs without it. Both states were
   measured separately before choosing what to fix.
5. **The gate shapes the investigation, again.** Copying `.approval/log` is
   `policy.core`, human-only, and any script naming the live log path is
   `log.mutate`, human-only; `grep -c` on it is a read. The profile ran on a
   synthetic log built through the real append path. If the numbers need
   re-running on the real log, a human copies it into the scratch directory.

## Remaining risk and follow-up

- Each verified read still hashes the whole proved prefix (6.4 MB, ~5 ms).
  At ~8 reads per tick that is fine; at 100 MB it is not. The durable fix is
  an incremental prefix proof (hash state carried forward, or a byte-range
  check on the tail plus a periodic full re-proof), a design change to
  `VerifiedReadCache` that deserves its own task.
- `chainAnomalies` runs over the full record array on every read. Linear and
  small today (~2 ms at 10k); cacheable per prefix if it shows up.
- The `for(;;)` re-read-per-append shape in the audit and prune sweeps is
  correct (each append needs a fresh head) and now costs one cheap read plus
  one linear scan per append.
- Defaults unchanged: `--debounce 250ms`, `--interval 30s`. The operator note
  in `docs/cli-reference.md` says when to raise the debounce.

## Verification trail

- Before: `scratchpad/profile-tick.mjs` (5 in-process ticks, per-phase
  timers), `node --cpu-prof` of one `daemon run --once`, `selfwake.mjs`
  (real daemon, 45 s, `--interval 10m`), `bench-audit.mjs`
  (`supervisedExecutions` alone). Numbers in the table above and on APRV-212.
- After: the same scripts on a fresh fixture (5 ticks including the expiry
  tick), then 10 ticks on the already-expired fixture for the steady state;
  the self-wake probe again (1 tick in 45 s); `bench-audit` (18 ms).
- Tests: `tests/audit-index.test.ts`, `tests/daemon-tick-cost.test.ts`, the
  no-self-wake case in `tests/daemon.test.ts`, snapshot dedupe cases in
  `tests/verified-snapshot.test.ts`. `npm test`, `npm run lint`.
- Deploy: PR merged, primary synced and rebuilt, daemon restarted by Carter.
