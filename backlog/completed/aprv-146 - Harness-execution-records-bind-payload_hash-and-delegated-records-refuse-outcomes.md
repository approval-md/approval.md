---
id: APRV-146
title: >-
  Harness execution records bind payload_hash, and delegated records refuse
  outcomes
status: Done
assignee:
  - '@fable-wave1'
created_date: '2026-08-26 19:21'
updated_date: '2026-08-29 20:04'
labels:
  - security
  - gate
  - hook
dependencies: []
priority: medium
ordinal: 131000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Born 2026-08-26 from the APRV-140/120 builder's out-of-scope observations, both on the harness execution path. (1) startHarnessExecution and consumeHarnessGrant record payload_hash only when the caller supplies one; APRV-140's binding requirement (every execution.started carries the hash of what actually runs) does not reach the hook path. The hook already computes payloadHash({command, cwd}) so the data exists; the fix is to require it at the write boundary and refuse its absence, mirroring APRV-140's fail-closed reading. (2) resolveExecution and finishExecution will still close a delegated (execution:'harness') start, which by design never gains an outcome from this runtime; the strictly consistent reading is a refusal pointing at the record's terminal-by-design custody. Touches §11.1 invariants 1, 5, 6; implementation notes must say so.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 startHarnessExecution and consumeHarnessGrant refuse a missing payload_hash; the hook passes the hash it already computes; tests pin the refusal and the recorded hash
- [x] #2 resolveExecution and finishExecution refuse over a delegated record with a distinct machine-readable code, pinned
- [x] #3 npm test passes; lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
1. Lineage. Drafted under a closed gate on 51e21ec, re-applied on 13b86e2 in lane worktree wf_57158fdc-034-1, finished by this lane. The finishing lane was isolated to a different worktree, so the re-applied edits were carried into it verbatim (only tests/dogfood.test.ts differs between 13b86e2 and the e31ffff base, and it is untouched here) and committed as one commit on branch worktree-wf_49a904c5-d90-1, not on aprv-146-harness-binding. The identical uncommitted edits still sit in wf_57158fdc-034-1; whichever copy lands, the content is the same.

2. The binding. startHarnessExecution requires input.payload_hash and refuses payload-hash-required when it is absent or malformed, checked after the free checks and before the budget evaluation because a budget refusal writes and this one must leave the log untouched. consumeHarnessGrant gained ConsumeHarnessOptions.presentedPayloadHash and refuses twice over: payload-hash-required when the grant request recorded no binding or the consumer states none, payload-mismatch when the stated bytes are not the approved ones. The hash is never read back out of the log to satisfy the check; the process about to run the command states it independently. Both appended execution.started payloads now carry payload_hash unconditionally. src/cli/hook.ts already computed payloadHash over command and cwd for the carryover match, so consumeGrants takes that same hash as a parameter and recordUnattended passes it to the start.

3. Delegated custody. The refusal lives in openExecution, the one function finishExecution, resolveExecution and indeterminateExecution share, so the three verbs cannot drift about it. A start carrying payload.execution harness is refused execution-delegated, checked before the already-finished branch because the fact is about that record custody rather than about what else the log holds. The code is new in EXECUTE_REFUSAL_CODES and sits between actor-not-human and execution-indeterminate; the message names the seq and says why, including that an execution.completed written there would clear the task loop-escalation streak under SPEC 10.2 on the strength of an exit code nobody watched. executionCustody has reported these as delegated since APRV-120, so this is the enforcement half of a custody state the projections already draw.

4. Conformance and invariants. A new member of a closed refusal union is a breaking expectation, so scripts/regen-conformance-vectors.mjs pins the refusal-unions suite at vectors_version 2.0.0, the regenerated vector carries execution-delegated in definition order, conformance/conformance-manifest.json carries the new digest, and conformance/README.md records why the bump is 2.0.0 rather than 1.1.0. SPEC 11.1 global invariants touched: 1 (enforcement reads only verified records, unchanged, the new checks read the same derivation), 3 (no raw secrets, unchanged), 5 (every check-then-append passes through compare-and-append, preserved because both new refusals return before the append and the expectedHead reasoning is unchanged), 6 (refusals are machine-readable and distinct, extended by execution-delegated). No SPEC amendment was needed: the required binding is amended SPEC 6.2 and 10.4 as they already stand, and this closes the harness path to them. No new dependencies.

5. Verification. npm run conformance 221 of 221 vectors passed with 101 controls and an ok manifest. npm run lint clean. npm test on the full matrix is 2309 tests with 2308 passing; the single failure varies run to run among network-dependent Telegram setup and hook-timeout tests (a poll-timing flake and a real sendMessage fetch failure in a sandbox with no network) and none of them touch the gate or execute paths. The four affected files run green in isolation: node --test over gate, execute, evidence-append and cli-hook is 179 of 179 passing.

Merged: PR #145 as main 94f7763 through the merge queue. Salvage lineage: drafted under a closed gate (wave 1, base 51e21ec), re-applied semantically on 13b86e2 (wave 1c), landed from the wave-1c commit after serial re-verification. AC evidence: AC1 tests pin payload-hash-required from startHarnessExecution with nothing appended, the recorded payload_hash on the appended start, and the hook forwarding the hash it computes over command+cwd (consumeGrants now presents it at both call sites); AC2 tests pin execution-delegated from both finishExecution and resolveExecution over a start carrying execution: harness, with refusal.seq and nothing appended, plus the delegated custody state and empty danglingExecutions re-asserted; AC3 the lane run was 2308/2309 under six-way parallel contention and a SERIAL re-run of the full suite on the commit was clean (fail 0, exit 0), conformance 221/221 with 101 controls after the refusal-unions regen, lint clean. 11.1 invariants touched: 1, 3 (records carry the hash of what ran), 5 (checks made against the head that authorizes the append), 6 (one new pinned code; absence and mismatch stay distinct).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Harness execution records now bind payload_hash at the write boundary (start and spend both refuse its absence; the hook presents the hash it already computes), and delegated records refuse outcomes via the new execution-delegated code, so no outcome this runtime never observed can close a harness start or clear a loop streak. Merged as PR #145 (main 94f7763); verified with the new gate/execute tests, serial full suite fail 0, conformance 221/221, lint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
