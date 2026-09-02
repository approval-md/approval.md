---
id: APRV-188
title: 'Hooks read via the running daemon: remove the per-process cold walk'
status: Done
assignee:
  - 'agent:opus-lane-p'
created_date: '2026-09-01 02:57'
updated_date: '2026-09-02 08:04'
labels: []
dependencies: []
references:
  - docs/postmortem-2026-08-31-hook-cpu.md
priority: medium
type: enhancement
ordinal: 163000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-186 shrank the cold chain walk from ~100s to ~80ms, but every hook invocation is still a fresh process that verifies the log from genesis, so hook cost remains O(log length) per gated tool call (~0.02ms/record; seconds again if the log grows 100x). The daemon already holds a warm VerifiedReadCache and reads through the same readVerifiedRecords path as everyone else. Serve verified reads (and request-state queries) to hook processes from the running daemon over a local socket, with the current cold walk as the fallback when the daemon is down. Fail closed on any doubt about the daemon's answer: a hook must never treat an unverified or stale response as a verified read, and enforcement paths keep reading only verified records (SPEC §11). See docs/postmortem-2026-08-31-hook-cpu.md (Remaining risk) and APRV-186 for the incident and measurements.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A gated hook invocation against a large log performs no cold chain walk when the daemon is running (verified via timing or read-cache stats)
- [x] #2 With the daemon stopped, the hook falls back to today's in-process verified read and behaves identically
- [x] #3 The daemon-served path preserves the verified-read contract: responses are backed by the daemon's own verified walk, and any transport error, version skew, or stale answer fails closed to the fallback
- [x] #4 SPEC §11 global invariants hold; implementation notes call out that the enforcement read path was touched
- [x] #5 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
MEASURED FIRST (best of N, macOS, fixtures built through the real append path; full numbers in the notes).

