---
id: APRV-148
title: >-
  Daemon envelope scan refuses pre-121 envelopes: historical read mode stops at
  verify.ts
status: Done
assignee:
  - '@fable'
created_date: '2026-08-27 00:01'
updated_date: '2026-08-29 04:23'
labels:
  - bug
  - dogfood
  - daemon
dependencies: []
priority: high
ordinal: 133000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found 2026-08-27, first daemon restart on post-#131 code: every envelope scan reports envelope-invalid for backlog/tasks/aprv-51 (the M5 dogfood proof, state executed), whose envelope carries the pre-APRV-121 numeric est_cost_usd: 0. APRV-121 widened the read boundary via WIDENED_DEFS (.usd_amount_historical) with verify.ts as deliberately the only caller, so the daemon (and any other read-only envelope scan) still validates task-file envelopes against the strict write-boundary schema. Consequence beyond noise: a file that fails validation gets no drift comparison at all ("a malformed envelope makes no claim the log could contradict"), so envelope-loss and drift detection are silently off for exactly the historical artifacts the compatibility rule (APRV-121 AC #2) says must keep validating. Editing aprv-51 is the rejected fix: the file IS the M5 proof artifact, and rewriting it would at best trade the refusal for an envelope.drift record. The register path stays strict: a NEW envelope with numeric money is refused at the write boundary exactly as today.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Read-only envelope validation paths (daemon scan, drift detection, envelope-loss detection, and any other scan that never registers) accept the historical monetary forms via the same pinned substitution verify.ts uses, not a second widening
- [x] #2 approval register and every write-boundary envelope validation still refuse numeric monetary fields, with a test proving the daemon-accepted historical envelope is refused at register
- [x] #3 A daemon tick over the committed backlog/ with aprv-51 present reports no envelope-invalid, and drift detection demonstrably runs over that envelope (test)
- [x] #4 npm test and lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/daemon/daemon.ts checkOneFile: the envelope scan validates with mode historical (same pinned WIDENED_DEFS swap as verify.ts; envelope.schema.json already carries usd_amount_historical). 2. src/core/validate.ts doc: the sentence naming verify.ts as the only historical caller now names the daemon scan too. 3. Register (gate.ts:860) and task-file edit validation (task-file.ts:443) stay strict: both write an envelope claim; ambiguity resolves stricter, and no pre-121 envelope is in flight. 4. Tests in tests/daemon.test.ts: a task file with a numeric est_cost_usd envelope produces no envelope-invalid warning AND drift detection demonstrably runs over it (declared state contradicting the log appends envelope.drift); register of the same envelope still refuses. 5. npm test + lint; PR by branch aprv-148-envelope-historical.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built on branch aprv-148-envelope-historical (from main 73ac778), commit 7c8a3fb, PR #133 (queued to merge, CI green: full gate node 20+22, ci, classify tier). Divergence from plan step 3, called out per CLAUDE.md: task-file.ts did NOT stay fully strict. The daemon repair path (writeBack) rewrites a historical file it did not author; with rewriteInner validating strict, repair silently continue-d and a drifted pre-121 file could never be repaired (caught by the new test: drift appended but file unchanged). Resolution: set-state rewrites validate historical (they preserve fields they did not author), set-envelope authors the whole claim and stays strict, register (gate.ts) untouched and strict. Three strict call sites total were moved to the read boundary: daemon.ts checkOneFile scan, daemon.ts writeBack repair, task-file.ts set-state; all reuse the pinned WIDENED_DEFS substitution, no second widening. validate.ts doc now pins the full caller list. Evidence per AC: AC1+AC3 tests (pre-121 envelope contradicting log gets envelope.drift + byte-preserving repair + zero envelope-invalid warnings; agreeing envelope appends nothing); AC2 test (register refuses the same numeric envelope: envelope-invalid / must be string); AC4 npm test 2298/2298 pass exit 0, lint clean. Global invariants touched: enforcement paths read only verified records is unaffected (validation mode changes what a read accepts as well-formed, never what the log proves); write boundary unchanged for authors.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Daemon envelope scan, daemon write-back repair, and set-state task-file rewrites now validate envelopes at the read boundary (mode historical, same pinned WIDENED_DEFS swap as verify.ts); register and set-envelope stay strict. Verified with three new daemon tests plus full suite 2298/2298 and lint clean; shipped as PR #133 from commit 7c8a3fb.
<!-- SECTION:FINAL_SUMMARY:END -->
