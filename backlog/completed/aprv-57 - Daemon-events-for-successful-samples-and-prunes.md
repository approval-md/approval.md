---
id: APRV-57
title: Daemon events for successful samples and prunes
status: Done
assignee:
  - '@fable'
created_date: '2026-08-17 15:51'
updated_date: '2026-08-19 16:38'
labels: []
dependencies: []
priority: low
type: feature
ordinal: 56000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-40 and APRV-41 deliberately emitted no DaemonEvent on a successful audit.sampled or payload.pruned append, to keep the frozen DaemonEvent union untouched inside their one-hook file boundary. Operators running approval daemon run --json therefore see failures for those subsystems but not successes. Add sampled and pruned event variants to the union additively, pinned by tests, rendered by cli/daemon.ts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 DaemonEvent union gains sampled and pruned variants additively, pinned by a test
- [x] #2 approval daemon run --json emits one line per successful sample and per successful prune
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from main, paired with APRV-58. 2. DaemonEvent union gains sampled and pruned additively (frozen output: add only), carrying key, seq and prune counts. 3. daemon run --json emits one line per successful sample and prune; human render mirrors the existing failure lines. 4. Union pin test lists every variant; hook-driven tests with a temp log. 5. PR by branch, auto-merge; records here.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build (paired with APRV-58), PR by branch aprv-57-58-daemon-events-skew-knob (#84). DaemonEvent gains sampled {action_key, task, seq, subject_seq} and pruned {payload_hash, reason payload_retention|orphaned, action_key, task, seq} additively; no byte count on pruned because the pruner unlinks by hash and never stats the file. Plumbing mirrors the existing failure channels: AuditSweepOptions gains an optional sampled sink beside warn; PruneReport gains pruned records (candidate + seq), the one place the appended seq was previously lost. A prune is reported only when its event landed and its unlink returned; an append whose unlink failed stays a prune-refused warning; a crash-window completion appends nothing so it has no seq. cli/daemon.ts renders both in the existing "recorded at seq N" style. Tests: exhaustive union pin (Record over DaemonEvent event names makes the compiler reject an unlisted variant, plus a literal sorted list), a real daemon run --once --json over a supervised execution asserting exactly one sampled line and none on the next tick and no secret on stdout, and the prune case asserting one pruned line with the seq. docs/cli-reference.md daemon --json sample lines landed in the APRV-58 commit (the hook refused a commit --amend as history rewrite, correctly); that doc still omits write_back from the same list, a pre-existing gap from APRV-62 left alone.

Merged at 3742d54 (PR #84) via auto-merge behind ci.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
DaemonEvent gains sampled and pruned additively; daemon run --json emits one line per successful sample and prune. PR #84 merged at 3742d54; verified by the exhaustive union pin and real daemon --once tests, 1818 tests, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
