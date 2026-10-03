---
id: APRV-440
title: >-
  Append durability: fsync the log after every append so a platform kill cannot
  leave a zero-filled torn tail
status: Done
assignee:
  - '@claude-opus'
created_date: '2026-09-25 01:49'
updated_date: '2026-10-03 13:44'
labels:
  - log
  - durability
  - hosting
dependencies: []
priority: high
ordinal: 334000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-25 on the first hosted tenant (Bountify dogfood on Maritime, ext4 data=ordered on a virtio disk): a human attested the policy (approval policy attest answered ok, seq 17), the platform restarted the machine about 30 s later (maritime restart: kill without a graceful flush, then a snapshot), and afterwards events.jsonl ended with a 456-byte unterminated line of NUL bytes: the file had been extended but the data blocks were never written back, so the record the CLI had already acknowledged was gone. approval log verify reports torn-tail with records 1..16 clean; doctor and up refuse until a human truncates. core/log.ts appends with one writeSync on an O_APPEND handle (line 874) and never fsyncs, so the guarantee is atomicity against concurrent writers, not durability against power loss or a kill before writeback. For a log that is the truth, an acknowledged append must survive the machine dying the next moment. Add fsyncSync(fd) after the write (and fsync of the directory after creating the file) on every append path, including the checkpoint and verified-head writers if they claim durability; measure the cost on the daemon tick; make the torn-tail repair path say that a NUL-filled tail is the crash-before-writeback signature so an operator knows nothing was tampered. Reference: SPEC section 8 (append-only, the log is the truth), section 11.1 invariant 5 (compare-and-append).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every append to events.jsonl fsyncs the file descriptor before the verb reports ok, and the log directory is fsynced after the file is first created; a test with an injected write layer proves the fsync happens after the write and before the return
- [x] #2 approval log verify names a NUL-filled unterminated tail as the crash-before-writeback signature distinct from a tampered or half-written JSON line, and doctor's fix text says which bytes to truncate
- [x] #3 The daemon tick cost with fsync is measured and recorded in the notes; if it exceeds a documented budget, appends are batched per tick with one fsync rather than skipped
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. core/log.ts: route the append's open/write/fsync/close through a module-level write layer (real fs by default, swappable only by a test). Open with O_CREAT|O_EXCL first so creation is known exactly; after writeSync, fsyncSync(fd) before close and before return; on first creation fsync the log directory (and the parents of any directory withAppendLock just created). fsync failure after a successful write returns io with a message saying the line may be on disk, and still notifies the read cache. No change to lock, tail read, compare-and-append or validation.
2. Checkpoint writer appends through appendEvent (covered). verified-head.json is a re-provable cache and claims no durability: unchanged, said so in notes.
3. core/verify.ts: torn-tail result gains tear (nul-filled | partial-line), tornBytes and intactBytes; NUL-filled message names the crash-before-writeback signature; byte count fixed to UTF-8 bytes. log verify --json and its registry output schema carry the new fields.
4. cli/doctor.ts log row: detail names the signature, fix says keep the first N bytes / drop the final M with a portable truncate command.
5. Tests: injected write layer proves write -> fsync -> close order and fsync before return, dir fsync only on creation, fsync failure path; verify and doctor cases for NUL tail vs partial line.
6. Bench (opt-in, APPROVAL_BENCH=1): append cost with and without fsync and a daemon tick that appends; record numbers and budget in notes; batch only if over budget.
7. CHANGELOG, npm test, lint, PR, refuter, CI, arm.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Resume point: code, tests and bench done in the worktree (log.ts fsync + log-write-layer.ts seam, verify tear/tornBytes/intactBytes, doctor fix, CHANGELOG). Next: full npm test, commit APRV-440, push, PR, refuter, CI watch, arm.

