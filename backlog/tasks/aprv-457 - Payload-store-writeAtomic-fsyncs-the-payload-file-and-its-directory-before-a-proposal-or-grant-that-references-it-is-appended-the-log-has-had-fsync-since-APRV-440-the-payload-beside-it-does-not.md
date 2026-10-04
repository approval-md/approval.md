---
id: APRV-457
title: >-
  Payload store: writeAtomic fsyncs the payload file and its directory before a
  proposal or grant that references it is appended (the log has had fsync since
  APRV-440, the payload beside it does not)
status: To Do
assignee: []
created_date: '2026-10-04 01:39'
labels:
  - agent-village
dependencies:
  - APRV-440
  - APRV-445
ordinal: 344000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the merge refuter on PR #569 (APRV-445) on 2026-10-04. src/core/payload-store.ts writeAtomic writes the payload to a temp file and renames it into place with no fsync of the file or the directory, while the log append has fsynced since APRV-440 (#573). A platform kill between the rename and writeback can leave a committed log record whose payload_hash points at a zero-filled or missing payload: the record verifies, the payload does not, and every consumer that binds on payload bytes (start's byte-equality check, the protected-path guard's granted-file evidence, the follower's chain export) sees an unexplained mismatch. Same evidence base as APRV-440 (hosted doc 02 sections 4.6 and 8: NUL tails after a maritime restart). Scope: fsync the temp file before the rename and the directory after it, proven with the injected write layer APRV-440 added; doctor names a missing or torn payload for a verified record as the crash-before-writeback signature; measure the cost on the propose path (one payload per propose) and record it in the notes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 writeAtomic fsyncs the temp file before rename and the containing directory after, proven with an injected write layer that drops unsynced bytes
- [ ] #2 approval doctor (or log verify) names a verified record whose payload is missing or NUL-filled as crash-before-writeback, distinct from a tampered payload
- [ ] #3 propose and grant paths measured before and after; the per-call cost recorded in the implementation notes
<!-- AC:END -->