A cold gated hook invocation at 10k records costs 371 ms, composed of:
  20 ms   node process start
 116 ms   the CLI module graph (dist/src/cli/main.js statically imports every verb: the MCP SDK, better-sqlite3, the channels). Importing dist/src/cli/hook.js alone is 51 ms.
  65 ms   the cold chain walk (readVerifiedRecords with cache null)
 ~30 ms   the Ajv event-schema compile on the first append (per process; APRV-206's validator cache is memory only)
 the rest three further verified reads (process-cache hits, 2.5 ms each), the append itself, policy load 0.8 ms, classify 0.006 ms, resolve 0.0002 ms.
At 1k records: 271 ms total, 7.9 ms cold walk.

The cold walk is the second largest term and the only one that scales: 6.5 ms per 1k records. The floor a daemon-served read can reach is read + sha256 + JSON.parse = 9.5 ms at 10k (0.94 ms per 1k), a 7x cut in the slope. That is what this task buys: 65 ms to 9.5 ms at 10k, 650 ms to 95 ms at 100k, which is the growth risk the description names. It does not touch the 136 ms constant; see the out-of-scope note at the end.

1. Not a socket: a published snapshot file. The hook's request path is fully SYNCHRONOUS (commandHook returns a number, gateAndWait uses sleepSync). A node:net client cannot be awaited from there, and a spawnSync helper would cost more (20-40 ms of node start) than the walk it saves. The daemon instead PUBLISHES what it verified and the hook reads it with one readFileSync. Same information, no IPC, no fd lifecycle, no child process, so nothing for APRV-205's child-environment rules to leak into.

2. New module src/core/verified-snapshot.ts. The file is .approval/log/verified-head.json, derived from the log path with no configuration. Content: v, log, schema_dir, byte_length, sha256, lines, head (seq and hash), verified_at, pid. It is an ENDORSEMENT OF BYTES and never a source of records: it says only that the bytes of this log up to byte_length, whose sha256 is X, verified clean and end at head H. Written atomically (temp file plus rename) at mode 0600.

3. Admission is the hook's own work, and every step can only REJECT; any failure falls back silently to today's cold walk:
   a. the file is a regular file, owned by our euid, and not group or other writable;
   b. v is 1, log resolves to the log being read, schema_dir matches the caller's;
   c. byte_length is at most the number of bytes we read, and the byte before it is a newline;
   d. sha256 over our own bytes up to byte_length equals the claimed digest. This is the whole proof, and it is the same proof APRV-43's in-process cache pays on every read;
   e. we parse the prefix lines OURSELVES and cross-check: the line count equals the claimed lines, and the last record's seq and hash equal the claimed head. A snapshot serving a wrong head is caught here;
   f. a chain-link pass over the parsed records (alg, seq succession, prev linkage, hash shape). Explicitly a SUBSET of verify.ts's ladder and never a replacement: it can only reject.
   The admitted prefix is then handed to verify.ts's existing verifyText(logPath, suffixText, options, prefix) seam, the same one the APRV-43 cache resumes through, so the appended tail is walked in full and cold by us.

4. The trust boundary, stated rather than assumed. What the hook takes on the daemon's word is exactly two checks, the schema validation and the per-record hash recompute, over bytes the hook has itself proved are the bytes the daemon named. The snapshot can only ever endorse bytes already on disk in the log, and anyone who can write .approval/log/verified-head.json can write .approval/log/events.jsonl in the same directory, where the chain being unkeyed they could recompute a self-consistent forged log that passes a COLD walk too. So the snapshot grants no capability that write access to that directory did not already grant. The ownership and mode checks in (a) are what keep that argument true under a loose umask.

5. Wiring. state.ts gets an explicit one-way opt-in, useVerifiedSnapshots(true), called once by runHarnessHook. Default off, so the daemon, every CLI verb, the channels and approval log verify are untouched and read exactly as they do today. A process-wide switch rather than an option threaded through every call is what lets gate.ts's own internal reads share the seeded prefix; without it the second read of a hook process would be a fresh cold walk. VerifiedReadCache gains a resumed counter beside hits and misses, which is how AC1 is asserted structurally instead of by stopwatch.

6. Publication. Daemon.read() publishes after every clean verified read, so both the opening and the closing read of a tick refresh it, behind a DaemonOptions flag defaulting on. A stale snapshot needs no detection: it endorses a shorter prefix and the hook walks the tail.

7. A doctor row, verified-head snapshot: absent is a skip, present and covering the live log's prefix is a pass, present but not matching is a fail with the reason. .gitignore gains the file.

8. Tests. tests/verified-snapshot.test.ts: the admission matrix (absent, fresh, stale but resumable, digest mismatch, lying head, lying line count, wrong log path, wrong schema dir, group writable, not newline aligned, truncated log) plus an EQUIVALENCE case, that for every fixture the resumed read returns records deep-equal to the cold read and the same head. tests/cli-hook.test.ts: end to end with the snapshot present and absent, identical verdicts and identical log writes, plus the cache-counter assertion for AC1. tests/daemon.test.ts: a tick publishes it at mode 0600.

9. Docs: docs/claude-code-hook.md (where the hook's reads come from, and that the snapshot changes no verdict) and docs/cli-reference.md (the doctor row and the file).

OUT OF SCOPE, reported rather than built: the 116 ms module graph is the largest single term and is independent of log size, so it dominates at every log size this project will see soon. Splitting main.ts's static verb imports into dynamic ones, or giving hook its own entry point, would cut about 3.5x more per invocation than this task does, including on the pass-through calls that never read the log at all. It requires main() to become async, which is a different task with its own risk. Recommended as a follow-up.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built

The daemon publishes what it verified; the hook re-proves it instead of
re-walking. No socket, and the reason is in the measurement below.

**src/core/verified-snapshot.ts (new).** The snapshot lives at
.approval/log/verified-head.json, derived from the log path with no
configuration, written atomically at mode 0600. It carries no records. It is an
ENDORSEMENT OF BYTES: the first byte_length bytes of this log, whose SHA-256 is
this, verified clean and end at this head.

**core/state.ts.** ReadVerifiedOptions gains publishSnapshot (per call, set by
the daemon). Consumption is a process-wide one-way switch, useVerifiedSnapshots,
set by runHarnessHook and by nothing else, because a hook's first verified read
is followed by three more from inside core/gate.ts, which threads no options of
its own; an option could only reach the first read, and the acceleration has to
seed the cache the other three hit. VerifiedReadCache.read consults a snapshot
only on a MISS (the in-process proof always wins, being the stronger one) and
gains a resumed counter beside hits and misses. cache: null stays genuinely
cold: a caller that opted out of this process's proved prefix has not opted into
another process's.

**daemon.ts.** Daemon.read() publishes on every clean read, so both the opening
and the closing read of a tick refresh it. The publication rides ON the read
rather than following it, so the bytes endorsed are the bytes verified: a
publisher that re-read the file to hash it could endorse a digest of bytes
nobody walked. DaemonOptions.snapshot turns it off; it defaults on, unlike
gitEvidence and advance, because it changes nothing outside this machine.

**doctor.** An eighteenth row, verified-snapshot. It can only ever be a latency
fact, and the one FAIL is a snapshot every reader would refuse for a reason an
operator should act on (foreign owner, group- or other-writable).

## Measurements

macOS, 8 cores, fixtures built through the real append path (attest through
core/attest.ts, filler through core/log.ts's appendEvent), best of N.

BEFORE, on a quiet machine. A cold gated hook invocation at 10k records is
371 ms end to end (271 ms at 1k), composed of:

  20 ms   node process start
 116 ms   the CLI module graph. Importing dist/src/cli/main.js is 167 ms;
          importing dist/src/cli/hook.js alone is 51 ms, so 116 ms of every
          hook invocation is verbs it never calls (the MCP SDK, better-sqlite3,
          the channels).
  65 ms   the cold chain walk (7.9 ms at 1k), growing 6.5 ms per 1k records
 ~30 ms   the Ajv event-schema compile on the first append
  rest    three further verified reads (process-cache hits, 2.5 ms each), the
          append, policy load 0.8 ms, classify 0.006 ms, resolve 0.0002 ms

A CPU profile agrees: jcs.serialize 88 ms and verify.js 70 ms of self time on
the walk, the module loaders about 115 ms, readFileUtf8 101 ms.

AFTER, the term this task changes, measured with the real implementation and an
equivalence assertion in the same run (scratchpad readcost.mjs):

  1k records:   cold read 20.81 ms -> resumed 1.76 ms  (11.9x)
  10k records:  cold read 167.3 ms -> resumed 16.5 ms  (10.1x)

Those absolute figures are about 2.5x the quiet-machine baseline because the
machine was saturated by other work when they were taken (load average 170-200
on 8 cores); the RATIO is load-independent, and the quiet-machine equivalent is
65 ms -> about 6.5 ms at 10k and 7.9 ms -> about 0.7 ms at 1k. In-process hook
work (everything after node start and module load) on the same loaded machine:
84 ms -> 11.3 ms at 1k, 201 ms -> 70 ms at 10k, the 10k residue being the Ajv
compile and the append, which this task does not touch.

Whole-process spawn timings could not be taken honestly at the end of the
session: at load average 170+ they swing by 3x run to run and showed no signal
in either direction. The read-term numbers above and the cache counters are the
evidence, which is what AC1 asks for ("verified via timing or read-cache
stats").

## Why a file and not a socket

The hook's request path is synchronous end to end: commandHook returns an exit
code and the wait loop sleeps synchronously, so a node:net client cannot be
awaited from it, and a spawnSync helper to do the awaiting costs 20-40 ms of
node start against a 65 ms walk. A published file needs one readFileSync, opens
no socket and spawns no child, so APRV-205's child-environment rules have
nothing to reach. Serving RECORDS over any transport was rejected on the same
measurement: at 10k the records are 3.4 MB, and serializing plus parsing them
costs more than the walk they would replace.

## Global invariants touched, and how they hold

Invariant 1, "enforcement paths read only verified records", is the one this
task touches, and it is the reason the module header argues rather than asserts.
The structure is APRV-43's with the verifier in another process:

- The reader hashes the endorsed prefix ITSELF, over bytes it read itself, and
  requires the digest the snapshot names. That is the whole proof, and it is the
  same proof the in-process cache pays on every cached read. No amount of stat
  substitutes for it, which is the argument core/state.ts's header already makes
  and which is not weakened here.
- The reader parses the endorsed lines itself and re-derives the head and the
  line count from its own parse. A snapshot naming a head those bytes do not
  reach is refused by arithmetic. This is the "lying daemon" case, and it is
  pinned by a test.
- The reader re-checks the chain links (alg, hash shape, seq succession, prev
  linkage) over its own parse. Deliberately a SUBSET of core/verify.ts's ladder
  and never a replacement: it can only reject, no verdict consults it, and
  core/verify.ts stays the single implementation of the verdict. Everything
  appended past the endorsed prefix is walked by it in full and cold.
- What is therefore taken on the publisher's word is exactly two checks over
  bytes already proved identical: the event schema validation and the per-record
  hash recompute.

Why that residue is not a new capability, stated so a reviewer does not have to
reconstruct it: a snapshot can only endorse bytes already in the log file. To
exploit the residue an attacker must write verified-head.json, which sits in the
same directory as events.jsonl under the same permissions, and the chain is
unkeyed, so an attacker who can write that directory can recompute a
self-consistent forged log that passes a COLD walk too. The snapshot grants
nothing that write access to the log directory did not already grant. The
ownership check (fstat on the open fd, euid must match) and the permission check
(refuse anything group- or other-writable) are what keep that sentence true
under a loose umask, and both are tested.

Fail closed: fifteen distinct refusal reasons, every one of them landing on
today's cold walk with no error anywhere. A bad snapshot cannot make a hook
WORSE off than a machine that has never run the daemon.

Untouched, and stated because a reader will ask:

- The log is append-only. Nothing here writes to events.jsonl. The snapshot is a
  separate file, gitignored, and never evidence.
- Validation at the write boundary is unchanged. Every append still validates
  the complete record against the event schema before a byte is written.
- Every check-then-append still passes through compare-and-append. The hook
  still passes the head its verified read produced, and a resumed read produces
  the FILE's head, not the endorsed prefix's (tested).
- Gate-typed events still take no caller timestamp; no self-reported field
  reduces scrutiny (the snapshot is a claim about bytes, and every claim in it
  is re-derived or refused).

## SPEC.md, drafted here rather than edited (Amended APRV-188, pending sign-off.)

For section 10.2, after the daemon's responsibilities:

  "The daemon publishes a verified-head snapshot beside the log
  (.approval/log/verified-head.json) after every clean verified read: the byte
  length, the SHA-256 and the chain head of the bytes it just walked. A
  short-lived enforcement process (the harness hook) may resume a verified read
  behind that prefix instead of walking from genesis, and only after it has (a)
  recomputed the SHA-256 over its own read of those bytes, (b) re-derived the
  head and the record count from its own parse of them, and (c) re-checked the
  chain links over that parse; anything appended past the endorsed prefix is
  verified in full. A snapshot that fails any of those, or that is absent,
  foreign-owned, or writable by anyone but its owner, is ignored and the reader
  verifies from genesis. The snapshot carries no records, is never evidence, and
  no verdict may depend on its existence."

For section 11, as a rider to invariant 1 rather than a new invariant (a
reviewer may prefer it as a numbered one):

  "'Verified' means verified by a process that proved the bytes. A reader may
  reuse another process's verification of a byte range only when it has itself
  proved, by digest over its own read, that the range is those same bytes, and
  only for the checks that digest makes redundant. Cross-process reuse is
  confined to processes of the same trust domain: the reuse must grant no
  capability that write access to the log directory does not already grant, and
  a reader must refuse any endorsement it cannot attribute to its own user."

## Decisions a reviewer may want to overrule

1. The residual trust. The hook does not re-validate the schema or recompute the
   per-record hashes of the endorsed prefix; that is the whole win. The argument
   that this grants nothing new is above and rests on the chain being unkeyed
   and the two files sharing a directory. A reviewer who wants zero residue
   should reject this task outright rather than ask for a cheaper check: there
   is no cheap check that closes it, and a partial one would read as closure
   without being it.
2. A process-wide switch (useVerifiedSnapshots) rather than a threaded option.
   It is one-way and set at one call site, but it is process state, and
   core/state.ts had none before. The alternative is threading an option through
   core/gate.ts's every internal read, which is a much larger diff for the same
   behaviour.
3. The link re-check is a second, partial implementation of rules that live in
   core/verify.ts. It can only reject and nothing consults it for a verdict, but
   it is duplication, and a reviewer may prefer a seam in verify.ts instead.
4. The snapshot is published by the DAEMON only. A hook that has just completed
   its own clean cold walk could publish one too, which would give the whole win
   on machines where no daemon runs. It is not done here because AC2 says the
   daemon-less hook must behave as it does today, and because a publisher that
   is also the untrusted-est process deserves its own task.
5. Two mechanisms, one for publishing (a per-call option) and one for consuming
   (a process switch), rather than one symmetric knob. They have genuinely
   different shapes: one caller publishes, and one PROCESS consumes.

## Out of scope, reported rather than built

The largest single term in a hook invocation is not the walk: it is the 116 ms
of CLI module graph that dist/src/cli/main.js loads before the hook's first line
runs, and it is independent of log size, so it dominates at every log size this
project will see soon. It is also paid by the pass-through calls (every Read,
every ordinary Edit) that never touch the log at all, which this task does
nothing for. Splitting main.ts's static verb imports into dynamic ones, or
giving hook its own entry point, is worth roughly 3.5x what this task is worth
per invocation. It requires main() to become async, which is a different task
with its own risk, and it is recommended as a follow-up rather than smuggled in
here.

## Validation

- npm run build (tsc): clean.
- npm run lint (oxlint src tests): clean.
- npm test (full suite): 2732 tests, 2731 pass, 0 fail, 1 skipped (the same
  single pre-existing skip APRV-206 recorded), 397 s.
- tests/verified-snapshot.test.ts: 19 new cases, all green.
- tests/cli-hook.test.ts: 70 pass, including three new cases.
- tests/daemon.test.ts: 30 pass, including one new case.
- tests/cli-doctor.test.ts: 55 pass; the frozen check list and the two check
  counts were extended by one for the new row.
- tests/state-cache.test.ts: the thirteen stats assertions gained resumed: 0.
  Every APRV-43 invalidation case is untouched and green.

## Post-review addendum: the path-alias bug, and the whole-invocation numbers

Re-measuring the spawned hook after the first commit showed no gain, which
contradicted the read-term measurement taken with the same code. The cause was a
real bug, not noise: the snapshot's log identity was compared as resolve(path)
on both sides, and a publisher started in /var/folders/... and a reader whose
cwd Node had already resolved to /private/var/folders/... are the same directory
spelled two ways. Every snapshot was being refused as other-log. Safe (it fails
closed to the cold walk) and useless: on macOS temp directories, and in any
checkout reached through a symlink, the whole feature would have been silently
inert.

Both sides now compare realpathSync(resolve(path)), through one helper, falling
back to resolve when the path cannot be resolved (which can only make the
comparison stricter). A new case pins it: a snapshot published through the real
path is admitted by a reader reaching the same log through a symlink, with the
same records as a cold read.

With that fixed, whole-process spawn timings finally show the effect end to end,
still on a machine at load average 110-120 on 8 cores, so the absolutes are
inflated roughly 3x and only the direction and rough size are worth reading:

  10k records:  1070 ms -> 648 ms per gated hook invocation
  1k records:   1302 ms -> 633 ms  (the "without" figure here is noise-dominated;
                the 10k pair was taken in the same minute and is the honest one)

The load-independent figures remain the ones in the previous note: the verified
read itself, 20.8 -> 1.76 ms at 1k and 167 -> 16.5 ms at 10k, about 10x, with
record-for-record equivalence asserted in the same run, and the read-cache
resumed counter as the structural evidence.

Validation re-run after the fix: npm run build clean, npm run lint clean,
npm test 2733 tests, 2732 pass, 0 fail, 1 pre-existing skip. The snapshot suite
is now 20 cases.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Every gated tool call used to verify the log from genesis in a fresh process, at 6.5 ms per thousand records: 65 ms of a 371 ms invocation at 10k, and seconds again as the log grows. The daemon already holds a warm cache, so it now publishes what it verified — .approval/log/verified-head.json, mode 0600, gitignored, carrying no records — and the hook resumes behind it. Measured with the real implementation and an equivalence assertion in the same run: one verified read from an empty process cache drops 20.8 ms to 1.76 ms at 1k and 167 ms to 16.5 ms at 10k, about 10x at both sizes.

The snapshot is an endorsement of BYTES, and the hook proves every part of it that can be proved: it recomputes the SHA-256 over its own read of the log, re-derives the head and the record count from its own parse, re-checks the chain links, and walks everything appended past the endorsed prefix in full and cold. Fifteen refusal reasons — absent, stale, digest mismatch, a lying head, a wrong line count, another log, other schemas, a foreign owner, a group-writable mode, malformed, unknown version, and the rest — all land silently on today's cold walk, so a bad snapshot can never leave a hook worse off than a machine that has never run the daemon. What remains on the publisher's word is the schema validation and the per-record hash recompute over bytes already proved identical, and that residue grants nothing new: the chain is unkeyed, so anyone who can write the snapshot can write a self-consistent forged log in the same directory, which passes a cold walk too. The invariant argument and the SPEC §10.2 and §11 drafts are in the implementation notes, flagged pending sign-off.

Not a socket, and the notes give the measurement: the hook's request path is synchronous end to end, a spawnSync helper to await one would cost more node start than the walk it saves, and serving 3.4 MB of records over any transport costs more than walking them.

Verified with npm test (2732 tests, 2731 pass, 0 fail, 1 pre-existing skip), npm run lint and npm run build; 19 new cases in tests/verified-snapshot.test.ts covering the whole admission matrix and asserting record-for-record equivalence with a cold read, three in tests/cli-hook.test.ts (identical verdicts and identical log writes with and without a snapshot, the daemon-published case asserted on the read cache's resumed counter, and a mismatched snapshot ignored end to end), one in tests/daemon.test.ts (a tick publishes at mode 0600; a corrupt read publishes nothing), and a new doctor row.

Reported and NOT built: the largest term in a hook invocation is the 116 ms of CLI module graph loaded before the hook's first line runs, independent of log size and paid by every pass-through call as well. Splitting main.ts's static verb imports is worth roughly 3.5x this task per invocation and needs main() to become async; recommended as a follow-up.
<!-- SECTION:FINAL_SUMMARY:END -->