Implementation (what the diff will not say):
- Write and fsync sequence in appendEvent, all under the append lock and after the tail read, compare-and-append and schema check (none of which changed): open O_WRONLY|O_APPEND|O_CREAT|O_EXCL (EEXIST falls back to the same flags without O_EXCL, which is how creation is known exactly) -> one write(2) of the whole line -> check the byte count -> fsync(fd) -> close(fd) -> only if this call created the file: fsync the log directory, and the parent of every directory withAppendLock's mkdir created, innermost first -> return ok. Windows skips the directory fsync (cannot open a directory; NTFS journals names).
- Failures after bytes may have landed (short write, fsync EIO, directory fsync EIO) return the existing io code, never a new one, with a message that says the record may be on disk and to re-read before deciding. The read-cache notification now fires whenever bytes may have reached the file, not only on ok. Known limit: after an fsync failure Linux may mark the page clean, so a later append's fsync does not re-report it; the io result is the one signal.
- The seam is src/core/log-write-layer.ts, kept out of core/log.ts so the pinned public surface of log.ts (tests/log.test.ts) is unchanged and nothing importing log.ts can swap the layer. Nothing in src calls setAppendWriteLayerForTests.
- Checkpoint writer: log.checkpoint is appended through appendEvent, so it inherits the fsync. verified-head.json (core/verified-snapshot.ts) claims no durability: every reader re-proves it against the log and walks the log when it cannot, so it is unchanged. Out of scope and worth a follow-up: cli/log-sync.ts rewrites the live log via temp file + rename with no fsync of the temp file or directory.
- verify: torn-tail gains tear (nul-filled when every byte of the unterminated tail is NUL, else partial-line), tornBytes and intactBytes. A tail that is part record and part NUL is partial-line on purpose: some bytes landed. The torn count was UTF-16 units before; it is UTF-8 bytes now. intactBytes is exact (the verified prefix re-encodes to its own bytes); tornBytes is exact for NUL and valid UTF-8 tails. log verify --json and its registry output schema carry the three fields; docs/cli-reference.md shows them. The gate's log-torn-tail refusal text in core/state.ts is unchanged and still points at approval log verify.
- doctor's log row: the fix still opens with approval log verify (FIX_COMMAND_PREFIXES, and the repair is a human decision taken after reading), then names the bytes to keep and drop and a node truncateSync command (truncate(1) is missing on macOS). Doctor truncates nothing.
- Global invariants touched: compare-and-append (invariant 5) is untouched, proven by the case where a head-moved refusal makes zero write-layer calls. No refusal code added. Log append-only: unchanged; the tests build every log through appendEvent, and the torn tails are appended to copies, as the existing suites do.
- SPEC: section 8 states append-only and the log as truth and says nothing about durability, so this strengthens the implementation without diverging from it; no SPEC edit.

AC #3 measurement (tests/append-fsync.bench.ts, APPROVAL_BENCH=1, macOS APFS, where libuv's fsync is F_FULLFSYNC; 2026-10-03): one append median 4.10 ms with fsync vs 0.35 ms without, so fsync costs 3.74 ms per append (p95 6.10 vs 0.62). A daemon tick appending 20 drift records: median 167.1 ms with fsync vs 83.1 ms without, +84.0 ms per tick (4.2 ms per append). A tick that appends nothing pays nothing. Budget, written into the bench: 25 ms per append (a tap's ack pays one append inside APRV-206's 300 ms bound) and 1000 ms per 20-append tick (the default interval is 30 s). Both are well inside budget, so appends are not batched; each append's ok still means durable. Linux ext4 on virtio (the hosted shape) is unmeasured here; run the bench there before reading it as settled.

Validation: node --test on log-fsync, log, verify, cli, cli-doctor, daemon-tick-cost and read-proof, exit 0 (210 pass, 0 fail); oxlint exit 0. Full suite (run-tests.mjs --baseline): 5401 pass, 2 fail, exit 1. Both failures were build-freshness: I edited log.ts mid-run, so dist went stale. Both files pass alone on a fresh build (exit 0). CI is the full-matrix verdict.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Every append to events.jsonl now fsyncs the descriptor after its single write and before ok, and a first append fsyncs the directory entries it created. A short write, a failed fsync and a failed directory fsync each return io instead of ok. log verify classifies a torn tail as nul-filled (the crash-before-writeback signature) or partial-line and reports tornBytes and intactBytes. doctor's fix names the bytes to keep and the command that keeps them. The order of write, fsync, close and directory fsync is proven by an injected recording layer (tests/log-fsync.test.ts). On macOS fsync measured 3.7 ms per append and +84 ms for a 20-append daemon tick. Both are inside the documented budget, so appends are not batched.
<!-- SECTION:FINAL_SUMMARY:END -->
