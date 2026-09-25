---
id: APRV-440
title: >-
  Append durability: fsync the log after every append so a platform kill cannot
  leave a zero-filled torn tail
status: To Do
assignee: []
created_date: '2026-09-25 01:49'
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
- [ ] #1 Every append to events.jsonl fsyncs the file descriptor before the verb reports ok, and the log directory is fsynced after the file is first created; a test with an injected write layer proves the fsync happens after the write and before the return
- [ ] #2 approval log verify names a NUL-filled unterminated tail as the crash-before-writeback signature distinct from a tampered or half-written JSON line, and doctor's fix text says which bytes to truncate
- [ ] #3 The daemon tick cost with fsync is measured and recorded in the notes; if it exceeds a documented budget, appends are batched per tick with one fsync rather than skipped
<!-- AC:END -->
