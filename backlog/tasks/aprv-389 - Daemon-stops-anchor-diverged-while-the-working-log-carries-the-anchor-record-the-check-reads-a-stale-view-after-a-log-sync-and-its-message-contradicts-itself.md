---
id: APRV-389
title: >-
  Daemon stops anchor-diverged while the working log carries the anchor record:
  the check reads a stale view after a log sync, and its message contradicts
  itself
status: To Do
assignee: []
created_date: '2026-09-19 22:06'
labels:
  - daemon
  - records
  - bug
dependencies: []
priority: high
ordinal: 300000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-19 ~22:0xZ in the primary: approval up stopped with "daemon: stopped (anchor-diverged) after 1489 tick(s)", "refs/approval/advance/records-log-2026-09-19 anchors seq 55084 at e53ed3e6... and the working log carries no record at that seq. These are two chains, not one. ahead by 171: the committed chain (seq 55084 e53ed3e6...) is a prefix of the working chain (seq 55255 9c0c476a...)". Read-only check right after: approval log verify clean at 55280; sed -n 55084p on the working log shows seq 55084 hash e53ed3e6..., the exact record the anchor names; the anchor ref file holds c040cd77, the records commit of PR 491 (merged 21:38Z). So the working log carries the record, the message says both that it does not and that the committed chain is a prefix of it, and the daemon stopped on a divergence that does not exist. Sequence that day: the orchestrator ran approval log advance --pr from the primary at 21:16Z (PR 491) while the daemon was up; Carter ran approval log sync in the primary at ~20:0xZ and again later ("snapshot restored over the pulled baseline"), each time under the running daemon; the policy amendment making log.advance.daemon autonomous (seq 53366, PR 485) and a daemon restart happened between. Hypotheses to test in order: (1) the anchor check compares the anchor against the daemon in-memory chain view, which a sync that rewrites the working file underneath the process leaves stale, so the record is missing from the VIEW and present in the FILE; (2) the message builds both sentences from different sources (file for the prefix claim, view for the missing-record claim). Fix: the anchor check reads the file through the same verified read the tick uses and re-reads before declaring divergence; a stop message never asserts two contradictory facts (if the prefix claim is true the verdict is not diverged); a sync under a running daemon is either refused (the daemon is the single writer) or the daemon notices the file changed and re-reads. Related: APRV-215 (sync refuses on dirty working log), APRV-284 (advance arms itself), APRV-382 (daemon cadence advance), APRV-125.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A test reproduces the false anchor-diverged: build a log through the real append path, advance it to a records commit whose anchor is set, replace the working file with a longer chain that has the committed chain as a prefix (the sync shape), tick the daemon, and assert it continues rather than stops
- [ ] #2 The anchor check reads the file through the verified read the tick uses, re-reads once before declaring divergence, and the stop message for a real divergence names the seq and both hashes without asserting a prefix
- [ ] #3 approval log sync refuses while a daemon holds the log (or the daemon re-reads and logs one line when the file changed underneath it); the choice is recorded in the notes and docs/dogfood-cutover.md
- [ ] #4 build, typecheck, lint, daemon, advance and sync suites pass
<!-- AC:END -->
