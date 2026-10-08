---
id: APRV-62
title: >-
  Daemon envelope write-back: project state into task files (SPEC 6.3), closing
  the M5 deferral
status: Done
assignee:
  - '@fable'
created_date: '2026-08-17 16:17'
updated_date: '2026-08-17 18:47'
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
- [x] #1 After each state-changing append the daemon rewrites approval.state in the task file via the round-trip writer, atomically, preserving all other bytes
- [x] #2 A file the writer cannot round-trip is left untouched with a distinct daemon warning; a file with no envelope is never given one
- [x] #3 Drift-then-repair sequence tested end to end with a real daemon process; log verify clean
- [x] #4 SPEC 10.2 deferral sentence replaced with the shipped behavior, same commit
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, isolated worktree from main (has 61 writer). 2. Daemon tick: after the closing read, for each task file whose derived state (projection.ts rollup) differs from the file envelope state, rewrite via rewriteTaskFile set-state + writeTaskFileAtomic; skip and warn (distinct code) when the writer refuses; never add an envelope to a file lacking one. 3. Drift-then-repair: envelope.drift is still appended for the contradiction observed; write-back repairs the projection in the same tick, so the next tick sees no drift. Loop-safety: write-back never triggers a watcher-driven re-drift (debounce and compare bytes before writing). 4. SPEC 10.2: replace the deferral sentence with the shipped behavior. 5. Real-daemon tests; verify clean. PR, auto-merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR #24, merged. Write-back call site is after every append the tick can make (drift scan, TTL sweep, sampling, prune) and before the closing read, so an approval.expired appended this tick projects this tick rather than surfacing as drift next tick; it appends nothing itself, so placement cannot affect any record. Per file: re-read verified records once, parse frontmatter, require mapping envelope + non-empty id + envelope schema validity, compare declared vs taskEnvelopeState (reused, never re-derived), rewriteTaskFile set-state, write only when changed and bytes differ (no spurious mtime, no watcher echo), writeTaskFileAtomic. Anything the drift scan already warned about this tick is skipped silently to avoid doubling operator lines. Drift-then-repair documented in the daemon header and SPEC 10.2 (deferral sentence replaced; wording drafted for human review): a drift record marks the moment a file was found wrong and repaired; repeated drift after repair reveals a contending writer. no-envelope files silently skipped (valid Backlog.md tasks per SPEC 6; APRV-63 reports the lost-envelope case). Additive write_back DaemonEvent (task, file, from, to, bytes); additive write-back-refused warning carrying the writer code. Help text lost two prose claims that the daemon never rewrites files. Reviewer-weigh: the refusal test uses a flow-style envelope (schema-valid so drift is recorded, unrewritable so write-back refuses unsupported-shape), because hand-corrupt YAML never reaches write-back; write-back re-reads files the drift scan just read (two reads + two validates per file per tick, chosen for the file boundary; threadable later); mtime equality is the not-rewritten assertion in tests while the byte comparison is the actual guarantee. SPEC DIVERGENCE CALL-OUT: 10.2 amended to the shipped behavior; 6.3 unchanged. 1177 tests on its base.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Daemon projects state into task files after every append via the round-trip writer, atomically and byte-compared; drift-then-repair semantics documented in SPEC 10.2 replacing the M5 deferral; refusals leave files untouched; no-envelope files never touched. Merged as PR #24.
<!-- SECTION:FINAL_SUMMARY:END -->
