---
id: APRV-190
title: Log checkpointing/rotation to bound verified-walk length
status: To Do
assignee: []
created_date: '2026-09-01 03:14'
labels: []
dependencies: []
references:
  - docs/postmortem-2026-08-31-hook-cpu.md
priority: medium
type: enhancement
ordinal: 165000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The cold verified read is O(log length): the chain walk starts at genesis every time a fresh process (a hook) reads with an empty cache. APRV-186 cut the per-record constant ~1300x (~0.02ms/record), but the shape is unchanged, so a long-lived repo's log makes every cold walk, and the aggregate O(N^2) amplification across N tool calls, grow without bound. Introduce a verified checkpoint the walk can resume from (a signed/anchored point certifying 'records 1..k verify to this head'), so the cold path verifies only the tail beyond the last checkpoint instead of all of history, plus a rotation/retention story for the on-disk log. Hard constraints from CLAUDE.md/SPEC: the log is append-only and its committed writer is the daemon; nothing may mutate or reorder events.jsonl; projections rebuild and never write back; a checkpoint must be verifiable evidence, not a trust shortcut, and enforcement paths must still read only verified records (SPEC §11). This is a design spike first: propose the checkpoint format and where it is anchored (relation to the existing hash chain, attest, and the head anchor) before building. Configurable retention/rotation policy in the approval.md convention. Structural companion to APRV-188 (daemon warm reads remove the per-process walk when the daemon is up; checkpointing bounds the cold fallback and long-term growth). Security-relevant: it removes the log-growth lever a rogue/runaway agent uses to inflate every future hook's cost.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A design proposal exists for a verified checkpoint format and its anchoring, reviewed against the append-only / single-writer / read-only-verified invariants (SPEC amendment if it touches the log model)
- [ ] #2 A cold verified read resumes from the latest checkpoint and verifies only the tail; the resulting head/verdict is identical to a full genesis walk (equivalence test, as APRV-20 did for the read cache)
- [ ] #3 Configurable rotation/retention is honored and documented; rotation never mutates or reorders committed history and projections still rebuild
- [ ] #4 Tampering anywhere before a checkpoint is still detected (a checkpoint accelerates, it never excuses verification); fail closed on a missing/invalid checkpoint by falling back to a full walk
- [ ] #5 SPEC §11 global invariants hold; implementation notes call out the enforcement read path was touched; npm test passes; lint clean
<!-- AC:END -->
