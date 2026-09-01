---
id: APRV-186
title: >-
  Verified read burns ~100s CPU per hook process: Ajv is rebuilt per record in
  the chain walk
status: Done
assignee:
  - 'agent:claude-code'
created_date: '2026-09-01 01:32'
updated_date: '2026-09-01 02:19'
labels: []
dependencies: []
priority: high
type: bug
ordinal: 148000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Every gated 'approval hook claude-code' invocation is a fresh process, so the process-lifetime verified-read cache starts empty and the intake/wait path does a cold chain walk of the live log. walk() in src/core/verify.ts calls validate() per record, and validate() rebuilds the world per call: readdir + parse every schema file, new Ajv2020, addFormats, addSchema, compile. Measured on the live 4443-record (2.9MB) log: ~23ms per record, 90-117s of pure CPU for one cold read. Observed 2026-08-31: five concurrent hook processes (one per pending tool call, 9m timeout each) each pinned at ~100% CPU, load average ~68 on an 8-core machine, starving unrelated processes. The poll loop itself is healthy (1s Atomics.wait sleeps; cached re-reads ~9ms); the burn is the cold walk each new hook process pays.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A cold verified read of a ~4.5k-record log completes in low single-digit seconds or less (no per-record Ajv rebuild in the walk)
- [x] #2 Every record is still schema-validated during the walk; verify verdicts, messages, and line numbers are unchanged
- [x] #3 Write-boundary validation semantics unchanged: validate() still fails closed on missing/unparseable/uncompilable schemas
- [x] #4 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a compile-once API to src/core/validate.ts (load + widen + compile a schema once, return a reusable checker; same fail-closed error shape). 2. In walk() (src/core/verify.ts), compile the event validator once per walk and validate each record with it, keeping error rendering identical. 3. Benchmark cold read on a copy of the live log before/after. 4. Run npm test + lint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Root cause: walk() in src/core/verify.ts called validate() per record, and validate() rebuilt everything per call (readdir + parse all schema files, new Ajv2020, addFormats, addSchema, compile) — ~23ms/record, 90-117s CPU for a cold read of the live 4443-record log. Each hook invocation is a fresh process (memory-only read cache starts empty), so every gated tool call paid that walk; five pending tool calls = five pinned cores, the 2026-08-31 load-68 incident.

Fix: added prepareValidator() to src/core/validate.ts (compile once, reusable check(), identical fail-closed error shapes; validate() is now expressed through it, so per-call semantics and results are unchanged). walk() prepares the event validator lazily on the first record and reuses it — lazy so a zero-line walk still never touches the schema dir. Module-header determinism note amended: preparing is still uncached call to call; the prepared validator is an explicit snapshot held by the caller.

Ruled out: the wait loop was never the spinner — it sleeps 1s via Atomics.wait, and cached re-reads of an unchanged log are ~9ms. The VerifiedReadCache is sound for appends (prefix hash re-proof); it only cold-walks for fresh processes and same-size rewrites, as designed. A separately suggested fix (add setTimeout to an fs.promises poll loop) targets a loop that does not exist in this codebase.

Verification: bench on a copy of the live log (2.9MB, 4371 records): cold read 90867/111189/111547/99054/116673 ms before -> 118/91/76/69/68 ms after (~1300x). End-to-end hook repro (real CLI, PreToolUse on stdin, manual-class command, 8s timeout): 5.6% CPU for the whole process lifetime. npm test: 2442/2442 pass. oxlint clean. Global invariants touched: the verification path — every record is still validated against the event schema during the walk (AC2 held by the full suite: verify verdict/message tests unchanged and passing); write-boundary validation unchanged.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Hoisted per-record Ajv rebuilds out of the log chain walk via a compile-once prepareValidator(); cold verified reads dropped from ~100s to ~80ms on the live-size log, hook processes no longer pin a core. Verified by before/after benchmarks, an end-to-end hook CPU repro (5.6% CPU), 2442 passing tests, and clean lint.
<!-- SECTION:FINAL_SUMMARY:END -->
