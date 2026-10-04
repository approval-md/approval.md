---
id: APRV-452
title: >-
  Design: a continuity record that links a retired log head to a new genesis
  after a store recreate
status: Done
assignee:
  - '@opus-lane-c11'
created_date: '2026-10-03 03:49'
updated_date: '2026-10-03 22:07'
labels:
  - design
  - log
  - hosting
dependencies: []
references:
  - private/agentvillage-integration/06-gap-register.md
priority: medium
ordinal: 340000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A Railway sandbox recreate forks the disk but not the processes; the Agent Village control plane (agentvillage-controlplane PR 58) moves the forked store aside, starts the daemon on a fresh store (a new genesis), rotates the tokens and exports the old box's chain before destroying it. Core has no record that links the old head to the new genesis: the first record of the new log has prev null and nothing states that another chain preceded it. The AV follower models this as a chain epoch on its side and quarantines until a manual reset today. Design the core record: a first-record field or a dedicated event carrying the retired chain's last seq and hash and the export's digest, written by the process that starts the new store, verifiable by a reader holding both logs, never an input to a verdict, and compatible with log.checkpoint and anchoring. Design note under design/, SPEC hunk proposed, no code in this task. Context: private/agentvillage-integration/06-gap-register.md G11; data runbook Approval follower, Note for DATA-233.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 design/chain-continuity.md states the record shape, who writes it, what a verifier checks when it holds both logs and when it holds only the new one, and how anchoring and log.checkpoint treat it
- [x] #2 SPEC section 8 and section 9 hunks proposed as pending sign-off, not applied
- [x] #3 The note names what the agentvillage-data follower would read to close its epoch automatically
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read SPEC 8 (chain, genesis, verified subscription, event types, log.checkpoint), 9 (anchoring, checkpoints), 10.4 token rules, 11.1; read core/log.ts GENESIS_PREV, core/verify.ts walk and failure reasons, core/log-subscribe.ts cursor-mismatch, serve/follow.ts, cli/log-anchor.ts, core/checkpoint.ts, log export help.
2. Settle: record shape and placement (first record of the new chain, optional sealing record on the retired chain), writer and actor, which fields are computed versus claimed, retired-chain identity by genesis hash.
3. Define verifier outcomes with both logs, with an export only, and with only the new chain; anchoring and checkpoint treatment; what must not cross the boundary (grants, tokens, budgets, obligations, idempotency); fork detection.
4. Name what an external follower reads to close its epoch automatically.
5. Write design/chain-continuity.md with alternatives, recommendation, SPEC 8 and 9 hunks and schema hunks proposed-not-applied, vectors and open questions. No code, SPEC or schema edits.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Wrote design/chain-continuity.md. Decision: a dedicated log.continued event, schema-pinned to seq 1 with prev null, human actor, written through a human-only verb (classifies policy.core like log checkpoint) on an empty log only; every chain fact (retired genesis_hash, last seq and hash, prefix_sha256 over the retired bytes through that head, sealed, open counts) is computed by the runtime from a retired copy it verified, with basis: claimed as the explicit weaker form when no copy survives. Optional log.retired seals the old chain when writable. Verification: a third check beside --anchor and --checkpoints with its own union (continuity-genesis-mismatch, -head-mismatch, -retired-beyond-head; verb refusal continuity-log-not-empty); without the retired copy it reports a claim, never a pass; follower cursors, anchored copies and retired-chain checkpoints refute a truncating claim. Anchoring treats a committed copy of the retired chain as such (anchor-continued) instead of reporting the recreate as anchor-diverged; checkpoints are unchanged because a new-chain checkpoint covers seq 1 by hash. Nothing crosses: requests, grants and tokens (old token refuses not-granted), windows and streaks; budgets and idempotency keys not carried is recorded as a cost; open obligations are counted and reported unhealthy. Follower procedure for closing an epoch automatically is in section 7. Invariants: 4 (record never an input to a verdict) and 6 (new union, to be pinned) touched in the proposal only. No code, SPEC, schema or conformance edits.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Design note design/chain-continuity.md: record shape, writer and attestation, verifier behaviour with both logs, an export only, or only the new log, anchoring and checkpoint treatment, what must not cross the boundary, the follower's epoch-closing procedure, alternatives, proposed SPEC 8, 9 and 11.2 and event-schema hunks pending sign-off, vectors and open questions. Verified by section review against AC 1-3; docs only, no tests run.
<!-- SECTION:FINAL_SUMMARY:END -->
