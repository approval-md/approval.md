---
id: APRV-63
title: >-
  Envelope-loss detection: a task with log history and no envelope is reported
  distinctly
status: Done
assignee:
  - '@fable'
created_date: '2026-08-17 16:17'
updated_date: '2026-08-17 18:47'
labels: []
milestone: m-8
dependencies:
  - APRV-65
priority: high
type: feature
ordinal: 62000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The defense half of APRV-60 (observed live: backlog task edit dropped the approval: key from APRV-51). The log knows which tasks have registered actions; a task file for such a task that now carries no envelope has lost it, whether by a third-party rewrite or a hand edit. Detect at the three read points that already exist: approval register (refuse re-registration of a file whose envelope vanished with a distinct code rather than treating it as a new no-envelope task), the daemon tick (envelope.drift with a distinct payload reason, envelope-missing, so it is not confused with a state mismatch), and approval doctor (a check listing tasks with log history whose files lack an envelope). Never silently repaired: the writer could re-emit the envelope from the log, but that turns a projection into a source, so restoration is a human verb at most (design a restore verb only if the human asks; report by default).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 register refuses, with a distinct machine-readable code, a file whose task has registered actions in the log but no envelope
- [x] #2 Daemon appends envelope.drift with reason envelope-missing for such files, once, re-derived per tick
- [x] #3 doctor lists tasks whose log history implies an envelope their file lacks
- [x] #4 Reproduction of the loss with the pinned Backlog.md CLI is a test fixture
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, isolated worktree from main, parallel with 62; file boundary: owns register refusal path, doctor check, daemon reason variant; daemon.ts edit minimal and coordinated with 62 (62 owns write-back; 63 owns the envelope-missing drift reason). 2. Detection: log-derived set of tasks with task.registered actions; a task file for such a task with no approval: key is envelope-missing. 3. register refuses with distinct code; daemon appends envelope.drift with payload.reason envelope-missing once per (task, envelope-absent) re-derived per tick; doctor lists such tasks. 4. Fixture: the APRV-65 envelope-edit-after corpus file as the reproduction. Never repairs. PR, auto-merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR #25, merged after fable resolved the daemon.ts import overlap with APRV-62. Definition: log history = task.registered in the verified log; lost envelope = file has no top-level approval: (or no frontmatter at all; distinguished as missing: no-approval-key | no-frontmatter). register refuses with new distinct code envelope-missing (falls through refusalExitCode default to EXIT_INTEGRITY 1; message names registered seq, action count, and that re-registering would silently narrow the record). Daemon drift scan appends envelope.drift with payload.reason envelope-missing (+ missing, registered_seq; declared_state null; envelope_sha256 absent), deduped by widening driftAlreadyLogged key with reason (absent reason reads as state-mismatch for back-compat). Doctor check 9 envelope-integrity with --tasks flag defaulting to the daemon task dir; pinned check list extended 8->9. Fixture is the real reproduction: envelope-edit-BEFORE registered through the real path, AFTER bytes swapped in. File-name id hint (task-3 -> TASK-3, case-insensitive) used only to ask the log a question; every record is written under the log id; duplicated in gate/daemon/doctor because core must not import daemon. Never repairs; docs/dogfood-cutover.md gains "If an envelope goes missing". No schema change (drift payload is open); no SPEC change (6.3 already covers drift). Reviewer-weigh: a hand restoration in agreement with the log leaves no record, so a second loss at the same derived state reads as the same episode (documented; recording restorations would need an unspecified event, a spec decision). Optional reason on the DaemonEvent drift line, set only for envelope-missing. 1184 tests on its base; 1222 composed with 62.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Envelope loss is detected at all three read points (register refuses envelope-missing, daemon drift-tags with reason envelope-missing once per episode, doctor lists) from log-derived history, never from the file, and never repaired automatically. Reproduction fixture is the real Backlog.md 1.49.3 rewrite. Merged as PR #25.
<!-- SECTION:FINAL_SUMMARY:END -->
