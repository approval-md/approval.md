---
id: APRV-41
title: 'Payload retention pruning: daemon-only, evidence-preserving'
status: To Do
assignee: []
created_date: '2026-08-05 14:19'
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
- [ ] #1 Pruning runs only inside the daemon loop; no CLI verb deletes store files; terminal-state-plus-duration and orphan rules exactly per ruling 2b, each covered by tests
- [ ] #2 Every pruned file gets its payload.pruned event before deletion (write-ahead: the event lands, then the file goes; a crash between leaves the file, never an unlogged deletion), and log verify stays clean
- [ ] #3 Non-terminal payloads survive every configuration tested, including retention zero-adjacent durations; absent key means no pruning
- [ ] #4 status/doctor payload-store reporting reflects pruned counts honestly
<!-- AC:END -->
