---
id: APRV-19
title: 'Holistic review: spec conformance, API coherence, security narrative'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 02:21'
updated_date: '2026-08-05 02:23'
labels: []
milestone: m-3.1
dependencies: []
priority: high
type: task
ordinal: 19000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Human-mandated consolidation gate before M4 (2026-08-07). Fable-only: no subagents, read everything, change no code. Five lenses: (a) spec-conformance sweep — every SPEC section checked against shipped behavior, drift listed with direction of fix (code or spec); (b) API surface audit — exit codes, JSON shapes, refusal-code union coherence across all verbs; (c) adversarial re-read of the security path (jcs, log, verify, tokens, gate) as one narrative, hunting seams between components that each passed review alone; (d) test-quality sampling — for ten load-bearing tests, does the assertion pin the contract or the implementation; (e) module and dependency shape ahead of channels. Deliverable: findings report ranked blocker / should-fix / note; blockers and should-fixes proposed as concrete task edits to APRV-20 or new small tasks. No fixing during the review itself.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every SPEC.md section swept against shipped behavior with drift items listing direction of fix (code vs spec)
- [x] #2 API surface audited: full exit-code table, every --json shape, refusal-code unions checked for coherence and collisions across verbs
- [x] #3 Security path re-read adversarially as one narrative with cross-component seams examined and findings recorded
- [x] #4 Ten load-bearing tests sampled with a contract-vs-implementation verdict each
- [x] #5 Module/dependency shape assessed ahead of M4 channels
- [x] #6 Findings report delivered ranked blocker/should-fix/note, with blockers and should-fixes turned into concrete proposed task edits; zero code changes made during the review
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read SPEC.md end to end as currently amended; check each section against shipped behavior (M0-M3 code + CLI), listing drift with direction of fix.
2. Read every src/core module fully (jcs, log, verify, validate, reindex, policy-load, policy-match, policy-explain, budgets, attest, gate, token, loop, execute, frontmatter) and the CLI layer; audit exit codes, JSON shapes, refusal unions for coherence.
3. Adversarial narrative pass over the security path end to end, hunting cross-component seams.
4. Sample ten load-bearing tests; verdict each: contract-pinned vs implementation-pinned.
5. Assess module/dependency shape for M4.
6. Write ranked findings report (blocker/should-fix/note) with concrete proposed task edits; make zero code changes; stop for human review.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Fable-only review, no subagents, zero code changes. Full findings report delivered in chat 2026-08-07. Summary: 1 blocker, 5 should-fixes, 7 notes. B1: verify-then-append is not atomic — token consumption, duplicate-request, and double-register checks all read the log BEFORE the append lock is taken, so two concurrent processes can each pass verification and both append (double-spend/double-request); the lockfile serializes appends, not read-check-append transactions; proposed fix is compare-and-append (appendEvent gains an expected-head precondition evaluated under the lock). S1: the security path (gate/token/execute) acts on unverified records while reindex — a disposable cache — refuses non-clean logs; add verified reads to gate operations. S2: envelope task-level budget (section 6.2 max_cost_usd, max_latency) is enforced nowhere — grep-confirmed; direction code. S3: two frozen-API test families are partially self-referential (cli verify --json derives expectations from core verify(); explain candidates asserted against resolve() by design) — freeze literal fixtures. S4: gate<->token ES-module cycle, extract shared state derivation. S5: frontmatter.ts replicates policy-load YAML hardening; export one parse helper instead. Notes: core cwd fallback; no-block doubling for unterminated fence; stale lockfile needs manual removal (surface age in status later); unimplemented SPEC verbs (init, instructions) and section 9/M5 features are future milestones, not drift; json_extract satisfies the section 9.2 example query; attest exit-3 and wait overloads previously approved; status omits class-limit headroom (documented). Spec-conformance: only three drift items — the section 10.1 token comment (spec fix, approved, Part B), envelope budget (code fix, S2), and the section 11 not-defended list update (Part B per A1). Test sampling: 10 load-bearing tests, 8 pin contracts, 2 partially pin implementation (the S3 pair). Module shape verdict for M4: core layering is clean, channels should land under src/channels/ per section 14; CLI dispatch will want a table instead of a switch as verbs grow. All blockers/should-fixes written up as ready-to-apply APRV-20 AC additions in the chat report, awaiting human adoption.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Holistic fable-only review of M0-M3: spec sweep (3 drift items, direction assigned), API audit (exit codes and refusal unions coherent; approved overloads confirmed documented), adversarial security narrative (1 blocker: non-atomic verify-then-append enabling concurrent double-spend; plus defense-in-depth and enforcement gaps), test sampling (8/10 contract-pinned), module shape ahead of M4. Zero code changed. Report in chat; fixes proposed as APRV-20 AC additions.
<!-- SECTION:FINAL_SUMMARY:END -->
