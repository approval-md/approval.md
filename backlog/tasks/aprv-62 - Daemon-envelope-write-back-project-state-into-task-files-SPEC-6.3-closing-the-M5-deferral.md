---
id: APRV-62
title: >-
  Daemon envelope write-back: project state into task files (SPEC 6.3), closing
  the M5 deferral
status: To Do
assignee: []
created_date: '2026-08-17 16:17'
updated_date: '2026-08-17 16:17'
labels: []
milestone: m-8
dependencies:
  - APRV-61
priority: high
type: feature
ordinal: 61000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC 6.3: state is a projection of log events, updated by the daemon after the event is appended, never the reverse. APRV-39 deferred this to M6 because it needs the round-trip writer. With the writer in place, the daemon updates approval.state in the task file after each relevant append (requested, granted, rejected, expired, revoked, executed), through the writer, atomically (temp+rename), and only when the file is otherwise unchanged from what the log implies. envelope.drift keeps its meaning: a file whose state contradicts the log at read time is recorded as drift; write-back is what then repairs the projection, so the drift-record-then-correct pair is the documented behavior. Write-back never fires on a file the writer cannot round-trip byte-safely (structured refusal, surfaced as a daemon warning); a file with no envelope is never given one. The three envelope.drift records from the APRV-51 proof (seq 7, 9, 12) are the motivating trace. Amend SPEC 10.2 to remove the deferral sentence and state the shipped behavior; SPEC 6.3 stays as written.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After each state-changing append the daemon rewrites approval.state in the task file via the round-trip writer, atomically, preserving all other bytes
- [ ] #2 A file the writer cannot round-trip is left untouched with a distinct daemon warning; a file with no envelope is never given one
- [ ] #3 Drift-then-repair sequence tested end to end with a real daemon process; log verify clean
- [ ] #4 SPEC 10.2 deferral sentence replaced with the shipped behavior, same commit
<!-- AC:END -->
