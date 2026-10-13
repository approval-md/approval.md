---
id: APRV-41
title: 'Payload retention pruning: daemon-only, evidence-preserving'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 14:19'
updated_date: '2026-08-05 18:59'
labels: []
milestone: m-7
dependencies:
  - APRV-38
  - APRV-39
priority: medium
type: feature
ordinal: 41000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ruling 2b's enforcement half. The daemon (never the CLI, never an agent) prunes payload files whose action reached a terminal state (executed, rejected, expired, revoked) longer ago than the policy's payload_retention duration, appending payload.pruned (system actor, carrying the hash) per pruned file so the evidence of deletion outlives the deletion. Non-terminal payloads are never prunable under any configuration. Orphaned head-moved residue (store files no request ever bound) is prunable by the same mechanism regardless of retention. Absent payload_retention means no pruning ever.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Pruning runs only inside the daemon loop; no CLI verb deletes store files; terminal-state-plus-duration and orphan rules exactly per ruling 2b, each covered by tests
- [x] #2 Every pruned file gets its payload.pruned event before deletion (write-ahead: the event lands, then the file goes; a crash between leaves the file, never an unlogged deletion), and log verify stays clean
- [x] #3 Non-terminal payloads survive every configuration tested, including retention zero-adjacent durations; absent key means no pruning
- [x] #4 status/doctor payload-store reporting reflects pruned counts honestly
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, isolated worktree from main, parallel with 40/42. 2. Daemon-only retention pruning per ruling 2b: terminal-state age > payload_retention prunable; non-terminal never; orphans regardless; absent key = never. 3. Write-ahead: payload.pruned (system actor, hash) lands before unlink; crash between leaves file, never unlogged deletion. 4. status/doctor pruned-count reporting. File boundary: owns pruning module + store reporting; daemon edits confined to a pruning hook. PR, ci green, auto-merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR #8, merged with ci green (fable resolved the daemon.ts import/tick overlap with APRV-42 at merge). Write-ahead absolute: payload.pruned (system actor, hash) before unlink; crash window tested with a REAL failure (store dir made unwritable, append succeeds, unlink fails; next pass unlinks, appends nothing). Terminal time from the log event, never mtime (mtimes are rewritten by copy/checkout/rsync and must not decide when approval evidence disappears). execution.failed not terminal (retries); lazily-expired requests wait for the sweep record so retention runs from a logged moment. ORPHAN SEMANTICS RESOLVED CONSERVATIVELY, FLAGGED FOR HUMAN CONFIRMATION: SPEC 5.2 "prunable regardless of the key" vs AC 3 "absent key = no pruning" — absent key means the subsystem never runs at all; present key means orphans prunable at any age. If the literal 5.2 reading is preferred, 5.2 and one test flip together. Binding scan fails closed toward evidence: any hash-shaped string in a payload marks its hash bound-but-unattributable, permanently unprunable; registered-but-never-requested payloads are never pruned. Daemon: one additive warning code prune-refused; successful prunes emit no DaemonEvent (frozen union untouched; per-prune --json visibility is a possible follow-up). status/doctor gain additive pruned/orphan counts (doctor frozen key set untouched, counts ride detail). Reviewer-weigh: cli imports payloadStoreCensus from daemon/prune.ts (CLI->daemon direction); moving census to core/ is a mechanical follow-up if layering grates.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Daemon-only retention pruning per ruling 2b: write-ahead payload.pruned before every unlink, log-derived terminal time, non-terminal never prunable (zero-adjacent durations tested), orphans only when the key is present (conservative resolution flagged), absent key = subsystem never runs. Merged as PR #8, 1064 tests post-merge.
<!-- SECTION:FINAL_SUMMARY:END -->
